/**
 * Method- and IO-level tests for {@link ./housekeeping.ts}: the `check`
 * fan-out, the three gated mutation methods, and their failure paths.
 *
 * These drive the real model methods against throwaway git repositories
 * (`git` must be on PATH) and a fake `bd` shell script passed via `bdBin`, so
 * no tracker or network is touched. The stub context records every resource
 * write, report file, and log line so each test can assert on behaviour
 * rather than on incidental output.
 *
 * Run with the same permissions as CI:
 *   deno test --allow-read --allow-write --allow-run --allow-env --allow-net \
 *     extensions/housekeeping/src/
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { model } from "./housekeeping.ts";

// ---------- harness ---------------------------------------------------------

type Recorded = {
  resources: Array<{ spec: string; instance: string; data: unknown }>;
  files: Array<{ instance: string; text: string }>;
  logs: Array<{ level: string; msg: string }>;
};

function makeCtx(globalArgs: Record<string, unknown>) {
  const rec: Recorded = { resources: [], files: [], logs: [] };
  const logFor = (level: string) => (msg: string) => {
    rec.logs.push({ level, msg });
  };
  const ctx = {
    globalArgs,
    writeResource: (spec: string, instance: string, data: unknown) => {
      rec.resources.push({ spec, instance, data });
      return Promise.resolve({ name: instance });
    },
    createFileWriter: (_spec: string, instance: string) => ({
      writeText: (text: string) => {
        rec.files.push({ instance, text });
        return Promise.resolve({ name: instance });
      },
    }),
    logger: {
      info: logFor("info"),
      warn: logFor("warn"),
      debug: logFor("debug"),
    },
  };
  return { ctx, rec };
}

type Execute = (
  args: unknown,
  ctx: unknown,
) => Promise<{ dataHandles: Array<{ name: string }> }>;

function method(name: keyof typeof model.methods): Execute {
  return model.methods[name].execute as unknown as Execute;
}

function dataOf(rec: Recorded, instance: string): Record<string, unknown> {
  const found = rec.resources.find((r) => r.instance === instance);
  assert(found, `expected resource ${instance} to be written`);
  return found.data as Record<string, unknown>;
}

const decoder = new TextDecoder();

async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args: [
      "-c",
      "user.name=housekeeping-test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${decoder.decode(out.stderr)}`,
    );
  }
  return decoder.decode(out.stdout);
}

async function withTmp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "hk-io-" });
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** A repo with one commit on `main`, at `<root>/repo`. */
async function makeRepo(root: string): Promise<string> {
  const repo = `${root}/repo`;
  await Deno.mkdir(repo);
  await git(repo, "init", "-q", "-b", "main");
  await Deno.writeTextFile(`${repo}/README.md`, "fixture\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "init");
  return repo;
}

/**
 * A fake `bd` that answers the handful of subcommands housekeeping calls.
 * Every invocation is appended to `<root>/bd.log` so tests can assert on
 * exactly which mutations were attempted.
 */
async function fakeBd(
  root: string,
  opts: {
    inProgress?: string;
    unclaimExitCode?: number;
    unclaimStderr?: string;
  } = {},
): Promise<{ bin: string; log: string }> {
  const bin = `${root}/bd`;
  const log = `${root}/bd.log`;
  const inProgress = opts.inProgress ?? "[]";
  const unclaimExit = opts.unclaimExitCode ?? 0;
  const unclaimStderr = opts.unclaimStderr ?? "";
  const script = `#!/bin/sh
echo "$@" >> '${log}'
case "$1" in
  --version) echo "bd version 1.3.1" ;;
  list) printf '%s' '${inProgress}' ;;
  stale) echo "[]" ;;
  orphans) echo "null" ;;
  doctor) echo "{}" ;;
  unclaim)
    if [ ${unclaimExit} -ne 0 ]; then
      echo '${unclaimStderr}' >&2
      exit ${unclaimExit}
    fi
    echo "unclaimed $2" ;;
esac
exit 0
`;
  await Deno.writeTextFile(bin, script);
  await Deno.chmod(bin, 0o755);
  return { bin, log };
}

/** Mark the repo as a beads workspace whose binary version matches. */
async function markBeads(repo: string): Promise<void> {
  await Deno.mkdir(`${repo}/.beads`);
  await Deno.writeTextFile(`${repo}/.beads/.local_version`, "1.3.1\n");
}

const LONG_AGO = "2020-01-01T00:00:00Z";
const expiredClaim = JSON.stringify([{
  id: "myswamp-stale",
  title: "abandoned work",
  status: "in_progress",
  assignee: "pi-dead",
  started_at: LONG_AGO,
  updated_at: LONG_AGO,
  lease_expires_at: LONG_AGO,
}]);

// ---------- check -----------------------------------------------------------

Deno.test("check writes audit, git, worktrees and report, logging entry first", async () => {
  await withTmp(async (root) => {
    const repo = await makeRepo(root);
    const { ctx, rec } = makeCtx({
      projectDir: repo,
      includeTemp: false,
      includeBeads: false,
    });

    const result = await method("check")({}, ctx);

    assertEquals(
      rec.resources.map((r) => r.instance).sort(),
      ["audit-current", "git-current", "worktrees-current"],
    );
    assertEquals(rec.files.map((f) => f.instance), ["report-current"]);
    assertStringIncludes(rec.files[0].text, "Housekeeping");
    assertEquals(result.dataHandles.length, 4);

    assertEquals(rec.logs[0].level, "info");
    assertStringIncludes(rec.logs[0].msg, "Housekeeping check starting");
    assert(rec.logs.some((l) => l.msg.startsWith("Housekeeping check:")));

    assertEquals(dataOf(rec, "audit-current").verdict, "healthy");
  });
});

Deno.test("check rejects a directory that is not a git repository", async () => {
  await withTmp(async (root) => {
    const plain = `${root}/plain`;
    await Deno.mkdir(plain);
    const { ctx } = makeCtx({
      projectDir: plain,
      includeTemp: false,
      includeBeads: false,
    });

    await assertRejects(
      () => method("check")({}, ctx),
      Error,
      "not a git repository",
    );
  });
});

Deno.test("check reports a missing bd binary as a warning and still writes beads-current", async () => {
  await withTmp(async (root) => {
    const repo = await makeRepo(root);
    await markBeads(repo);
    const { ctx, rec } = makeCtx({
      projectDir: repo,
      includeTemp: false,
      bdBin: `${root}/no-such-bd`,
    });

    await method("check")({}, ctx);

    const audit = dataOf(rec, "audit-current") as {
      findings: Array<{ severity: string; message: string }>;
    };
    const missing = audit.findings.find((f) =>
      f.message.includes("did not run")
    );
    assert(missing, "expected a did-not-run finding");
    assertEquals(missing.severity, "warning");
    assert(rec.resources.some((r) => r.instance === "beads-current"));
  });
});

Deno.test("check tolerates malformed bd JSON: warns, keeps going, no claims", async () => {
  await withTmp(async (root) => {
    const repo = await makeRepo(root);
    await markBeads(repo);
    const { bin } = await fakeBd(root, { inProgress: "not json{" });
    const { ctx, rec } = makeCtx({
      projectDir: repo,
      includeTemp: false,
      bdBin: bin,
    });

    await method("check")({}, ctx);

    const warn = rec.logs.find((l) =>
      l.level === "warn" && l.msg.includes("bd list --status=in_progress")
    );
    assert(warn, "expected a parse warning for the malformed bd list output");
    const beads = dataOf(rec, "beads-current") as { claims: unknown[] };
    assertEquals(beads.claims, []);
  });
});

Deno.test("check surfaces an expired claim as a stale finding", async () => {
  await withTmp(async (root) => {
    const repo = await makeRepo(root);
    await markBeads(repo);
    const { bin } = await fakeBd(root, { inProgress: expiredClaim });
    const { ctx, rec } = makeCtx({
      projectDir: repo,
      includeTemp: false,
      bdBin: bin,
    });

    await method("check")({}, ctx);

    const beads = dataOf(rec, "beads-current") as {
      staleClaims: Array<{ id: string }>;
    };
    assertEquals(beads.staleClaims.map((c) => c.id), ["myswamp-stale"]);
  });
});

Deno.test("check scans matching sibling clones for branch, dirt, and commits ahead", async () => {
  await withTmp(async (root) => {
    const repo = await makeRepo(root);
    const sibling = `${root}/repo-abc`;
    await git(root, "clone", "-q", repo, sibling);
    await Deno.writeTextFile(`${sibling}/ahead.txt`, "ahead\n");
    await git(sibling, "add", "-A");
    await git(sibling, "commit", "-q", "-m", "ahead");
    await Deno.writeTextFile(`${sibling}/untracked.txt`, "dirty\n");

    const { ctx, rec } = makeCtx({
      projectDir: repo,
      includeTemp: false,
      includeBeads: false,
    });
    await method("check")({}, ctx);

    const worktrees = dataOf(rec, "worktrees-current") as {
      total: number;
      siblings: {
        enabled: boolean;
        root: string;
        pattern: string;
        entries: Array<Record<string, unknown>>;
      };
    };
    assertEquals(worktrees.total, 1);
    assertEquals(worktrees.siblings.enabled, true);
    assertEquals(worktrees.siblings.pattern, "repo-*");
    const entry = worktrees.siblings.entries.find((e) => e.name === "repo-abc");
    assert(entry, "expected the sibling clone to be reported");
    assertEquals(entry.isGitCheckout, true);
    assertEquals(entry.branch, "main");
    assertEquals(entry.dirty, true);
    assertEquals(entry.dirtyFiles, 0);
    assertEquals(entry.untrackedFiles, 1);
    assertEquals(entry.aheadOfBase, 1);
    assertEquals(entry.baseRef, "origin/main");

    const audit = dataOf(rec, "audit-current") as {
      findings: Array<{ category: string; severity: string; message: string }>;
    };
    const finding = audit.findings.find((f) =>
      f.message.includes("Sibling clone 'repo-abc'")
    );
    assert(finding, "expected a sibling-clone finding");
    assertEquals(finding.category, "worktrees");
    assertEquals(finding.severity, "info");
    assertStringIncludes(finding.message, "on 'main'");
    assertStringIncludes(finding.message, "1 commit(s) ahead of origin/main");
    assertStringIncludes(finding.message, "1 untracked file(s)");
  });
});

Deno.test("sibling scan reports a non-git matching directory without failing", async () => {
  await withTmp(async (root) => {
    const repo = await makeRepo(root);
    await Deno.mkdir(`${root}/repo-notes`);
    await Deno.writeTextFile(`${root}/repo-notes/notes.txt`, "not a clone\n");

    const { ctx, rec } = makeCtx({
      projectDir: repo,
      includeTemp: false,
      includeBeads: false,
    });
    await method("check")({}, ctx);

    const worktrees = dataOf(rec, "worktrees-current") as {
      siblings: { entries: Array<Record<string, unknown>> };
    };
    const entry = worktrees.siblings.entries.find((e) =>
      e.name === "repo-notes"
    );
    assert(entry, "expected the matching directory to be reported");
    assertEquals(entry.isGitCheckout, false);
    assertEquals(entry.error, "no .git entry");

    const audit = dataOf(rec, "audit-current") as {
      findings: Array<{ severity: string; message: string }>;
    };
    const finding = audit.findings.find((f) =>
      f.message.includes("is not a git checkout")
    );
    assert(finding, "expected an info finding for the non-git directory");
    assertEquals(finding.severity, "info");
  });
});

Deno.test("sibling scan is an empty result when nothing matches", async () => {
  await withTmp(async (root) => {
    const repo = await makeRepo(root);
    await Deno.mkdir(`${root}/unrelated`);

    const { ctx, rec } = makeCtx({
      projectDir: repo,
      includeTemp: false,
      includeBeads: false,
    });
    await method("check")({}, ctx);

    const worktrees = dataOf(rec, "worktrees-current") as {
      siblings: { enabled: boolean; pattern: string; entries: unknown[] };
    };
    assertEquals(worktrees.siblings.enabled, true);
    assertEquals(worktrees.siblings.pattern, "repo-*");
    assertEquals(worktrees.siblings.entries, []);
  });
});

Deno.test("sibling scan can be disabled", async () => {
  await withTmp(async (root) => {
    const repo = await makeRepo(root);
    await git(root, "clone", "-q", repo, `${root}/repo-abc`);

    const { ctx, rec } = makeCtx({
      projectDir: repo,
      includeTemp: false,
      includeBeads: false,
      includeSiblingClones: false,
    });
    await method("check")({}, ctx);

    const worktrees = dataOf(rec, "worktrees-current") as {
      siblings: { enabled: boolean; entries: unknown[] };
    };
    assertEquals(worktrees.siblings.enabled, false);
    assertEquals(worktrees.siblings.entries, []);
    const audit = dataOf(rec, "audit-current") as {
      findings: Array<{ message: string }>;
    };
    assert(
      !audit.findings.some((f) => f.message.includes("Sibling clone")),
      "disabled scan must not emit sibling findings",
    );
  });
});

// ---------- pruneWorktrees --------------------------------------------------

Deno.test("pruneWorktrees dry-run lists a missing worktree without pruning it", async () => {
  await withTmp(async (root) => {
    const repo = await makeRepo(root);
    const wt = `${root}/wt-gone`;
    await git(repo, "worktree", "add", "-q", "-b", "wt-gone", wt);
    await Deno.remove(wt, { recursive: true });

    const { ctx, rec } = makeCtx({ projectDir: repo });
    await method("pruneWorktrees")({}, ctx);

    const data = dataOf(rec, "worktree-prune-current") as {
      dryRun: boolean;
      candidates: string[];
      pruned: string[];
    };
    assertEquals(data.dryRun, true);
    assertEquals(data.candidates.length, 1);
    assertEquals(data.pruned, []);
    // Dry-run must not touch git's worktree registry.
    assertStringIncludes(
      await git(repo, "worktree", "list", "--porcelain"),
      wt,
    );
    assertStringIncludes(rec.logs[0].msg, "Pruning worktrees");
  });
});

Deno.test("pruneWorktrees with dryRun=false removes the stale registration", async () => {
  await withTmp(async (root) => {
    const repo = await makeRepo(root);
    const wt = `${root}/wt-gone`;
    await git(repo, "worktree", "add", "-q", "-b", "wt-gone", wt);
    await Deno.remove(wt, { recursive: true });

    const { ctx, rec } = makeCtx({ projectDir: repo });
    await method("pruneWorktrees")({ dryRun: false }, ctx);

    const data = dataOf(rec, "worktree-prune-current") as {
      pruned: string[];
      exitCode: number;
    };
    assertEquals(data.pruned.length, 1);
    assertEquals(data.exitCode, 0);
    assert(
      !(await git(repo, "worktree", "list", "--porcelain")).includes(wt),
      "worktree should no longer be registered after prune",
    );
  });
});

// ---------- unclaimStaleBeads ----------------------------------------------

Deno.test("unclaimStaleBeads dry-run reports candidates and never calls bd unclaim", async () => {
  await withTmp(async (root) => {
    const repo = await makeRepo(root);
    await markBeads(repo);
    const { bin, log } = await fakeBd(root, { inProgress: expiredClaim });
    const { ctx, rec } = makeCtx({ projectDir: repo, bdBin: bin });

    await method("unclaimStaleBeads")({}, ctx);

    const data = dataOf(rec, "bead-unclaim-current") as {
      dryRun: boolean;
      candidates: string[];
      released: string[];
    };
    assertEquals(data.dryRun, true);
    assertEquals(data.candidates, ["myswamp-stale"]);
    assertEquals(data.released, []);
    const calls = await Deno.readTextFile(log);
    assert(!calls.includes("unclaim"), "dry-run must not invoke bd unclaim");
  });
});

Deno.test("unclaimStaleBeads releases each candidate with the given reason", async () => {
  await withTmp(async (root) => {
    const repo = await makeRepo(root);
    await markBeads(repo);
    const { bin, log } = await fakeBd(root, { inProgress: expiredClaim });
    const { ctx, rec } = makeCtx({ projectDir: repo, bdBin: bin });

    await method("unclaimStaleBeads")(
      { dryRun: false, reason: "test sweep" },
      ctx,
    );

    const data = dataOf(rec, "bead-unclaim-current") as {
      released: string[];
      failed: unknown[];
    };
    assertEquals(data.released, ["myswamp-stale"]);
    assertEquals(data.failed, []);
    const calls = await Deno.readTextFile(log);
    assertStringIncludes(calls, "unclaim myswamp-stale --reason test sweep");
  });
});

Deno.test("unclaimStaleBeads collects bd failures per item instead of throwing", async () => {
  await withTmp(async (root) => {
    const repo = await makeRepo(root);
    await markBeads(repo);
    const { bin } = await fakeBd(root, {
      inProgress: expiredClaim,
      unclaimExitCode: 1,
      unclaimStderr: "issue already claimed by someone-else",
    });
    const { ctx, rec } = makeCtx({ projectDir: repo, bdBin: bin });

    await method("unclaimStaleBeads")({ dryRun: false }, ctx);

    const data = dataOf(rec, "bead-unclaim-current") as {
      released: string[];
      failed: Array<{ id: string; error: string }>;
    };
    assertEquals(data.released, []);
    assertEquals(data.failed.map((f) => f.id), ["myswamp-stale"]);
    assertStringIncludes(data.failed[0].error, "already claimed");
  });
});

// ---------- cleanTemp -------------------------------------------------------

async function backdate(path: string, days: number): Promise<void> {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  await Deno.utime(path, when, when);
}

Deno.test("cleanTemp dry-run lists old debris and leaves it on disk", async () => {
  await withTmp(async (root) => {
    const repo = await makeRepo(root);
    const tmp = `${root}/tmp`;
    await Deno.mkdir(tmp);
    const old = `${tmp}/scratch.tmp`;
    await Deno.writeTextFile(old, "debris");
    await backdate(old, 3);

    const { ctx, rec } = makeCtx({ projectDir: repo, tempRoots: [tmp] });
    await method("cleanTemp")({}, ctx);

    const data = dataOf(rec, "temp-clean-current") as {
      dryRun: boolean;
      candidates: string[];
      removed: string[];
    };
    assertEquals(data.dryRun, true);
    assertEquals(data.candidates, [old]);
    assertEquals(data.removed, []);
    await Deno.stat(old); // still exists
  });
});

Deno.test("cleanTemp removes an old file, and reports a non-empty dir as failed without force", async () => {
  await withTmp(async (root) => {
    const repo = await makeRepo(root);
    const tmp = `${root}/tmp`;
    await Deno.mkdir(tmp);

    const oldFile = `${tmp}/scratch.tmp`;
    await Deno.writeTextFile(oldFile, "debris");
    await backdate(oldFile, 3);

    const oldDir = `${tmp}/nested.tmp`;
    await Deno.mkdir(oldDir);
    await Deno.writeTextFile(`${oldDir}/inside.txt`, "keep me for now");
    await backdate(oldDir, 3);

    const { ctx, rec } = makeCtx({ projectDir: repo, tempRoots: [tmp] });
    await method("cleanTemp")({ dryRun: false }, ctx);

    const data = dataOf(rec, "temp-clean-current") as {
      removed: string[];
      failed: Array<{ path: string; error: string }>;
    };
    assertEquals(data.removed, [oldFile]);
    assertEquals(data.failed.map((f) => f.path), [oldDir]);
    assert(data.failed[0].error.length > 0, "failure must carry a reason");
    await assertRejects(() => Deno.stat(oldFile), Deno.errors.NotFound);
    await Deno.stat(oldDir); // survived: no force
  });
});

Deno.test("cleanTemp with force removes the non-empty directory too", async () => {
  await withTmp(async (root) => {
    const repo = await makeRepo(root);
    const tmp = `${root}/tmp`;
    await Deno.mkdir(tmp);
    const oldDir = `${tmp}/nested.tmp`;
    await Deno.mkdir(oldDir);
    await Deno.writeTextFile(`${oldDir}/inside.txt`, "x");
    await backdate(oldDir, 3);

    const { ctx, rec } = makeCtx({ projectDir: repo, tempRoots: [tmp] });
    await method("cleanTemp")({ dryRun: false, force: true }, ctx);

    const data = dataOf(rec, "temp-clean-current") as {
      removed: string[];
      failed: unknown[];
    };
    assertEquals(data.removed, [oldDir]);
    assertEquals(data.failed, []);
    await assertRejects(() => Deno.stat(oldDir), Deno.errors.NotFound);
  });
});
