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
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import { isSecretConfigKey, model, normalizeIssue } from "./bd_project.ts";

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

/**
 * `bd` stamps an issue's `owner` from the git `user.email` of the project,
 * falling back to the machine's global git config. A CI runner has no global
 * identity, so without one in the sandbox `owner` comes back null and the
 * round-trip assertions fail on CI while passing on a developer's machine.
 */
export const TEST_GIT_EMAIL = "bd-model-test@example.invalid";

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

  // bd init leaves a git repo behind; give it an identity of its own so the
  // tests do not depend on the machine they run on.
  const git = new Deno.Command("git", {
    args: ["config", "user.email", TEST_GIT_EMAIL],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const gitOut = await git.output();
  if (!gitOut.success) {
    throw new Error(
      `git config failed in test sandbox: ${
        new TextDecoder().decode(gitOut.stderr)
      }`,
    );
  }

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
    assertEquals(shown.owner, TEST_GIT_EMAIL);

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
      await runMethod(
        "create",
        { title: `query cap probe ${i}`, type: "task" },
        ctx,
      );
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
    await runMethod(
      "create",
      { title: "prerequisite issue", type: "task" },
      ctx,
    );
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
    await runMethod(
      "dep",
      { action: "list", issueId: bId, direction: "up" },
      ctx,
    );
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
      () => model.methods.dep.arguments.parse({ action: "add", issueId: aId }),
      "dependsOnId",
    );

    await runMethod(
      "dep",
      { action: "add", issueId: aId, dependsOnId: bId },
      ctx,
    );
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
    await runMethod(
      "dep",
      { action: "add", issueId: bId, dependsOnId: aId },
      ctx,
    );
    await runMethod(
      "dep",
      { action: "add", issueId: cId, dependsOnId: bId },
      ctx,
    );

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
    assert(
      nodeIds.includes(dId) && nodeIds.includes(bId) && nodeIds.includes(aId),
    );
    assert(!nodeIds.includes(cId));
    const downEdges = downFromD.edges as Array<Record<string, unknown>>;
    assertEquals(downEdges.length, 2);
    assert(
      downEdges.some((e) =>
        e.from === dId && e.to === bId && e.type === "tracks"
      ),
    );
    assert(
      downEdges.some((e) =>
        e.from === bId && e.to === aId && e.type === "blocks"
      ),
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

Deno.test("@maphew/bd prime captures the workflow context", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    const result = await runMethod("prime", {}, ctx);
    assertEquals(result.dataHandles?.length, 1);
    const resource = ctx.written.get("prime-current")!;
    assertStringIncludes(String(resource.content), "Beads Workflow Context");
    assertEquals(typeof resource.generatedAt, "string");
    assert(resource.profile === null || typeof resource.profile === "string");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd prime honors memories modes", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    const remember = new Deno.Command("bd", {
      args: ["remember", "prime memory probe"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    assert((await remember.output()).success);

    ctx.written.clear();
    await runMethod("prime", {}, ctx);
    assertStringIncludes(
      String(ctx.written.get("prime-current")!.content),
      "Persistent Memories",
    );

    ctx.written.clear();
    await runMethod("prime", { memories: "exclude" }, ctx);
    assert(
      !String(ctx.written.get("prime-current")!.content).includes(
        "Persistent Memories",
      ),
    );

    ctx.written.clear();
    await runMethod("prime", { memories: "only", maxMemories: 1 }, ctx);
    const only = String(ctx.written.get("prime-current")!.content);
    assertStringIncludes(only, "Persistent Memories");
    assert(!only.includes("Beads Workflow Context"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd prime parses an explicit agent.profile", async () => {
  const dir = await makeProject();
  try {
    await Deno.writeTextFile(
      `${dir}/.beads/PRIME.md`,
      "# Custom Prime\n\n**Policy:** agent.profile=team-maintainer is active.\n",
    );

    // A memory mentioning a different profile must not win over the policy line.
    const remember = new Deno.Command("bd", {
      args: ["remember", "old note: agent.profile=minimal"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    assert((await remember.output()).success);

    const ctx = makeCtx(dir);
    await runMethod("prime", {}, ctx);
    assertEquals(ctx.written.get("prime-current")!.profile, "team-maintainer");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd prime leaves an implicit profile null", async () => {
  const dir = await makeProject();
  try {
    await Deno.writeTextFile(
      `${dir}/.beads/PRIME.md`,
      "# Custom Prime\n\nNo explicit profile is printed here.\n",
    );

    const remember = new Deno.Command("bd", {
      args: ["remember", "old note: agent.profile=minimal"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    assert((await remember.output()).success);

    const ctx = makeCtx(dir);
    await runMethod("prime", {}, ctx);
    assertEquals(ctx.written.get("prime-current")!.profile, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd create dedups on label+title", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    const first = await runMethod("create", {
      title: "CI health: failed runs on maphew/mdo",
      type: "bug",
      priority: 1,
      labels: ["repo-ci-health"],
    }, ctx);
    assertEquals(first.dataHandles?.length, 1);
    const firstId = [...ctx.written.values()].at(-1)!.id as string;

    ctx.written.clear();
    // Same label set + title must not create a second issue; it must return
    // the existing one. This is the idempotency guard the workflow relies on.
    const second = await runMethod("create", {
      title: "CI health: failed runs on maphew/mdo",
      type: "bug",
      priority: 1,
      labels: ["repo-ci-health"],
    }, ctx);
    assertEquals(second.dataHandles?.length, 1);
    assertEquals([...ctx.written.values()][0].id, firstId);

    ctx.written.clear();
    const listed = await runMethod("list", { limit: 10 }, ctx);
    assertEquals(listed.dataHandles?.length, 1);
    assertEquals([...ctx.written.values()][0].labels, ["repo-ci-health"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------- concurrency, lifecycle, and coverage additions ----------------

const BASE_CFG = {
  bdCommand: "bd",
  bdDir: ".",
  defaultPriority: 2,
  defaultType: "task",
};

Deno.test("@maphew/bd normalizeIssue never forges timestamps", () => {
  const issue = normalizeIssue(
    { id: "x-1", title: "no dates", status: "open", priority: 2 },
    BASE_CFG,
    { status: "open", issueType: "task" },
  );
  assertEquals(issue.createdAt, null);
  assertEquals(issue.updatedAt, null);
  assertEquals(issue.assignee, null);
  assertEquals(issue.metadata, {});
});

Deno.test("@maphew/bd actor separates concurrent claims", async () => {
  const dir = await makeProject();
  try {
    const alice = makeCtx(dir);
    alice.globalArgs.actor = "alice";
    const bob = makeCtx(dir);
    bob.globalArgs.actor = "bob";

    await runMethod("create", { title: "claimed once", type: "task" }, alice);
    const created = [...alice.written.values()].at(-1)!;
    const id = created.id as string;
    // --actor stamps created_by, so the workflow's identity is durable.
    assertEquals(created.createdBy, "alice");

    const claimed = await runMethod("update", { id, claim: true }, alice);
    assertEquals(claimed.dataHandles?.length, 1);
    const held = [...alice.written.values()].at(-1)!;
    assertEquals(held.status, "in_progress");
    assertEquals(held.assignee, "alice");
    assert(held.leaseExpiresAt !== null);

    // A second actor must lose the race loudly instead of silently taking it.
    await assertRejects(
      () => runMethod("update", { id, claim: true }, bob),
      Error,
      "laimed",
    );

    bob.written.clear();
    await runMethod("show", { id }, bob);
    assertEquals([...bob.written.values()][0].assignee, "alice");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd update CAS mismatch is a branchable outcome", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    ctx.globalArgs.actor = "alice";
    await runMethod("create", { title: "cas target", type: "task" }, ctx);
    const id = [...ctx.written.values()].at(-1)!.id as string;
    await runMethod("update", { id, claim: true }, ctx);

    ctx.written.clear();
    const mismatch = await runMethod("update", {
      id,
      priority: 0,
      ifAssignee: "bob",
    }, ctx);
    assertEquals(mismatch.dataHandles?.length, 1);
    const outcome = ctx.written.get(`outcome-update-${id}`)!;
    assertEquals(outcome.outcome, "precondition_failed");
    assertEquals(outcome.currentAssignee, "alice");
    assertEquals(outcome.currentStatus, "in_progress");

    ctx.written.clear();
    await runMethod("show", { id }, ctx);
    const unchanged = [...ctx.written.values()][0];
    assertEquals(unchanged.priority, 2);
    assertEquals(unchanged.status, "in_progress");

    ctx.written.clear();
    await runMethod("update", {
      id,
      priority: 0,
      ifStatus: "closed",
    }, ctx);
    assertEquals(
      ctx.written.get(`outcome-update-${id}`)!.outcome,
      "precondition_failed",
    );

    // The matching guard applies normally.
    ctx.written.clear();
    const applied = await runMethod("update", {
      id,
      priority: 0,
      ifAssignee: "alice",
    }, ctx);
    assertEquals(applied.dataHandles?.length, 1);
    assertEquals(ctx.written.get(`issue-${id}`)!.priority, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd unclaim CAS releases only the holder", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    ctx.globalArgs.actor = "alice";
    await runMethod("create", { title: "unclaim target", type: "task" }, ctx);
    const id = [...ctx.written.values()].at(-1)!.id as string;
    await runMethod("update", { id, claim: true }, ctx);

    // bd 1.3.2 exits 1 (not 13) here; the text is the CAS contract.
    ctx.written.clear();
    const mismatch = await runMethod("unclaim", {
      id,
      ifAssignee: "bob",
    }, ctx);
    assertEquals(mismatch.dataHandles?.length, 1);
    assertEquals(
      ctx.written.get(`outcome-unclaim-${id}`)!.outcome,
      "precondition_failed",
    );

    ctx.written.clear();
    await runMethod("show", { id }, ctx);
    assertEquals([...ctx.written.values()][0].status, "in_progress");

    ctx.written.clear();
    const released = await runMethod("unclaim", {
      id,
      ifAssignee: "alice",
      reason: "graceful abort",
    }, ctx);
    assertEquals(released.dataHandles?.length, 1);
    const open = ctx.written.get(`issue-${id}`)!;
    assertEquals(open.status, "open");
    assertEquals(open.assignee, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd heartbeat refreshes the owner's lease only", async () => {
  const dir = await makeProject();
  try {
    const alice = makeCtx(dir);
    alice.globalArgs.actor = "alice";
    const bob = makeCtx(dir);
    bob.globalArgs.actor = "bob";
    await runMethod("create", { title: "lease target", type: "task" }, alice);
    const id = [...alice.written.values()].at(-1)!.id as string;
    await runMethod("update", { id, claim: true }, alice);

    await assertRejects(
      () => runMethod("heartbeat", { ids: [id] }, bob),
      Error,
      "laimed",
    );

    alice.written.clear();
    const beat = await runMethod("heartbeat", { ids: [id] }, alice);
    assertEquals(beat.dataHandles?.length, 1);
    const issue = alice.written.get(`issue-${id}`)!;
    assert(issue.heartbeatAt !== null);
    assert(issue.leaseExpiresAt !== null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd note and comment append without replacing", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    await runMethod("create", { title: "evidence", type: "task" }, ctx);
    const id = [...ctx.written.values()].at(-1)!.id as string;

    await runMethod("note", { id, text: "first note" }, ctx);
    ctx.written.clear();
    await runMethod("note", { id, text: "second note" }, ctx);
    const afterNotes = ctx.written.get(`issue-${id}`)!;
    assertStringIncludes(String(afterNotes.notes), "first note");
    assertStringIncludes(String(afterNotes.notes), "second note");

    await runMethod("comment", { id, text: "a comment" }, ctx);
    const afterComment = ctx.written.get(`issue-${id}`)!;
    assertEquals(afterComment.commentCount, 1);
    assertStringIncludes(String(afterComment.notes), "first note");

    await assertRejects(
      () => runMethod("note", { id }, ctx),
      Error,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd issue resources carry the full bd field set", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    await runMethod("create", { title: "rich", type: "task" }, ctx);
    const id = [...ctx.written.values()].at(-1)!.id as string;

    const update = new Deno.Command("bd", {
      args: [
        "update",
        id,
        "--design",
        "the design",
        "--acceptance",
        "the criteria",
        "--due",
        "+2d",
        "--external-ref",
        "gh-9",
        "--set-metadata",
        "team=platform",
        "--append-notes",
        "seeded",
      ],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    const out = await update.output();
    assert(out.success, new TextDecoder().decode(out.stderr));

    ctx.written.clear();
    await runMethod("show", { id }, ctx);
    const issue = ctx.written.get(`issue-${id}`)!;
    assertEquals(issue.design, "the design");
    assertEquals(issue.acceptanceCriteria, "the criteria");
    assertEquals(issue.externalRef, "gh-9");
    assertEquals(issue.metadata, { team: "platform" });
    assertEquals(issue.notes, "seeded");
    assert(issue.dueAt !== null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd children includes closed children and their parent", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    await runMethod("create", { title: "epic", type: "epic" }, ctx);
    const epicId = [...ctx.written.values()].at(-1)!.id as string;
    await runMethod(
      "create",
      { title: "child open", type: "task", parentId: epicId },
      ctx,
    );
    await runMethod(
      "create",
      { title: "child closed", type: "task", parentId: epicId },
      ctx,
    );
    const closedId = [...ctx.written.values()].at(-1)!.id as string;
    await runMethod("close", { id: closedId }, ctx);

    ctx.written.clear();
    const result = await runMethod("children", { parentId: epicId }, ctx);
    assertEquals(result.dataHandles?.length, 2);
    const children = [...ctx.written.values()];
    assert(children.every((child) => child.parent === epicId));
    assert(children.some((child) => child.status === "closed"));
    assert(children.some((child) => child.status === "open"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd epicStatus reports counts and close eligibility", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    await runMethod("create", { title: "epic done", type: "epic" }, ctx);
    const epicId = [...ctx.written.values()].at(-1)!.id as string;
    for (const title of ["a", "b"]) {
      await runMethod(
        "create",
        { title: `child ${title}`, type: "task", parentId: epicId },
        ctx,
      );
      const childId = [...ctx.written.values()].at(-1)!.id as string;
      await runMethod("close", { id: childId }, ctx);
    }

    ctx.written.clear();
    const result = await runMethod(
      "epicStatus",
      { epicId, eligibleOnly: true },
      ctx,
    );
    assertEquals(result.dataHandles?.length, 1);
    const status = ctx.written.get(`epic-${epicId}`)!;
    assertEquals(status.totalChildren, 2);
    assertEquals(status.closedChildren, 2);
    assertEquals(status.eligibleForClose, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd count totals and groups", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    await runMethod("create", { title: "count open", type: "task" }, ctx);
    await runMethod("create", { title: "count closed", type: "task" }, ctx);
    const closedId = [...ctx.written.values()].at(-1)!.id as string;
    await runMethod("close", { id: closedId }, ctx);

    ctx.written.clear();
    await runMethod("count", { groupBy: "status" }, ctx);
    const grouped = ctx.written.get("count-current")!;
    assertEquals(grouped.count, 2);
    const groups = grouped.groups as Array<{ key: string; count: number }>;
    assert(groups.some((group) => group.key === "open"));
    assert(groups.some((group) => group.key === "closed"));

    ctx.written.clear();
    await runMethod("count", {}, ctx);
    assertEquals(ctx.written.get("count-current")!.count, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd ready honors parent/label filters", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    await runMethod("create", { title: "epic filter", type: "epic" }, ctx);
    const epicId = [...ctx.written.values()].at(-1)!.id as string;
    await runMethod(
      "create",
      { title: "keep", type: "task", parentId: epicId, labels: ["keep"] },
      ctx,
    );
    await runMethod(
      "create",
      { title: "skip", type: "task", parentId: epicId, labels: ["skip"] },
      ctx,
    );

    ctx.written.clear();
    await runMethod("ready", { parent: epicId, limit: 10 }, ctx);
    assertEquals(ctx.written.size, 2);

    ctx.written.clear();
    await runMethod(
      "ready",
      { parent: epicId, excludeLabels: ["skip"], limit: 10 },
      ctx,
    );
    const remaining = [...ctx.written.values()];
    assertEquals(remaining.length, 1);
    assertEquals(remaining[0].title, "keep");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd config reads one key and the effective set", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);

    await runMethod("config", { key: "agent.profile" }, ctx);
    const one = ctx.written.get("config-agent.profile")!;
    const entry = (one.entries as Array<Record<string, unknown>>)[0];
    assertEquals(entry.key, "agent.profile");
    assertEquals(entry.value, "conservative");
    assertEquals(entry.redacted, false);

    ctx.written.clear();
    await runMethod("config", {}, ctx);
    const all = ctx.written.get("config-effective")!;
    const entries = all.entries as Array<Record<string, unknown>>;
    assert(entries.length > 0);
    const profile = entries.find((item) => item.key === "agent.profile")!;
    assertStringIncludes(String(profile.source), "default");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd doctor captures a report without trusting the exit code", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    const result = await runMethod("doctor", {}, ctx);
    assertEquals(result.dataHandles?.length, 1);
    const report = ctx.written.get("doctor-current")!;
    assertEquals(typeof report.supported, "boolean");
    assert(report.raw !== null && typeof report.raw === "object");
    // Embedded mode is what bd init creates; it reports unsupported with exit
    // 0. The resource must say so instead of implying a clean bill of health.
    const raw = report.raw as Record<string, unknown>;
    if (raw.unsupported === true) assertEquals(report.supported, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd unclaim requires exactly one of id or ids", async () => {
  const ctx = makeCtx("/tmp");
  await assertRejects(() => runMethod("unclaim", {}, ctx), Error);
  await assertRejects(
    () => runMethod("unclaim", { id: "x", ids: ["y"] }, ctx),
    Error,
  );
});

Deno.test("@maphew/bd combined update guards blame the guard bd named", async () => {
  const dir = await makeProject();
  try {
    const ctx = makeCtx(dir);
    ctx.globalArgs.actor = "alice";
    await runMethod("create", { title: "both guards", type: "task" }, ctx);
    const id = [...ctx.written.values()].at(-1)!.id as string;
    await runMethod("update", { id, claim: true }, ctx);

    // Assignee guard passes, status guard fails: the outcome must say so.
    ctx.written.clear();
    await runMethod("update", {
      id,
      priority: 0,
      ifAssignee: "alice",
      ifStatus: "closed",
    }, ctx);
    const statusOutcome = ctx.written.get(`outcome-update-${id}`)!;
    assertEquals(statusOutcome.guard, "if-status");
    assertEquals(statusOutcome.expected, "closed");

    // Assignee guard fails first: blame it, not the status guard.
    ctx.written.clear();
    await runMethod("update", {
      id,
      priority: 0,
      ifAssignee: "bob",
      ifStatus: "closed",
    }, ctx);
    const assigneeOutcome = ctx.written.get(`outcome-update-${id}`)!;
    assertEquals(assigneeOutcome.guard, "if-assignee");
    assertEquals(assigneeOutcome.expected, "bob");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd config redacts credentials by default", async () => {
  const dir = await makeProject();
  try {
    const set = new Deno.Command("bd", {
      // bd refuses secret keys in a git-tracked config without this flag; the
      // point of the test is what the model does with a value bd will show.
      args: [
        "config",
        "set",
        "--force-git-tracked",
        "github.token",
        "ghp_do_not_persist",
      ],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    const setOut = await set.output();
    assert(setOut.success, new TextDecoder().decode(setOut.stderr));

    const logged: string[] = [];
    const ctx = makeCtx(dir);
    ctx.logger = {
      info: (msg: string, props?: Record<string, unknown>) => {
        logged.push(`${msg} ${JSON.stringify(props ?? {})}`);
      },
      error: () => {},
    };

    await runMethod("config", { key: "github.token" }, ctx);
    const one = ctx.written.get("config-github.token")!;
    const entry = (one.entries as Array<Record<string, unknown>>)[0];
    assertEquals(entry.redacted, true);
    assertEquals(entry.value, "[redacted]");

    ctx.written.clear();
    await runMethod("config", {}, ctx);
    const all = ctx.written.get("config-effective")!;
    const secret = (all.entries as Array<Record<string, unknown>>).find(
      (item) => item.key === "github.token",
    )!;
    assertEquals(secret.redacted, true);
    assertEquals(secret.value, "[redacted]");

    // The secret must not reach the logs either.
    assert(!logged.join("\n").includes("ghp_do_not_persist"));

    // Explicit opt-in returns the real value.
    ctx.written.clear();
    await runMethod("config", {
      key: "github.token",
      revealSecrets: true,
    }, ctx);
    const revealed = ctx.written.get("config-github.token")!;
    assertEquals(
      (revealed.entries as Array<Record<string, unknown>>)[0].value,
      "ghp_do_not_persist",
    );
    assert(!logged.join("\n").includes("ghp_do_not_persist"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/bd secret config key detection", () => {
  for (
    const key of [
      "github.token",
      "linear.api_key",
      "linear.oauth_client_secret",
      "jira.api_token",
      "ado.pat",
      "ai.api_key",
      "custom.password",
    ]
  ) {
    assert(isSecretConfigKey(key), `${key} should be treated as secret`);
  }
  for (const key of ["agent.profile", "issue_prefix", "export.path"]) {
    assert(!isSecretConfigKey(key), `${key} should not be treated as secret`);
  }
});

Deno.test("@maphew/bd multi-id unclaim mixes released issues and outcomes", async () => {
  const dir = await makeProject();
  try {
    const alice = makeCtx(dir);
    alice.globalArgs.actor = "alice";
    const bob = makeCtx(dir);
    bob.globalArgs.actor = "bob";

    await runMethod("create", { title: "mine", type: "task" }, alice);
    const mine = [...alice.written.values()].at(-1)!.id as string;
    await runMethod("update", { id: mine, claim: true }, alice);

    await runMethod("create", { title: "theirs", type: "task" }, bob);
    const theirs = [...bob.written.values()].at(-1)!.id as string;
    await runMethod("update", { id: theirs, claim: true }, bob);

    alice.written.clear();
    const result = await runMethod("unclaim", {
      ids: [mine, theirs],
      ifAssignee: "alice",
    }, alice);

    // One id released (issue resource), one guard failure (outcome resource).
    assertEquals(result.dataHandles?.length, 2);
    assertEquals(alice.written.get(`issue-${mine}`)!.status, "open");
    assertEquals(
      alice.written.get(`outcome-unclaim-${theirs}`)!.outcome,
      "precondition_failed",
    );

    bob.written.clear();
    await runMethod("show", { id: theirs }, bob);
    assertEquals([...bob.written.values()][0].assignee, "bob");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
