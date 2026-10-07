/**
 * Tests for the @maphew/bd model.
 *
 * Runs the real `bd` CLI against a throwaway project directory, so `bd`
 * must be installed for these tests to pass.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
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

Deno.test("@maphew/bd list flags truncation when over the limit", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    for (let i = 0; i < 3; i++) {
      await runMethod("create", { title: `probe ${i}`, type: "task" }, ctx);
    }

    ctx.written.clear();
    await runMethod("list", { limit: 2 }, ctx);
    const capped = [...ctx.written.values()];
    assertEquals(capped.length, 2);
    // every returned issue reports that the result set was capped
    assert(capped.every((i) => i.truncated === true));

    ctx.written.clear();
    await runMethod("list", { limit: 10 }, ctx);
    const uncapped = [...ctx.written.values()];
    assertEquals(uncapped.length, 3);
    assert(uncapped.every((i) => i.truncated === false));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd query filters by expression", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    await runMethod("create", { title: "query bug probe", type: "bug" }, ctx);
    await runMethod("create", { title: "query task probe", type: "task" }, ctx);

    ctx.written.clear();
    const queried = await runMethod(
      "query",
      { q: "type=bug" },
      ctx,
    );
    const bugs = [...ctx.written.values()];
    assertEquals(queried.dataHandles?.length, 1);
    assertEquals(bugs.length, 1);
    assertEquals(bugs[0].issueType, "bug");
    assertEquals(bugs[0].truncated, false);

    ctx.written.clear();
    await runMethod("query", { q: "type=bug AND priority=2" }, ctx);
    assertEquals([...ctx.written.values()].length, 1);

    ctx.written.clear();
    await runMethod("query", { q: "type=bug AND priority=4" }, ctx);
    assertEquals([...ctx.written.values()].length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd query flags truncation and passes limit", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    for (let i = 0; i < 3; i++) {
      await runMethod("create", { title: `query cap probe ${i}`, type: "task" }, ctx);
    }

    ctx.written.clear();
    await runMethod("query", { q: "type=task", limit: 2 }, ctx);
    const capped = [...ctx.written.values()];
    assertEquals(capped.length, 2);
    assert(capped.every((i) => i.truncated === true));

    ctx.written.clear();
    await runMethod("query", { q: "type=task", limit: 10 }, ctx);
    const uncapped = [...ctx.written.values()];
    assertEquals(uncapped.length, 3);
    assert(uncapped.every((i) => i.truncated === false));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd query excludes closed until includeClosed", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    const created = await runMethod(
      "create",
      { title: "close me", type: "bug" },
      ctx,
    );
    const id = [...ctx.written.values()].at(-1)!.id as string;
    await runMethod("close", { id }, ctx);

    ctx.written.clear();
    await runMethod("query", { q: "type=bug" }, ctx);
    assertEquals([...ctx.written.values()].length, 0);

    ctx.written.clear();
    await runMethod(
      "query",
      { q: "type=bug", includeClosed: true },
      ctx,
    );
    const reopened = [...ctx.written.values()];
    assertEquals(reopened.length, 1);
    assertEquals(reopened[0].id, id);
    assertEquals(reopened[0].status, "closed");
    assert(created.dataHandles !== undefined);

    ctx.written.clear();
    await runMethod(
      "query",
      { q: "type=bug", includeClosed: true, sort: "priority" },
      ctx,
    );
    assertEquals([...ctx.written.values()].length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd query requires an expression", () => {
  assertThrows(
    () => model.methods.query.arguments.parse({}),
  );
});

Deno.test("@maphew/bd query surfaces invalid expressions", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    let caught: unknown;
    try {
      await runMethod("query", { q: "type:bug" }, ctx);
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof Error);
    assertStringIncludes(caught.message, "bd query failed (exit");
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

Deno.test("@maphew/bd dep add/list/remove round-trip", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    await runMethod("create", { title: "dependent issue", type: "bug" }, ctx);
    const aId = [...ctx.written.values()].at(-1)!.id as string;
    await runMethod("create", { title: "prerequisite issue", type: "task" }, ctx);
    const bId = [...ctx.written.values()].at(-1)!.id as string;

    ctx.written.clear();
    const added = await runMethod(
      "dep",
      { action: "add", issueId: aId, dependsOnId: bId },
      ctx,
    );
    assertEquals(added.dataHandles?.length, 2);
    const a = ctx.written.get(`issue-${aId}`)!;
    assertEquals(a.dependencyCount, 1);
    const b = ctx.written.get(`issue-${bId}`)!;
    assertEquals(b.dependentCount, 1);

    ctx.written.clear();
    await runMethod("dep", { action: "list", issueId: aId }, ctx);
    const listedDown = [...ctx.written.values()];
    assertEquals(listedDown.length, 1);
    assertEquals(listedDown[0].id, bId);

    ctx.written.clear();
    await runMethod("dep", { action: "list", issueId: bId, direction: "up" }, ctx);
    const listedUp = [...ctx.written.values()];
    assertEquals(listedUp.length, 1);
    assertEquals(listedUp[0].id, aId);

    ctx.written.clear();
    const removed = await runMethod(
      "dep",
      { action: "remove", issueId: aId, dependsOnId: bId },
      ctx,
    );
    assertEquals(removed.dataHandles?.length, 2);
    const aAfter = ctx.written.get(`issue-${aId}`)!;
    assertEquals(aAfter.dependencyCount, 0);

    ctx.written.clear();
    await runMethod("dep", { action: "list", issueId: aId }, ctx);
    assertEquals([...ctx.written.values()].length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd dep rejects cycles and requires dependsOnId", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    await runMethod("create", { title: "cycle a", type: "task" }, ctx);
    const aId = [...ctx.written.values()].at(-1)!.id as string;
    await runMethod("create", { title: "cycle b", type: "task" }, ctx);
    const bId = [...ctx.written.values()].at(-1)!.id as string;

    assertThrows(
      () =>
        model.methods.dep.arguments.parse({ action: "add", issueId: aId }),
      "dependsOnId",
    );

    await runMethod("dep", { action: "add", issueId: aId, dependsOnId: bId }, ctx);
    let caught: unknown;
    try {
      await runMethod(
        "dep",
        { action: "add", issueId: bId, dependsOnId: aId },
        ctx,
      );
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof Error);
    assertStringIncludes(caught.message, "bd dep add failed (exit");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd reopens closed issues with a reason", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    await runMethod("create", { title: "reopen one", type: "bug" }, ctx);
    const aId = [...ctx.written.values()].at(-1)!.id as string;
    await runMethod("create", { title: "reopen two", type: "task" }, ctx);
    const bId = [...ctx.written.values()].at(-1)!.id as string;
    await runMethod("close", { id: aId }, ctx);
    await runMethod("close", { id: bId }, ctx);

    ctx.written.clear();
    const reopened = await runMethod(
      "reopen",
      { ids: [aId, bId], reason: "regression reappeared" },
      ctx,
    );
    assertEquals(reopened.dataHandles?.length, 2);
    for (const issue of [...ctx.written.values()]) {
      assertEquals(issue.status, "open");
    }

    // reopening an already-open issue is a no-op, not an error
    await runMethod("reopen", { ids: [aId] }, ctx);
    ctx.written.clear();
    await runMethod("show", { id: aId }, ctx);
    assertEquals([...ctx.written.values()][0].status, "open");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd reclaim with no stale leases is a no-op", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    await runMethod("create", { title: "not stale", type: "task" }, ctx);
    const id = [...ctx.written.values()].at(-1)!.id as string;

    const reclaimed = await runMethod("reclaim", { maxAge: "0s" }, ctx);
    assertEquals(reclaimed.dataHandles?.length, 0);

    ctx.written.clear();
    await runMethod("reclaim", { ids: [id] }, ctx);
    assertEquals([...ctx.written.values()].length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd graph returns nodes, typed edges, and layers", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    await runMethod("create", { title: "graph base", type: "task" }, ctx);
    const aId = [...ctx.written.values()].at(-1)!.id as string;
    await runMethod("create", { title: "graph middle", type: "task" }, ctx);
    const bId = [...ctx.written.values()].at(-1)!.id as string;
    await runMethod("create", { title: "graph tip", type: "task" }, ctx);
    const cId = [...ctx.written.values()].at(-1)!.id as string;
    // c depends on b, b depends on a
    await runMethod("dep", { action: "add", issueId: bId, dependsOnId: aId }, ctx);
    await runMethod("dep", { action: "add", issueId: cId, dependsOnId: bId }, ctx);

    ctx.written.clear();
    await runMethod("graph", { rootId: cId }, ctx);
    const graph = ctx.written.get(`dep-graph-${cId}`)!;
    assertEquals(graph.rootId, cId);
    const nodes = graph.nodes as Array<Record<string, unknown>>;
    assertEquals(nodes.length, 3);
    assert(nodes.some((n) => n.id === aId && n.title === "graph base"));
    const edges = graph.edges as Array<Record<string, unknown>>;
    assertEquals(edges.length, 2);
    assert(
      edges.some((e) => e.from === cId && e.to === bId && e.type === "blocks"),
    );
    assert(
      edges.some((e) => e.from === bId && e.to === aId && e.type === "blocks"),
    );
    const layers = graph.layers as string[][];
    assertEquals(layers.length, 3);
    assertEquals(layers[0], [aId]);
    assertEquals(layers[1], [bId]);
    assertEquals(layers[2], [cId]);

    // depth 1 keeps only the tip and its direct prerequisite
    ctx.written.clear();
    await runMethod("graph", { rootId: cId, depth: 1 }, ctx);
    const shallow = ctx.written.get(`dep-graph-${cId}`)!;
    assertEquals((shallow.nodes as unknown[]).length, 2);
    assertEquals((shallow.edges as unknown[]).length, 1);
    const shallowLayers = shallow.layers as string[][];
    assertEquals(shallowLayers.length, 2);
    assertEquals(shallowLayers[0], [bId]);
    assertEquals(shallowLayers[1], [cId]);

    // upstream gathers dependents of the root as well
    ctx.written.clear();
    await runMethod("graph", { rootId: aId, direction: "upstream" }, ctx);
    const up = ctx.written.get(`dep-graph-${aId}`)!;
    assertEquals((up.nodes as unknown[]).length, 3);
    assertEquals((up.edges as unknown[]).length, 2);

    // non-blocks edges (tracks) must not be dropped; create one outside the
    // model, the way a CLI user would. A rooted graph then honors direction:
    // from the tracker only its dependency chain shows, not the tip
    await runMethod("create", { title: "graph tracker", type: "task" }, ctx);
    const dId = [...ctx.written.values()].at(-1)!.id as string;
    const tracksProc = new Deno.Command("bd", {
      args: ["dep", "add", dId, bId, "-t", "tracks"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    const tracksOut = await tracksProc.output();
    assert(tracksOut.success);
    ctx.written.clear();

    await runMethod("graph", { rootId: dId }, ctx);
    const downFromD = ctx.written.get(`dep-graph-${dId}`)!;
    const nodeIds = (downFromD.nodes as Array<Record<string, unknown>>).map(
      (n) => n.id,
    );
    assertEquals(nodeIds.length, 3);
    assert(nodeIds.includes(dId) && nodeIds.includes(bId) && nodeIds.includes(aId));
    assert(!nodeIds.includes(cId));
    const downEdges = downFromD.edges as Array<Record<string, unknown>>;
    assertEquals(downEdges.length, 2);
    assert(
      downEdges.some((e) => e.from === dId && e.to === bId && e.type === "tracks"),
    );
    assert(
      downEdges.some((e) => e.from === bId && e.to === aId && e.type === "blocks"),
    );

    // all-open mode has no root and no layers and carries every typed edge
    ctx.written.clear();
    await runMethod("graph", {}, ctx);
    const all = ctx.written.get("dep-graph-all")!;
    assertEquals(all.rootId, null);
    assertEquals(all.layers, null);
    assert((all.nodes as unknown[]).length >= 4);
    const allEdges = all.edges as Array<Record<string, unknown>>;
    assertEquals(allEdges.length, 3);
    assert(allEdges.some((e) => e.type === "tracks"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd graph upstream requires a rootId", () => {
  assertThrows(
    () => model.methods.graph.arguments.parse({ direction: "upstream" }),
    "requires rootId",
  );
});
