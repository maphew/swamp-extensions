/**
 * Exact-state handoff behavior.
 *
 * Captures a deterministic, secret-free snapshot of a Git worktree plus the
 * authoritative state of the active Bead, and records the human-supplied
 * narrative (goal, scope, decisions, next safe step, forbidden operations) so a
 * successor agent can resume without reading chat history.
 *
 * The mechanical capture used to live in a standalone Python script
 * (`capture_state.py`) that printed JSON to stdout. This behavior makes the
 * same capture durable and queryable: `capture` writes a `handoff` resource and
 * a markdown report file, `resume` re-surfaces the newest brief, and `list`
 * catalogues what is on file.
 *
 * Git and `bd` are subprocess dependencies, exactly as in `@maphew/bd` and
 * `@maphew/session-retro`; there is no cross-behavior `runModel` dependency, so
 * the behavior is portable to any Git checkout and any beads repository.
 *
 * Methods:
 *   - `capture`  snapshot git + bead state and write handoff resource + report
 *   - `resume`   read the newest handoff for a Bead and write a resume brief
 *   - `list`     catalogue stored handoffs for this behavior instance
 *
 * @module
 */

import { z } from "npm:zod@4";

// ---------- schemas ---------------------------------------------------------

/** The authoritative Bead identity and status read from `bd show --json`. */
const BeadSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  assignee: z.string().nullable(),
  owner: z.string().nullable(),
  blockedBy: z.array(z.string()),
});

/** Deterministic Git state for the worktree being handed off. */
const GitStateSchema = z.object({
  worktree: z.string().describe("Absolute path of the worktree root"),
  repoRoot: z.string().describe("Absolute path of the repository root"),
  gitCommonDir: z.string().describe("Absolute path of the shared .git dir"),
  repositoryIdentity: z.string().describe(
    "Redacted origin remote, else the repo root path",
  ),
  remoteOrigin: z.string().nullable().describe(
    "Credential-redacted origin URL",
  ),
  branch: z.string().nullable().describe("Current branch, null when detached"),
  headSha: z.string(),
  baseRef: z.string().nullable(),
  baseSha: z.string().nullable(),
  mergeBase: z.string().nullable(),
  upstreamRef: z.string().nullable(),
  upstreamAhead: z.number().int().nullable(),
  upstreamBehind: z.number().int().nullable(),
  staged: z.array(z.string()),
  dirty: z.array(z.string()),
  untracked: z.array(z.string()),
  conflicted: z.array(z.string()),
  changedPaths: z.array(z.string()),
  inProgressOperations: z.array(z.string()).describe(
    "Interrupted merge/rebase/cherry-pick/revert/am that constrains the next command",
  ),
});

/** One command the outgoing agent ran, with its exact outcome. */
const CommandRecordSchema = z.object({
  command: z.string().describe("Exact command line, verbatim"),
  outcome: z.enum(["succeeded", "failed", "not-run"]),
  detail: z.string().nullable().describe("Output or failure detail, redacted"),
});

/** The full handoff record persisted as the `handoff` resource. */
const HandoffSchema = z.object({
  capturedAt: z.string().describe("ISO-8601 capture timestamp"),
  bead: BeadSchema.nullable().describe(
    "Authoritative Bead state, null when bd could not be read",
  ),
  git: GitStateSchema,
  goal: z.string().nullable(),
  scope: z.string().nullable(),
  completed: z.array(z.string()),
  excluded: z.array(z.string()),
  commands: z.array(CommandRecordSchema),
  evidence: z.array(z.string()),
  decisions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  nextSafe: z.string().nullable(),
  forbidden: z.array(z.string()),
  notes: z.string().nullable(),
});

/** Structured cold-start summary written by `resume`. */
const ResumeSchema = z.object({
  resumedAt: z.string(),
  capturedAt: z.string(),
  beadId: z.string(),
  branch: z.string().nullable(),
  headSha: z.string(),
  nextSafe: z.string().nullable(),
  forbidden: z.array(z.string()),
  dirtyCount: z.number().int(),
  inProgressOperations: z.array(z.string()),
});

/** One row of the stored-handoff catalogue written by `list`. */
const CatalogEntrySchema = z.object({
  dataName: z.string(),
  version: z.number().int(),
  capturedAt: z.string().nullable(),
  beadId: z.string().nullable(),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
});

/** The catalogue written by `list`. */
const CatalogSchema = z.object({
  listedAt: z.string(),
  count: z.number().int(),
  truncated: z.boolean().describe(
    "True when more handoffs exist than the requested limit",
  ),
  entries: z.array(CatalogEntrySchema),
});

// ---------- arguments -------------------------------------------------------

const GlobalArgsSchema = z.object({
  repoDir: z.string().default(".").describe(
    "Worktree to capture. Defaults to the current directory so the behavior is portable across machines and worktrees.",
  ),
  gitCommand: z.string().default("git").describe("Git executable"),
  bdCommand: z.string().default("bd").describe("Beads executable"),
  bdDir: z.string().default(".").describe(
    "Working directory for bd (auto-discovers .beads/)",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CaptureArgsSchema = z.object({
  beadId: z.string().describe("Active Bead identifier, e.g. myswamp-imx"),
  baseRef: z.string().optional().describe(
    "Base ref to diff against, e.g. origin/main. Resolved to a commit SHA and merge-base.",
  ),
  goal: z.string().optional().describe("Accepted goal for this work"),
  scope: z.string().optional().describe("Scope still in play"),
  completed: z.array(z.string()).default([]).describe("Completed scope items"),
  excluded: z.array(z.string()).default([]).describe(
    "Scope explicitly excluded",
  ),
  commands: z.array(CommandRecordSchema).default([]).describe(
    "Commands run and their exact outcomes",
  ),
  evidence: z.array(z.string()).default([]).describe(
    "Locations of test/review evidence",
  ),
  decisions: z.array(z.string()).default([]).describe(
    "Decisions already made",
  ),
  openQuestions: z.array(z.string()).default([]).describe(
    "Open hypotheses, uncertainty, owner decisions outstanding",
  ),
  nextSafe: z.string().optional().describe(
    "The single next safe command or action for the successor",
  ),
  forbidden: z.array(z.string()).default([]).describe(
    "Operations explicitly not to perform",
  ),
  notes: z.string().optional().describe("Any other durable context"),
});

const ResumeArgsSchema = z.object({
  beadId: z.string().describe("Bead whose newest handoff to resume"),
});

const ListArgsSchema = z.object({
  limit: z.number().int().min(1).max(500).default(50).describe(
    "Maximum catalogue entries to return",
  ),
});

// ---------- pure helpers ----------------------------------------------------

type Json = Record<string, unknown>;

/** The four buckets a `git status --porcelain=v1 -z` stream is sorted into. */
export type PorcelainBuckets = {
  staged: string[];
  dirty: string[];
  untracked: string[];
  conflicted: string[];
};

/**
 * Parse `git status --porcelain=v1 --untracked-files=all -z` output.
 *
 * Handles rename/copy status records (whose old path is the next NUL-separated
 * field) and unmerged codes, and returns sorted, de-duplicated path lists.
 */
export function parsePorcelain(raw: string): PorcelainBuckets {
  const entries = raw.split("\0");
  const staged = new Set<string>();
  const dirty = new Set<string>();
  const untracked = new Set<string>();
  const conflicted = new Set<string>();

  let index = 0;
  while (index < entries.length) {
    const entry = entries[index];
    index += 1;
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    let oldPath: string | null = null;
    if (code.includes("R") || code.includes("C")) {
      oldPath = index < entries.length ? entries[index] : null;
      index += 1;
    }
    if (code === "??") {
      untracked.add(path);
      continue;
    }
    if (code.includes("U") || code === "AA" || code === "DD") {
      conflicted.add(path);
      if (oldPath) conflicted.add(oldPath);
      continue;
    }
    if (code[0] !== " ") {
      staged.add(path);
      if (code[0] === "R" && oldPath) staged.add(oldPath);
    }
    if (code[1] !== " ") {
      dirty.add(path);
    }
  }

  return {
    staged: [...staged].sort(),
    dirty: [...dirty].sort(),
    untracked: [...untracked].sort(),
    conflicted: [...conflicted].sort(),
  };
}

/**
 * Remove embedded HTTP credentials and query parameters from a remote URL.
 *
 * SCP-style remotes (`git@host:org/repo.git`) carry no `://` and are returned
 * unchanged. Non-URL values are returned unchanged. The result is safe to
 * persist in behavior data and reports.
 */
export function redactRemote(value: string | null | undefined): string | null {
  if (!value || !value.includes("://")) return value ?? null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
  }
  url.search = "";
  const out = url.toString();
  return url.pathname === "/" ? out.replace(/\/$/, "") : out;
}

/** Boolean flags the Git checks reduce to, so the classifier stays pure. */
export type InProgressFlags = {
  merge: boolean;
  cherryPick: boolean;
  revert: boolean;
  rebaseMerge: boolean;
  rebaseApply: boolean;
  rebaseApplyIsAm: boolean;
};

/** Map the raw Git state flags to the sorted set of interrupted operations. */
export function classifyInProgress(flags: InProgressFlags): string[] {
  const operations = new Set<string>();
  if (flags.merge) operations.add("merge");
  if (flags.cherryPick) operations.add("cherry-pick");
  if (flags.revert) operations.add("revert");
  if (flags.rebaseMerge) operations.add("rebase");
  if (flags.rebaseApply) {
    operations.add(flags.rebaseApplyIsAm ? "am" : "rebase");
  }
  return [...operations].sort();
}

/**
 * Select the exact Bead fields a resumable handoff needs from a `bd show
 * --json` payload. Throws when the requested Bead is absent or has no status,
 * so a stale id is reported rather than silently captured as empty.
 */
export function beadRecord(payload: unknown, beadId: string): Json {
  const records = Array.isArray(payload) ? payload : [payload];
  const match = records.find(
    (item): item is Json =>
      typeof item === "object" && item !== null &&
      (item as Json).id === beadId,
  );
  if (!match || !match.status) {
    throw new Error(`bd show returned no exact status for ${beadId}`);
  }
  const dependencyValues = (match.dependencies ?? match.blocked_by ?? []) as
    | unknown[]
    | undefined;
  const blockedBy = (dependencyValues ?? [])
    .filter((item) => {
      if (typeof item !== "object" || item === null) return true;
      return ((item as Json).dependency_type ?? "blocks") === "blocks";
    })
    .map((item) =>
      typeof item === "object" && item !== null
        ? String((item as Json).id)
        : String(item)
    )
    .sort();
  return {
    id: beadId,
    title: (match.title as string | null) ?? null,
    status: String(match.status),
    assignee: (match.assignee as string | null) ?? null,
    owner: (match.owner as string | null) ?? null,
    blockedBy,
  };
}

/** Wire-safe instance name for a Bead's handoff data. */
export function handoffDataName(beadId: string): string {
  return `handoff-${beadId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** Resolve the repo directory against the process cwd. */
export function resolveDir(repoDir: string, cwd: string): string {
  if (repoDir.startsWith("/")) return repoDir;
  const base = cwd.replace(/\/$/, "");
  const rel = repoDir.replace(/^\.\//, "");
  if (rel === "" || rel === ".") return base;
  return `${base}/${rel}`;
}

/** Render the handoff record as the markdown report the successor reads. */
export function renderHandoff(handoff: z.infer<typeof HandoffSchema>): string {
  const g = handoff.git;
  const lines: string[] = [];
  lines.push(`# Handoff — ${handoff.bead?.id ?? "unknown bead"}`);
  lines.push("");
  lines.push(`- Captured: ${handoff.capturedAt}`);
  if (handoff.bead) {
    lines.push(
      `- Bead: \`${handoff.bead.id}\` — ${
        handoff.bead.title ?? "(untitled)"
      } [${handoff.bead.status}]`,
    );
    if (handoff.bead.assignee) {
      lines.push(`- Assignee: ${handoff.bead.assignee}`);
    }
    if (handoff.bead.blockedBy.length) {
      lines.push(`- Blocked by: ${handoff.bead.blockedBy.join(", ")}`);
    }
  } else {
    lines.push("- Bead: (unavailable — bd lookup failed)");
  }
  lines.push("");

  lines.push("## Repository");
  lines.push("");
  lines.push(`- Worktree: \`${g.worktree}\``);
  lines.push(`- Repo root: \`${g.repoRoot}\``);
  lines.push(`- Identity: \`${g.repositoryIdentity}\``);
  lines.push(
    `- Branch: \`${g.branch ?? "(detached)"}\` @ \`${g.headSha}\``,
  );
  if (g.baseRef) {
    lines.push(
      `- Base: \`${g.baseRef}\` @ \`${g.baseSha ?? "?"}\`, merge-base \`${
        g.mergeBase ?? "?"
      }\``,
    );
  }
  if (g.upstreamRef) {
    lines.push(
      `- Upstream: \`${g.upstreamRef}\` (ahead ${g.upstreamAhead}, behind ${g.upstreamBehind})`,
    );
  }
  if (g.inProgressOperations.length) {
    lines.push(
      `- **In progress:** ${
        g.inProgressOperations.join(", ")
      } — do not start new work`,
    );
  }
  lines.push("");

  lines.push("## Working tree");
  lines.push("");
  lines.push(
    `- Staged: ${g.staged.length}, unstaged: ${g.dirty.length}, untracked: ${g.untracked.length}, conflicted: ${g.conflicted.length}`,
  );
  for (const path of g.changedPaths) lines.push(`  - \`${path}\``);
  lines.push("");

  const section = (title: string, values: string[]) => {
    if (!values.length) return;
    lines.push(`## ${title}`);
    lines.push("");
    for (const value of values) lines.push(`- ${value}`);
    lines.push("");
  };

  if (handoff.goal) {
    lines.push("## Goal");
    lines.push("");
    lines.push(handoff.goal);
    lines.push("");
  }
  if (handoff.scope) {
    lines.push("## Scope");
    lines.push("");
    lines.push(handoff.scope);
    lines.push("");
  }
  section("Completed", handoff.completed);
  section("Excluded", handoff.excluded);

  if (handoff.commands.length) {
    lines.push("## Commands");
    lines.push("");
    for (const c of handoff.commands) {
      lines.push(`- \`${c.command}\` — ${c.outcome}`);
      if (c.detail) lines.push(`  - ${c.detail}`);
    }
    lines.push("");
  }
  section("Evidence", handoff.evidence);
  section("Decisions", handoff.decisions);
  section("Open questions", handoff.openQuestions);

  lines.push("## Next safe step");
  lines.push("");
  lines.push(handoff.nextSafe ?? "(none recorded)");
  lines.push("");
  section("Do not", handoff.forbidden);

  if (handoff.notes) {
    lines.push("## Notes");
    lines.push("");
    lines.push(handoff.notes);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------- subprocess plumbing ---------------------------------------------

type RunResult = { ok: boolean; stdout: string; stderr: string; code: number };

async function run(
  bin: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<RunResult> {
  try {
    // git and bd are the handoff contract; both are validated CLI dependencies
    // documented in the README.
    // swamp-quality-ignore deno-command
    const command = new Deno.Command(bin, {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
      ...(signal ? { signal } : {}),
    });
    const output = await command.output();
    const decode = new TextDecoder();
    // Keep stdout verbatim: `git status --porcelain -z` records begin with a
    // status space that `.trim()` would eat, corrupting the code and path.
    return {
      ok: output.code === 0,
      stdout: decode.decode(output.stdout),
      stderr: decode.decode(output.stderr).trim(),
      code: output.code,
    };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: -1,
    };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------- capture ---------------------------------------------------------

async function git(
  cfg: GlobalArgs,
  args: string[],
  signal: AbortSignal | undefined,
  cwd: string,
  required = true,
): Promise<string | null> {
  const result = await run(cfg.gitCommand, args, cwd, signal);
  if (!result.ok) {
    if (required) {
      throw new Error(
        `git ${args.join(" ")} failed: ${
          result.stderr || result.stdout.trim() || "no output"
        }`,
      );
    }
    return null;
  }
  return result.stdout.trim();
}

async function captureGit(
  cfg: GlobalArgs,
  cwd: string,
  baseRef: string | null,
  signal: AbortSignal | undefined,
): Promise<z.infer<typeof GitStateSchema>> {
  const worktree = await git(
    cfg,
    ["rev-parse", "--show-toplevel"],
    signal,
    cwd,
  );
  if (!worktree) throw new Error("not inside a Git worktree");
  const root = worktree;

  const branch = await git(
    cfg,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    signal,
    root,
    false,
  );
  const headSha = await git(cfg, ["rev-parse", "HEAD"], signal, root);
  if (!headSha) throw new Error("could not resolve HEAD");

  let baseSha: string | null = null;
  let mergeBase: string | null = null;
  if (baseRef) {
    baseSha = await git(
      cfg,
      ["rev-parse", "--verify", `${baseRef}^{commit}`],
      signal,
      root,
      false,
    );
    if (!baseSha) {
      throw new Error(`base ref does not resolve to a commit: ${baseRef}`);
    }
    mergeBase = await git(
      cfg,
      ["merge-base", "HEAD", baseSha],
      signal,
      root,
      false,
    );
  }

  const upstreamRef = await git(
    cfg,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    signal,
    root,
    false,
  );
  let upstreamAhead: number | null = null;
  let upstreamBehind: number | null = null;
  if (upstreamRef) {
    const counts = await git(
      cfg,
      ["rev-list", "--left-right", "--count", `HEAD...${upstreamRef}`],
      signal,
      root,
    );
    if (counts) {
      const [aheadText, behindText] = counts.split(/\s+/);
      upstreamAhead = Number.parseInt(aheadText, 10);
      upstreamBehind = Number.parseInt(behindText, 10);
    }
  }

  const commonValue = await git(
    cfg,
    ["rev-parse", "--git-common-dir"],
    signal,
    root,
  );
  if (!commonValue) throw new Error("could not resolve git common dir");
  const commonDir = commonValue.startsWith("/")
    ? commonValue
    : `${root.replace(/\/$/, "")}/${commonValue.replace(/^\.\//, "")}`;
  const commonName = commonDir.replace(/\/$/, "").split("/").pop();
  const repoRoot = commonName === ".git"
    ? commonDir.replace(/\/\.git$/, "")
    : commonDir;

  const statusRaw = await run(
    cfg.gitCommand,
    ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
    root,
    signal,
  );
  if (!statusRaw.ok) {
    throw new Error(`git status failed: ${statusRaw.stderr}`);
  }
  const buckets = parsePorcelain(statusRaw.stdout);

  const refChecks = await Promise.all(
    (["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"] as const).map(
      async (ref) =>
        (await git(
          cfg,
          ["rev-parse", "--verify", "--quiet", ref],
          signal,
          root,
          false,
        )) !== null,
    ),
  );

  const rebaseMergePath = await git(
    cfg,
    ["rev-parse", "--git-path", "rebase-merge"],
    signal,
    root,
    false,
  );
  const rebaseApplyPath = await git(
    cfg,
    ["rev-parse", "--git-path", "rebase-apply"],
    signal,
    root,
    false,
  );
  const rebaseMerge = rebaseMergePath
    ? await pathExists(
      rebaseMergePath.startsWith("/")
        ? rebaseMergePath
        : `${root.replace(/\/$/, "")}/${rebaseMergePath}`,
    )
    : false;
  const rebaseApply = rebaseApplyPath
    ? await pathExists(
      rebaseApplyPath.startsWith("/")
        ? rebaseApplyPath
        : `${root.replace(/\/$/, "")}/${rebaseApplyPath}`,
    )
    : false;
  const rebaseApplyAbs = rebaseApplyPath
    ? (rebaseApplyPath.startsWith("/")
      ? rebaseApplyPath
      : `${root.replace(/\/$/, "")}/${rebaseApplyPath}`)
    : null;
  const rebaseApplyIsAm = rebaseApplyAbs
    ? await pathExists(`${rebaseApplyAbs.replace(/\/$/, "")}/applying`)
    : false;

  const inProgressOperations = classifyInProgress({
    merge: refChecks[0],
    cherryPick: refChecks[1],
    revert: refChecks[2],
    rebaseMerge,
    rebaseApply,
    rebaseApplyIsAm,
  });

  const remoteOrigin = redactRemote(
    await git(cfg, ["remote", "get-url", "origin"], signal, root, false),
  );

  const changedPaths = [
    ...new Set([
      ...buckets.staged,
      ...buckets.dirty,
      ...buckets.untracked,
      ...buckets.conflicted,
    ]),
  ].sort();

  return {
    worktree: root,
    repoRoot,
    gitCommonDir: commonDir,
    repositoryIdentity: remoteOrigin ?? repoRoot,
    remoteOrigin,
    branch,
    headSha,
    baseRef,
    baseSha,
    mergeBase,
    upstreamRef,
    upstreamAhead,
    upstreamBehind,
    staged: buckets.staged,
    dirty: buckets.dirty,
    untracked: buckets.untracked,
    conflicted: buckets.conflicted,
    changedPaths,
    inProgressOperations,
  };
}

/** Model context fields used by this behavior's methods. */
type Context = {
  globalArgs: GlobalArgs;
  definition: { name: string };
  signal?: AbortSignal;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
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
};

async function readBead(
  cfg: GlobalArgs,
  cwd: string,
  beadId: string,
  signal: AbortSignal | undefined,
): Promise<z.infer<typeof BeadSchema> | null> {
  const bdDir = resolveDir(cfg.bdDir, cwd);
  const result = await run(
    cfg.bdCommand,
    ["show", beadId, "--json"],
    bdDir,
    signal,
  );
  if (!result.ok) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  return beadRecord(payload, beadId) as z.infer<typeof BeadSchema>;
}

async function capture(
  rawArgs: z.infer<typeof CaptureArgsSchema>,
  ctx: Context,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const args = CaptureArgsSchema.parse(rawArgs);
  const cwd = resolveDir(cfg.repoDir, Deno.cwd());
  const signal = ctx.signal;
  const capturedAt = new Date().toISOString();

  ctx.logger.info("Capturing handoff for {bead} in {dir}", {
    bead: args.beadId,
    dir: cwd,
  });

  const gitState = await captureGit(cfg, cwd, args.baseRef ?? null, signal);
  const bead = await readBead(cfg, cwd, args.beadId, signal);
  if (!bead) {
    ctx.logger.warn(
      "bd show {bead} failed; capturing Git state without Bead metadata",
      { bead: args.beadId },
    );
  }

  const handoff: z.infer<typeof HandoffSchema> = {
    capturedAt,
    bead,
    git: gitState,
    goal: args.goal ?? null,
    scope: args.scope ?? null,
    completed: args.completed,
    excluded: args.excluded,
    commands: args.commands,
    evidence: args.evidence,
    decisions: args.decisions,
    openQuestions: args.openQuestions,
    nextSafe: args.nextSafe ?? null,
    forbidden: args.forbidden,
    notes: args.notes ?? null,
  };

  const dataName = handoffDataName(args.beadId);
  const handles: Array<{ name: string }> = [];
  handles.push(await ctx.writeResource("handoff", dataName, handoff));
  handles.push(
    await ctx.createFileWriter("report", `report-${dataName}`).writeText(
      renderHandoff(handoff),
    ),
  );

  ctx.logger.info(
    "Handoff captured: {staged} staged, {dirty} dirty, {untracked} untracked",
    {
      staged: gitState.staged.length,
      dirty: gitState.dirty.length,
      untracked: gitState.untracked.length,
    },
  );
  return { dataHandles: handles };
}

async function resume(
  rawArgs: z.infer<typeof ResumeArgsSchema>,
  ctx: Context,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const args = ResumeArgsSchema.parse(rawArgs);
  const dataName = handoffDataName(args.beadId);
  const stored = await ctx.readResource(dataName);
  if (!stored) {
    throw new Error(
      `No handoff on file for ${args.beadId} (looked for data "${dataName}"). Run capture first.`,
    );
  }
  const handoff = HandoffSchema.parse(stored);
  const summary: z.infer<typeof ResumeSchema> = {
    resumedAt: new Date().toISOString(),
    capturedAt: handoff.capturedAt,
    beadId: args.beadId,
    branch: handoff.git.branch,
    headSha: handoff.git.headSha,
    nextSafe: handoff.nextSafe,
    forbidden: handoff.forbidden,
    dirtyCount: handoff.git.changedPaths.length,
    inProgressOperations: handoff.git.inProgressOperations,
  };

  const briefName = `resume-${dataName}`;
  const reportName = `report-${briefName}`;
  const brief = [
    `# Resume brief — ${args.beadId}`,
    "",
    `Captured ${handoff.capturedAt} (resumed ${summary.resumedAt}).`,
    "",
    `- Branch: \`${summary.branch ?? "(detached)"}\` @ \`${summary.headSha}\``,
    `- Dirty paths: ${summary.dirtyCount}`,
    summary.inProgressOperations.length
      ? `- **In progress:** ${summary.inProgressOperations.join(", ")}`
      : "",
    "",
    "## Next safe step",
    "",
    summary.nextSafe ?? "(none recorded)",
    "",
    summary.forbidden.length ? "## Do not" : "",
    ...summary.forbidden.map((f) => `- ${f}`),
    "",
    "---",
    "",
    renderHandoff(handoff),
  ].filter((line) => line !== "").join("\n");

  ctx.logger.info("Resuming handoff for {bead} captured at {at}", {
    bead: args.beadId,
    at: handoff.capturedAt,
  });

  return {
    dataHandles: [
      await ctx.writeResource("resume", briefName, summary),
      await ctx.createFileWriter("report", reportName).writeText(brief),
    ],
  };
}

async function list(
  rawArgs: z.infer<typeof ListArgsSchema>,
  ctx: Context,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const args = ListArgsSchema.parse(rawArgs);
  if (!ctx.queryData) {
    throw new Error("queryData is not available in this runtime");
  }
  const records = await ctx.queryData(
    `modelName == "${ctx.definition.name}" && specName == "handoff"`,
  );
  const entries: Array<z.infer<typeof CatalogEntrySchema>> = records.map(
    (record) => {
      const attributes = (record.attributes ?? {}) as Json;
      const git = (attributes.git ?? {}) as Json;
      const bead = (attributes.bead ?? {}) as Json | null;
      return {
        dataName: String(record.name ?? ""),
        version: Number(record.version ?? 0),
        capturedAt: (attributes.capturedAt as string | null) ?? null,
        beadId: bead ? (bead.id as string | null) ?? null : null,
        branch: (git.branch as string | null) ?? null,
        headSha: (git.headSha as string | null) ?? null,
      };
    },
  );
  entries.sort((a, b) =>
    (b.capturedAt ?? "").localeCompare(a.capturedAt ?? "")
  );
  const truncated = entries.length > args.limit;
  const catalog: z.infer<typeof CatalogSchema> = {
    listedAt: new Date().toISOString(),
    count: Math.min(entries.length, args.limit),
    truncated,
    entries: entries.slice(0, args.limit),
  };
  ctx.logger.info("Listed {count} stored handoff(s)", {
    count: catalog.count,
    truncated,
  });
  return {
    dataHandles: [
      await ctx.writeResource("catalog", "catalog-current", catalog),
    ],
  };
}

// ---------- behavior definition ---------------------------------------------

/** Swamp model definition for exact-state handoffs. */
export const model = {
  type: "@maphew/handoff",
  version: "2026.10.15.3",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.15.1",
      description:
        "Initial release: capture/resume/list methods, handoff and resume resources, markdown report",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.2",
      description:
        "Fix duplicate data instance name: the report file is written as report-<dataName>, distinct from the handoff resource",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.3",
      description:
        "Fix leading-space corruption of git status --porcelain -z output; unstaged edits are now classified as dirty with their full path",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    handoff: {
      description:
        "Exact Git + Bead state and narrative for a resumable handoff",
      schema: HandoffSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    resume: {
      description: "Cold-start summary re-surfaced from a stored handoff",
      schema: ResumeSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    catalog: {
      description: "Catalogue of stored handoffs for this behavior instance",
      schema: CatalogSchema,
      lifetime: "1d" as const,
      garbageCollection: 5,
    },
  },
  files: {
    report: {
      description: "Markdown handoff / resume brief",
      contentType: "text/markdown",
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    capture: {
      description:
        "Snapshot Git and Bead state, write a handoff resource and markdown report",
      arguments: CaptureArgsSchema,
      execute: capture,
    },
    resume: {
      description:
        "Read the newest handoff for a Bead and write a cold-start resume brief",
      arguments: ResumeArgsSchema,
      execute: resume,
    },
    list: {
      description: "Catalogue stored handoffs for this behavior instance",
      arguments: ListArgsSchema,
      execute: list,
    },
  },
};
