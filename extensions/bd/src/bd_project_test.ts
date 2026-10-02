/**
 * Tests for the @maphew/bd model.
 *
 * Runs the real `bd` CLI against a throwaway project directory, so `bd`
 * must be installed for these tests to pass.
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import { model } from "./bd_project.ts";

type Issue = Record<string, unknown>;

interface TestCtx {
  globalArgs: Record<string, unknown>;
  written: Map<string, Issue>;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
}

function makeCtx(dir: string): TestCtx {
  const written = new Map<string, Issue>();
  return {
    globalArgs: {
      bdCommand: "bd",
      bdDir: dir,
      defaultPriority: 2,
      defaultType: "task",
    },
    written,
    writeResource: async (
      _spec: string,
      instance: string,
      data: unknown,
    ) => {
      written.set(instance, data as Issue);
      return { name: instance };
    },
    logger: {
      info: (_msg: string, _props?: Record<string, unknown>) => {},
      error: (_msg: string, _props?: Record<string, unknown>) => {},
    },
  };
}

async function makeProject(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "bd_model_test_" });
  const proc = new Deno.Command("bd", {
    args: ["init", "--quiet"],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await proc.output();
  if (!out.success) throw new Error("bd init failed in test sandbox");
  return dir;
}

async function runMethod(
  name: string,
  args: Record<string, unknown>,
  ctx: TestCtx,
): Promise<{ dataHandles?: Array<{ name: string }> }> {
  const method = model.methods[name as keyof typeof model.methods];
  if (!method) throw new Error(`unknown method ${name}`);
  return await method.execute(args, ctx as never);
}

Deno.test("@maphew/bd create/show/update/close round-trip", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);

    const created = await runMethod(
      "create",
      { title: "test issue", type: "bug", priority: 1, description: "desc" },
      ctx,
    );
    assertEquals(created.dataHandles?.length, 1);
    const createdIssue = [...ctx.written.values()].at(-1)!;
    assert(createdIssue.id !== "");
    assertEquals(createdIssue.title, "test issue");
    assertEquals(createdIssue.issueType, "bug");
    assertEquals(createdIssue.priority, 1);
    const id = createdIssue.id as string;

    ctx.written.clear();
    await runMethod("show", { id }, ctx);
    const shown = [...ctx.written.values()][0];
    assertEquals(shown.id, id);
    assertEquals(shown.title, "test issue");
    assertEquals(shown.owner !== null, true);

    ctx.written.clear();
    await runMethod(
      "update",
      { id, priority: 3, addLabels: ["tested"] },
      ctx,
    );
    const updated = [...ctx.written.values()][0];
    assertEquals(updated.priority, 3);
    assert(String(updated.updatedAt) !== "");

    ctx.written.clear();
    await runMethod("close", { id, reason: "test done" }, ctx);
    const closed = [...ctx.written.values()][0];
    // close must preserve the issue's real fields, not write a stub
    assertEquals(closed.id, id);
    assertEquals(closed.title, "test issue");
    assertEquals(closed.status, "closed");
    assertEquals(closed.priority, 3);
    assertEquals(closed.issueType, "bug");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd list and ready return issues", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    await runMethod("create", { title: "ready probe", type: "task" }, ctx);

    ctx.written.clear();
    const listed = await runMethod("list", { limit: 10 }, ctx);
    assert((listed.dataHandles?.length ?? 0) >= 1);

    ctx.written.clear();
    const ready = await runMethod("ready", {}, ctx);
    const readyIssues = [...ctx.written.values()];
    assertEquals(ready.dataHandles?.length, readyIssues.length);
    assert(readyIssues.some((i) => i.title === "ready probe"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd update requires a field", () => {
  assertThrows(
    () =>
      model.methods.update.arguments.parse({
        id: "bd-1",
      }),
    "at least one field",
  );
});

Deno.test("@maphew/bd failure surfaces exit code and stderr", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    let caught: unknown;
    try {
      await runMethod("show", { id: "bd-does-not-exist" }, ctx);
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof Error);
    assertStringIncludes(caught.message, "bd show failed (exit 1)");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
