/**
 * Tests for the @maphew/handoff behavior.
 *
 * Pure helpers are exercised directly. The `capture` integration test runs the
 * real `git` CLI against a throwaway repository, so `git` must be installed.
 * Bead metadata is optional by design, so these tests cover the
 * bd-unavailable path; the bd-backed path is covered by the pure
 * `beadRecord` tests.
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
import {
  beadRecord,
  classifyInProgress,
  handoffDataName,
  model,
  parsePorcelain,
  redactRemote,
  renderHandoff,
  resolveDir,
} from "./handoff.ts";

// ---------- pure helper tests ----------------------------------------------

Deno.test("parsePorcelain sorts staged, dirty, untracked, conflicted", () => {
  // " M dirty.txt\0A  staged.txt\0?? new.txt\0UU conflict.txt\0"
  const raw = " M dirty.txt\0A  staged.txt\0?? new.txt\0UU conflict.txt\0";
  const buckets = parsePorcelain(raw);
  assertEquals(buckets.dirty, ["dirty.txt"]);
  assertEquals(buckets.staged, ["staged.txt"]);
  assertEquals(buckets.untracked, ["new.txt"]);
  assertEquals(buckets.conflicted, ["conflict.txt"]);
});

Deno.test("parsePorcelain records rename source and target", () => {
  // Rename/copy v1 -z emits the new path, then the old path as the next field.
  const raw = "R  new-name.txt\0old-name.txt\0";
  const buckets = parsePorcelain(raw);
  assertEquals(buckets.staged, ["new-name.txt", "old-name.txt"]);
});

Deno.test("parsePorcelain handles clean and empty output", () => {
  assertEquals(parsePorcelain(""), {
    staged: [],
    dirty: [],
    untracked: [],
    conflicted: [],
  });
});

Deno.test("redactRemote strips credentials but keeps host and path", () => {
  assertEquals(
    redactRemote("https://user:secret@github.com/org/repo.git"),
    "https://github.com/org/repo.git",
  );
});

Deno.test("redactRemote strips query parameters", () => {
  assertEquals(
    redactRemote("https://example.com/repo.git?token=abc"),
    "https://example.com/repo.git",
  );
});

Deno.test("redactRemote leaves scp-style remotes unchanged", () => {
  assertEquals(
    redactRemote("git@github.com:org/repo.git"),
    "git@github.com:org/repo.git",
  );
});

Deno.test("redactRemote passes null through", () => {
  assertEquals(redactRemote(null), null);
  assertEquals(redactRemote(undefined), null);
});

Deno.test("classifyInProgress reports each interrupted operation", () => {
  assertEquals(
    classifyInProgress({
      merge: true,
      cherryPick: false,
      revert: false,
      rebaseMerge: true,
      rebaseApply: false,
      rebaseApplyIsAm: false,
    }),
    ["merge", "rebase"],
  );
});

Deno.test("classifyInProgress distinguishes am from rebase", () => {
  assertEquals(
    classifyInProgress({
      merge: false,
      cherryPick: false,
      revert: false,
      rebaseMerge: false,
      rebaseApply: true,
      rebaseApplyIsAm: true,
    }),
    ["am"],
  );
  assertEquals(
    classifyInProgress({
      merge: false,
      cherryPick: false,
      revert: false,
      rebaseMerge: false,
      rebaseApply: true,
      rebaseApplyIsAm: false,
    }),
    ["rebase"],
  );
});

Deno.test("classifyInProgress returns nothing for a clean worktree", () => {
  assertEquals(
    classifyInProgress({
      merge: false,
      cherryPick: false,
      revert: false,
      rebaseMerge: false,
      rebaseApply: false,
      rebaseApplyIsAm: false,
    }),
    [],
  );
});

Deno.test("beadRecord selects exact fields and blocking deps", () => {
  const record = beadRecord([
    {
      id: "other",
      title: "not me",
      status: "open",
    },
    {
      id: "myswamp-imx",
      title: "Handoff",
      status: "in_progress",
      assignee: "pi-db8659c3",
      owner: "maphew@gmail.com",
      dependencies: [
        { id: "myswamp-a", dependency_type: "blocks" },
        { id: "myswamp-b", dependency_type: "related" },
      ],
    },
  ], "myswamp-imx");
  assertEquals(record.id, "myswamp-imx");
  assertEquals(record.status, "in_progress");
  assertEquals(record.assignee, "pi-db8659c3");
  assertEquals(record.blockedBy, ["myswamp-a"]);
});

Deno.test("beadRecord throws when the Bead is absent", () => {
  assertThrows(
    () => beadRecord([{ id: "other", status: "open" }], "myswamp-imx"),
    Error,
    "no exact status",
  );
});

Deno.test("beadRecord throws when status is missing", () => {
  assertThrows(
    () => beadRecord({ id: "myswamp-imx" }, "myswamp-imx"),
    Error,
  );
});

Deno.test("handoffDataName sanitizes unsafe characters", () => {
  assertEquals(handoffDataName("myswamp-imx"), "handoff-myswamp-imx");
  assertEquals(handoffDataName("a/b c"), "handoff-a-b-c");
});

Deno.test("resolveDir joins relative paths and passes absolute through", () => {
  assertEquals(resolveDir(".", "/work"), "/work");
  assertEquals(resolveDir("sub", "/work/"), "/work/sub");
  assertEquals(resolveDir("/abs", "/work"), "/abs");
});

Deno.test("renderHandoff surfaces next safe step and forbidden ops", () => {
  const markdown = renderHandoff({
    capturedAt: "2026-10-15T00:00:00Z",
    bead: {
      id: "myswamp-imx",
      title: "Handoff",
      status: "in_progress",
      assignee: "pi-1",
      owner: "matt",
      blockedBy: [],
    },
    git: {
      worktree: "/w",
      repoRoot: "/w",
      gitCommonDir: "/w/.git",
      repositoryIdentity: "git@github.com:org/repo.git",
      remoteOrigin: "git@github.com:org/repo.git",
      branch: "main",
      headSha: "abc123",
      baseRef: "origin/main",
      baseSha: "def456",
      mergeBase: "def456",
      upstreamRef: "origin/main",
      upstreamAhead: 1,
      upstreamBehind: 0,
      staged: [],
      dirty: [],
      untracked: [],
      conflicted: [],
      changedPaths: [],
      inProgressOperations: [],
    },
    goal: "ship it",
    scope: null,
    completed: [],
    excluded: [],
    commands: [],
    evidence: [],
    decisions: [],
    openQuestions: [],
    nextSafe: "git push",
    forbidden: ["force-push"],
    notes: null,
  });
  assertStringIncludes(markdown, "Handoff — myswamp-imx");
  assertStringIncludes(markdown, "## Next safe step");
  assertStringIncludes(markdown, "git push");
  assertStringIncludes(markdown, "## Do not");
  assertStringIncludes(markdown, "force-push");
});

// ---------- integration test ------------------------------------------------

type Written = Map<string, Record<string, unknown>>;

interface TestCtx {
  globalArgs: Record<string, unknown>;
  definition: { name: string };
  written: Written;
  reports: Map<string, string>;
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  readResource: (
    name: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  createFileWriter: (
    spec: string,
    name: string,
  ) => { writeText: (text: string) => Promise<{ name: string }> };
  queryData?: (
    predicate: string,
    select?: string,
  ) => Promise<Array<Record<string, unknown>>>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
}

function makeCtx(dir: string, seed?: Map<string, Record<string, unknown>>): TestCtx {
  const written: Written = seed ?? new Map();
  const reports = new Map<string, string>();
  return {
    globalArgs: {
      repoDir: dir,
      gitCommand: "git",
      bdCommand: "bd",
      bdDir: dir,
    },
    definition: { name: "handoff" },
    written,
    reports,
    writeResource: async (_spec, name, data) => {
      written.set(name, data as Record<string, unknown>);
      return { name };
    },
    readResource: async (name) => written.get(name) ?? null,
    createFileWriter: (_spec, name) => ({
      writeText: async (text: string) => {
        reports.set(name, text);
        return { name };
      },
    }),
    logger: { info: () => {}, warn: () => {} },
  };
}

async function git(dir: string, ...args: string[]): Promise<void> {
  const proc = new Deno.Command("git", {
    args,
    cwd: dir,
    stdout: "null",
    stderr: "null",
  });
  const out = await proc.output();
  if (!out.success) throw new Error(`git ${args.join(" ")} failed`);
}

async function makeRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "handoff_test_" });
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
  // Commit once so HEAD exists (an unborn branch has no resolvable HEAD).
  await Deno.writeTextFile(`${dir}/base.txt`, "base\n");
  await git(dir, "add", "base.txt");
  await git(dir, "commit", "-q", "-m", "base");
  // Leave a staged change for the capture to observe.
  await Deno.writeTextFile(`${dir}/staged.txt`, "one\n");
  await git(dir, "add", "staged.txt");
  return dir;
}

async function runMethod(
  name: string,
  args: Record<string, unknown>,
  ctx: TestCtx,
): Promise<{ dataHandles?: Array<{ name: string }> }> {
  const method = model.methods[name as keyof typeof model.methods];
  if (!method) throw new Error(`unknown method ${name}`);
  return await method.execute(args as never, ctx as never);
}

Deno.test("@maphew/handoff capture records staged files and writes a report", async () => {
  const dir = await makeRepo();
  try {
    const ctx = makeCtx(dir);
    const result = await runMethod("capture", {
      beadId: "myswamp-imx",
      goal: "test the world",
      nextSafe: "deno test",
      forbidden: ["rm -rf /"],
    }, ctx);

    assertEquals(result.dataHandles?.length, 2);
    const handoff = ctx.written.get("handoff-myswamp-imx")!;
    assert(handoff);
    const g = handoff.git as Record<string, unknown>;
    assertEquals(g.staged, ["staged.txt"]);
    assertEquals(g.untracked, []);
    // No .beads/ database, so bd lookup fails and Bead metadata is null.
    assertEquals(handoff.bead, null);
    assertEquals(handoff.goal, "test the world");

    const report = ctx.reports.get("report-handoff-myswamp-imx")!;
    assertStringIncludes(report, "test the world");
    assertStringIncludes(report, "deno test");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/handoff capture reports untracked files", async () => {
  const dir = await makeRepo();
  try {
    await Deno.writeTextFile(`${dir}/new.txt`, "hello\n");
    const ctx = makeCtx(dir);
    await runMethod("capture", { beadId: "myswamp-imx" }, ctx);
    const g = ctx.written.get("handoff-myswamp-imx")!.git as Record<
      string,
      unknown
    >;
    assertEquals(g.untracked, ["new.txt"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/handoff capture keeps unstaged paths whole", async () => {
  // Regression: porcelain ` M path` records start with a status space. Trimming
  // subprocess stdout ate it, misclassifying an unstaged edit as staged and
  // dropping the first path character (extensions/... -> xtensions/...).
  const dir = await makeRepo();
  try {
    await Deno.writeTextFile(`${dir}/base.txt`, "base changed\n");
    const ctx = makeCtx(dir);
    await runMethod("capture", { beadId: "myswamp-imx" }, ctx);
    const g = ctx.written.get("handoff-myswamp-imx")!.git as Record<
      string,
      unknown
    >;
    assertEquals(g.dirty, ["base.txt"]);
    assertEquals(g.staged, ["staged.txt"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/handoff capture rejects an unresolvable base ref", async () => {
  const dir = await makeRepo();
  try {
    const ctx = makeCtx(dir);
    await assertRejects(
      () =>
        runMethod("capture", {
          beadId: "myswamp-imx",
          baseRef: "does-not-exist",
        }, ctx),
      Error,
      "does not resolve to a commit",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/handoff resume reads the stored handoff", async () => {
  const dir = await makeRepo();
  try {
    const ctx = makeCtx(dir);
    await runMethod("capture", {
      beadId: "myswamp-imx",
      nextSafe: "keep going",
      forbidden: ["force-push"],
    }, ctx);

    const result = await runMethod("resume", { beadId: "myswamp-imx" }, ctx);
    assertEquals(result.dataHandles?.length, 2);
    const summary = ctx.written.get("resume-handoff-myswamp-imx")!;
    assertEquals(summary.nextSafe, "keep going");
    const brief = ctx.reports.get("report-resume-handoff-myswamp-imx")!;
    assertStringIncludes(brief, "Resume brief — myswamp-imx");
    assertStringIncludes(brief, "keep going");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("@maphew/handoff resume errors when nothing is on file", async () => {
  const ctx = makeCtx("/tmp");
  await assertRejects(
    () => runMethod("resume", { beadId: "never-captured" }, ctx),
    Error,
    "No handoff on file",
  );
});

Deno.test("@maphew/handoff list catalogues positive-version data only", async () => {
  const dir = await makeRepo();
  const ctx = makeCtx(dir);
  ctx.queryData = async (predicate) => {
    assertStringIncludes(predicate, 'specName == "handoff"');
    return [
      {
        name: "handoff-b",
        version: 1,
        attributes: {
          capturedAt: "2026-10-02T00:00:00Z",
          bead: { id: "b" },
          git: { branch: "main", headSha: "bbb" },
        },
      },
      {
        name: "handoff-a",
        version: 2,
        attributes: {
          capturedAt: "2026-10-01T00:00:00Z",
          bead: { id: "a" },
          git: { branch: "main", headSha: "aaa" },
        },
      },
    ];
  };
  await runMethod("list", { limit: 10 }, ctx);
  const catalog = ctx.written.get("catalog-current")!;
  assertEquals(catalog.count, 2);
  assertEquals(catalog.truncated, false);
  const entries = catalog.entries as Array<Record<string, unknown>>;
  // newest capturedAt sorts first
  assertEquals(entries[0].beadId, "b");
  assertEquals(entries[1].beadId, "a");
});

Deno.test("@maphew/handoff list caps to the limit", async () => {
  const ctx = makeCtx("/tmp");
  ctx.queryData = async () =>
    Array.from({ length: 3 }, (_, i) => ({
      name: `handoff-${i}`,
      version: 1,
      attributes: {
        capturedAt: `2026-10-0${i + 1}T00:00:00Z`,
        bead: { id: `bead-${i}` },
        git: { branch: "main", headSha: `sha-${i}` },
      },
    }));
  await runMethod("list", { limit: 2 }, ctx);
  const catalog = ctx.written.get("catalog-current")!;
  assertEquals(catalog.count, 2);
  assertEquals(catalog.truncated, true);
  assertEquals((catalog.entries as unknown[]).length, 2);
});
