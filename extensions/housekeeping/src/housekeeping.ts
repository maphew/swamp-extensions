/**
 * Generic, portable housekeeping sweep.
 *
 * A read-only audit of the cruft that accumulates around a working checkout —
 * dirty trees, diverged or gone branches, forgotten stashes, stale worktrees,
 * temp debris, leftover processes, disk pressure, and stuck tracker claims —
 * plus a small set of explicitly-gated cleanup methods. The audit is the point:
 * the posture is **notice and report; delete only the obviously dead**.
 *
 * The model is deliberately project-agnostic. `projectDir` defaults to `.`, so
 * the same type works in any git repository, with optional `.beads/` and
 * `.swamp/` awareness layered on when those directories exist.
 *
 * Methods:
 *   - `check`             read-only fan-out; writes an audit + markdown report
 *   - `pruneWorktrees`    remove missing worktrees (dry-run by default)
 *   - `unclaimStaleBeads` release expired tracker claims (dry-run by default)
 *   - `cleanTemp`         delete matched temp debris older than a threshold
 *                         (dry-run by default)
 *
 * Specialists: the deep worktree and swamp-repo checks live in
 * `@mgreten/git-worktree-doctor` and `@maphew/repo-doctor`. This model reports
 * the generic surface and is the aggregator; it does not duplicate those.
 *
 * @module
 */

import { z } from "npm:zod@4";

// ---------- schemas ---------------------------------------------------------

const SeveritySchema = z.enum(["error", "warning", "info"]);

const FindingSchema = z.object({
  category: z.string().describe(
    "Check family: git, worktrees, temp, beads, swamp",
  ),
  severity: SeveritySchema,
  message: z.string(),
  detail: z.string().nullable(),
  target: z.string().nullable().describe(
    "Branch, path, or issue id the finding is about",
  ),
});

const GitReportSchema = z.object({
  currentBranch: z.string().nullable(),
  detached: z.boolean(),
  upstream: z.string().nullable(),
  ahead: z.number().int(),
  behind: z.number().int(),
  gone: z.boolean(),
  dirtyFiles: z.number().int(),
  untrackedFiles: z.number().int(),
  stashes: z.number().int(),
  goneBranches: z.array(z.string()),
  noUpstreamBranches: z.array(z.string()),
  mergedBranches: z.array(z.string()),
});

const WorktreeSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  bare: z.boolean(),
  locked: z.boolean(),
  prunable: z.boolean(),
  pathExists: z.boolean(),
  isMain: z.boolean(),
});

const WorktreesReportSchema = z.object({
  total: z.number().int(),
  stale: z.array(WorktreeSchema),
  prunable: z.array(WorktreeSchema),
  locked: z.array(WorktreeSchema),
  detached: z.array(WorktreeSchema),
});

const TempEntrySchema = z.object({
  path: z.string(),
  root: z.string(),
  ageHours: z.number(),
  sizeBytes: z.number().nullable(),
  stale: z.boolean(),
});

const TempReportSchema = z.object({
  entries: z.array(TempEntrySchema),
  matched: z.number().int(),
  stale: z.number().int(),
  processes: z.array(z.string()),
  diskFreeBytes: z.number().nullable(),
  diskPath: z.string(),
});

const BeadClaimSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  assignee: z.string().nullable(),
  startedAt: z.string().nullable(),
  leaseExpiresAt: z.string().nullable(),
  stale: z.boolean(),
});

const BeadsReportSchema = z.object({
  present: z.boolean(),
  bdVersion: z.string().nullable(),
  expectedVersion: z.string().nullable(),
  versionMismatch: z.boolean(),
  claims: z.array(BeadClaimSchema),
  staleClaims: z.array(BeadClaimSchema),
  staleIssues: z.number().int(),
  orphans: z.array(z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
  })),
  doctor: z.array(z.object({
    check: z.string(),
    status: z.string(),
    message: z.string(),
  })),
});

const AuditSchema = z.object({
  projectDir: z.string(),
  checkedAt: z.string(),
  verdict: z.enum(["healthy", "issues", "error"]),
  errorCount: z.number().int(),
  warningCount: z.number().int(),
  infoCount: z.number().int(),
  findings: z.array(FindingSchema),
});

const GlobalArgsSchema = z.object({
  projectDir: z.string().default(".").describe(
    "Repository root to audit. Defaults to the current directory so the model stays portable.",
  ),
  defaultBranch: z.string().optional().describe(
    "Branch to treat as the mainline. Auto-detected from origin/HEAD, then main, then master.",
  ),
  bdBin: z.string().default("bd").describe("Beads CLI binary name or path"),
  staleClaimDays: z.number().default(7).describe(
    "Age (days) after which an in-progress tracker claim is reported stale even when its lease has not expired",
  ),
  staleTempHours: z.number().default(24).describe(
    "Age (hours) after which matched temp debris is reported stale",
  ),
  tempGlobs: z.array(z.string()).default([
    "beads-bd-tests-*",
    "*.tmp",
    "*.swp",
    "*.orig",
    "*.rej",
  ]).describe("Glob patterns matched (one level deep) under the temp roots"),
  tempRoots: z.array(z.string()).default([]).describe(
    "Directories scanned for temp debris. Empty means $TMPDIR and projectDir.",
  ),
  processPatterns: z.array(z.string()).default(["dolt sql-server"]).describe(
    "pgrep patterns for leftover processes. Empty disables the process check.",
  ),
  includeBeads: z.boolean().default(true).describe(
    "Run tracker hygiene checks when .beads/ is present",
  ),
  includeTemp: z.boolean().default(true).describe(
    "Scan for temp debris, leftover processes, and disk pressure",
  ),
});

// ---------- shared types ----------------------------------------------------

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type Finding = z.infer<typeof FindingSchema>;
type Audit = z.infer<typeof AuditSchema>;
type GitReport = z.infer<typeof GitReportSchema>;
type WorktreesReport = z.infer<typeof WorktreesReportSchema>;
type TempReport = z.infer<typeof TempReportSchema>;
type BeadsReport = z.infer<typeof BeadsReportSchema>;

type FileHandle = { name: string };

type ModelContext = {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<FileHandle>;
  createFileWriter: (spec: string, instance: string) => {
    writeText: (text: string) => Promise<FileHandle>;
  };
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
    debug?: (msg: string, props?: Record<string, unknown>) => void;
  };
};

type Logger = ModelContext["logger"];

type CmdResult = { stdout: string; stderr: string; code: number };

// ---------- pure helpers ----------------------------------------------------

/** Run a command, returning a null result when the binary is missing. */
async function run(
  cmd: string[],
  cwd?: string,
): Promise<CmdResult | null> {
  try {
    // swamp-quality-ignore deno-command
    const output = await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "piped",
      cwd,
    }).output();
    return {
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
      code: output.code,
    };
  } catch {
    return null;
  }
}

/** Command stdout on success, otherwise null. */
async function stdout(cmd: string[], cwd?: string): Promise<string | null> {
  const result = await run(cmd, cwd);
  return result && result.code === 0 ? result.stdout : null;
}

/**
 * Parse the `## branch...upstream [ahead N, behind M]` header line from
 * `git status --porcelain=v1 --branch`.
 */
export function parseStatusHeader(line: string): {
  currentBranch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  detached: boolean;
} {
  const out = {
    currentBranch: null as string | null,
    upstream: null as string | null,
    ahead: 0,
    behind: 0,
    gone: false,
    detached: false,
  };
  if (!line.startsWith("## ")) return out;
  const rest = line.slice(3).trim();
  if (rest.startsWith("HEAD (no branch)")) {
    out.detached = true;
    return out;
  }
  const [head, ...trackParts] = rest.split(" ");
  const track = trackParts.join(" ");
  const [branch, upstream] = head.split("...");
  out.currentBranch = branch || null;
  out.upstream = upstream || null;
  out.gone = track.includes("[gone]");
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  if (ahead) out.ahead = Number(ahead[1]);
  if (behind) out.behind = Number(behind[1]);
  return out;
}

/** Count changed and untracked files from `git status --porcelain=v1`. */
export function countStatusFiles(
  porcelains: string[],
): { dirty: number; untracked: number } {
  let dirty = 0;
  let untracked = 0;
  for (const line of porcelains) {
    if (line.startsWith("??")) {
      untracked++;
    } else if (line.trim().length > 0) {
      dirty++;
    }
  }
  return { dirty, untracked };
}

/** One local branch from `git for-each-ref`. */
export type BranchInfo = {
  name: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
};

/** Parse tab-separated `git for-each-ref` output. */
export function parseForEachRef(output: string): BranchInfo[] {
  const branches: BranchInfo[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [name, upstream = "", track = ""] = line.split("\t");
    const ahead = /ahead (\d+)/.exec(track);
    const behind = /behind (\d+)/.exec(track);
    branches.push({
      name,
      upstream: upstream || null,
      ahead: ahead ? Number(ahead[1]) : 0,
      behind: behind ? Number(behind[1]) : 0,
      gone: track.includes("[gone]"),
    });
  }
  return branches;
}

/** Merge state for one worktree parsed from porcelain. */
export type WorktreeInfo = z.infer<typeof WorktreeSchema>;

/** Parse `git worktree list --porcelain` blocks. */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  const blocks = output.split("\n\n").filter((b) => b.trim().length > 0);
  for (let i = 0; i < blocks.length; i++) {
    const entry: WorktreeInfo = {
      path: "",
      branch: null,
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
      pathExists: false,
      isMain: i === 0,
    };
    for (const line of blocks[i].trim().split("\n")) {
      if (line.startsWith("worktree ")) entry.path = line.slice(9);
      else if (line.startsWith("branch ")) {
        entry.branch = line.slice(7).replace(/^refs\/heads\//, "");
      } else if (line === "detached") entry.detached = true;
      else if (line === "bare") entry.bare = true;
      else if (line.startsWith("locked")) entry.locked = true;
      else if (line.startsWith("prunable")) entry.prunable = true;
    }
    if (entry.path) worktrees.push(entry);
  }
  return worktrees;
}

/** One stash from `git stash list`. */
export type StashInfo = { ref: string; date: string | null; subject: string };

/** Parse `git stash list --format='%gd|%ci|%s'`. */
export function parseStashList(output: string): StashInfo[] {
  const stashes: StashInfo[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [ref = "", date = "", ...subject] = line.split("|");
    stashes.push({
      ref,
      date: date || null,
      subject: subject.join("|"),
    });
  }
  return stashes;
}

/** Convert a glob (`*`, `?`) to an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** Test a name against a glob pattern. */
export function matchesGlob(name: string, pattern: string): boolean {
  return globToRegExp(pattern).test(name);
}

/** True when an ISO timestamp is older than `hours` relative to `nowMs`. */
export function isOlderThan(
  iso: string | null,
  nowMs: number,
  hours: number,
): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return nowMs - t > hours * 3600_000;
}

/** True when an ISO timestamp is in the past. */
export function isExpired(iso: string | null, nowMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return t < nowMs;
}

/** Extract the first `N.N.N` version token from a version string. */
export function versionToken(value: string | null): string | null {
  const m = value?.match(/\d+\.\d+\.\d+/);
  return m ? m[0] : null;
}

/** Parse `df -Pk <path>` output into available bytes. */
export function parseDfAvailableBytes(output: string): number | null {
  const lines = output.trim().split("\n");
  if (lines.length < 2) return null;
  const cols = lines[lines.length - 1].trim().split(/\s+/);
  // Filesystem 1024-blocks Used Available Capacity Mounted
  const available = Number(cols[3]);
  return Number.isFinite(available) ? available * 1024 : null;
}

// ---------- report rendering ------------------------------------------------

function prettyBytes(bytes: number | null): string {
  if (bytes === null) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Render the audit as the operator-facing markdown report. */
export function renderReport(audit: Audit): string {
  const lines: string[] = [];
  lines.push(`# Housekeeping — \`${audit.projectDir}\``);
  lines.push("");
  lines.push(
    `- Verdict: **${audit.verdict}** (${audit.errorCount} error, ${audit.warningCount} warning, ${audit.infoCount} info)`,
  );
  lines.push(`- Checked at: ${audit.checkedAt}`);
  lines.push("");

  const order = ["error", "warning", "info"] as const;
  for (const severity of order) {
    const group = audit.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    lines.push(`## ${severity} (${group.length})`);
    lines.push("");
    for (const f of group) {
      const loc = f.target ? ` \`${f.target}\`` : "";
      lines.push(`- **${f.category}**${loc} — ${f.message}`);
      if (f.detail) lines.push(`  - ${f.detail}`);
    }
    lines.push("");
  }

  if (audit.findings.length === 0) {
    lines.push("Nothing to report. The checkout looks clean.");
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "This audit reports only what is on a list. Before acting, answer: **What did I notice that isn't on any list?** Do not delete anything ambiguous — file it as a tracker issue or hand it off instead.",
  );
  return lines.join("\n");
}

// ---------- checks ----------------------------------------------------------

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveProjectDir(projectDir: string): Promise<string> {
  try {
    return await Deno.realPath(projectDir);
  } catch {
    return projectDir;
  }
}

async function detectDefaultBranch(
  dir: string,
  override?: string,
): Promise<string> {
  if (override) return override;
  const head = await stdout(
    ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    dir,
  );
  if (head) return head.trim().replace(/^origin\//, "");
  for (const candidate of ["main", "master", "trunk", "develop"]) {
    const ok = await run(
      ["git", "show-ref", "--verify", "--quiet", `refs/heads/${candidate}`],
      dir,
    );
    if (ok && ok.code === 0) return candidate;
  }
  return "main";
}

async function checkGit(
  dir: string,
  defaultBranch: string,
): Promise<{ report: GitReport; findings: Finding[] }> {
  const findings: Finding[] = [];

  const status = await run(
    ["git", "status", "--porcelain=v1", "--branch"],
    dir,
  );
  if (!status || status.code !== 0) {
    throw new Error(
      `not a git repository (or git unavailable): ${status?.stderr ?? dir}`,
    );
  }
  const statusLines = status.stdout.split("\n");
  const header = parseStatusHeader(statusLines[0] ?? "");
  const { dirty, untracked } = countStatusFiles(statusLines.slice(1));

  const refs = parseForEachRef(
    (await stdout(
      [
        "git",
        "for-each-ref",
        "--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)",
        "refs/heads",
      ],
      dir,
    )) ?? "",
  );

  const stashes = parseStashList(
    (await stdout(
      ["git", "stash", "list", "--format=%gd|%ci|%s"],
      dir,
    )) ?? "",
  );

  const mergedRaw = await stdout(
    ["git", "branch", "--merged", defaultBranch, "--format=%(refname:short)"],
    dir,
  );
  if (mergedRaw === null) {
    findings.push({
      category: "git",
      severity: "info",
      message: `Could not list branches merged into '${defaultBranch}'`,
      detail:
        "The mainline name may differ. Set the defaultBranch global arg to the real mainline to enable merged-branch detection.",
      target: defaultBranch,
    });
  }
  const merged = (mergedRaw ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((b) => b && b !== defaultBranch && b !== header.currentBranch);

  const goneBranches = refs.filter((b) => b.gone).map((b) => b.name);
  const noUpstream = refs
    .filter((b) => !b.upstream && b.name !== defaultBranch)
    .map((b) => b.name);

  if (header.detached) {
    findings.push({
      category: "git",
      severity: "warning",
      message: "HEAD is detached",
      detail: "A detached HEAD can strand commits. Check out a branch.",
      target: null,
    });
  }
  if (dirty > 0 || untracked > 0) {
    findings.push({
      category: "git",
      severity: "warning",
      message:
        `${dirty} modified and ${untracked} untracked file(s) in the working tree`,
      detail:
        "Uncommitted work may be someone's live state. Report it; do not discard it.",
      target: null,
    });
  }
  if (header.gone) {
    findings.push({
      category: "git",
      severity: "warning",
      message:
        `Current branch '${header.currentBranch}' tracks a deleted upstream`,
      detail: null,
      target: header.currentBranch,
    });
  } else if (header.behind > 0) {
    findings.push({
      category: "git",
      severity: "info",
      message:
        `Current branch is ${header.behind} commit(s) behind ${header.upstream}`,
      detail: "A `git pull --rebase` may be due.",
      target: header.currentBranch,
    });
  }
  for (const branch of goneBranches) {
    findings.push({
      category: "git",
      severity: "info",
      message: `Branch '${branch}' tracks a deleted upstream`,
      detail:
        "Candidate for deletion after confirming it is merged or abandoned.",
      target: branch,
    });
  }
  if (stashes.length > 0) {
    findings.push({
      category: "git",
      severity: "info",
      message: `${stashes.length} stash entry(ies) present`,
      detail:
        "Stashes are shared across worktrees — confirm ownership before dropping.",
      target: null,
    });
  }
  if (merged.length > 0) {
    findings.push({
      category: "git",
      severity: "info",
      message:
        `${merged.length} local branch(es) already merged into ${defaultBranch}`,
      detail: merged.join(", "),
      target: null,
    });
  }

  const report: GitReport = {
    currentBranch: header.currentBranch,
    detached: header.detached,
    upstream: header.upstream,
    ahead: header.ahead,
    behind: header.behind,
    gone: header.gone,
    dirtyFiles: dirty,
    untrackedFiles: untracked,
    stashes: stashes.length,
    goneBranches,
    noUpstreamBranches: noUpstream,
    mergedBranches: merged,
  };
  return { report, findings };
}

async function checkWorktrees(
  dir: string,
): Promise<{ report: WorktreesReport; findings: Finding[] }> {
  const findings: Finding[] = [];
  const raw = await stdout(["git", "worktree", "list", "--porcelain"], dir);
  const worktrees = raw ? parseWorktreeList(raw) : [];
  for (const wt of worktrees) {
    wt.pathExists = await pathExists(wt.path);
  }

  const stale = worktrees.filter((w) => !w.pathExists && !w.isMain);
  const prunable = worktrees.filter((w) => w.prunable);
  const locked = worktrees.filter((w) => w.locked);
  const detached = worktrees.filter((w) => w.detached && !w.isMain);

  for (const wt of stale) {
    findings.push({
      category: "worktrees",
      severity: "warning",
      message: "Worktree path is missing on disk",
      detail: "`git worktree prune` removes the dangling entry.",
      target: wt.path,
    });
  }
  for (const wt of prunable) {
    findings.push({
      category: "worktrees",
      severity: "info",
      message: "Worktree is marked prunable by git",
      detail: "`git worktree prune` removes it.",
      target: wt.path,
    });
  }
  for (const wt of locked) {
    findings.push({
      category: "worktrees",
      severity: "info",
      message: "Worktree is locked",
      detail: "Locked worktrees are intentionally pinned; leave them alone.",
      target: wt.path,
    });
  }

  return {
    report: {
      total: worktrees.length,
      stale,
      prunable,
      locked,
      detached,
    },
    findings,
  };
}

async function dirSizeBytes(path: string): Promise<number | null> {
  const du = await run(["du", "-sk", path]);
  if (du && du.code === 0) {
    const kb = Number(du.stdout.trim().split(/\s+/)[0]);
    if (Number.isFinite(kb)) return kb * 1024;
  }
  return null;
}

async function checkTemp(
  dir: string,
  nowMs: number,
  cfg: GlobalArgs,
): Promise<{ report: TempReport; findings: Finding[] }> {
  const findings: Finding[] = [];
  const entries: z.infer<typeof TempEntrySchema>[] = [];

  const roots = tempRootsFor(dir, cfg);
  for (const root of roots) {
    const names: string[] = [];
    try {
      for await (const entry of Deno.readDir(root)) names.push(entry.name);
    } catch {
      continue;
    }
    for (const name of names) {
      const matched = cfg.tempGlobs.some((g) => matchesGlob(name, g));
      if (!matched) continue;
      const full = `${root}/${name}`;
      let mtimeIso: string | null = null;
      try {
        const stat = await Deno.stat(full);
        mtimeIso = stat.mtime?.toISOString() ?? null;
      } catch {
        continue;
      }
      const ageHours = mtimeIso ? (nowMs - Date.parse(mtimeIso)) / 3600_000 : 0;
      const stale = isOlderThan(mtimeIso, nowMs, cfg.staleTempHours);
      entries.push({
        path: full,
        root,
        ageHours: Math.round(ageHours * 10) / 10,
        sizeBytes: await dirSizeBytes(full),
        stale,
      });
    }
  }

  const staleEntries = entries.filter((e) => e.stale);
  if (staleEntries.length > 0) {
    const total = staleEntries.reduce((n, e) => n + (e.sizeBytes ?? 0), 0);
    findings.push({
      category: "temp",
      severity: "warning",
      message:
        `${staleEntries.length} stale temp item(s) matching the configured globs (${
          prettyBytes(total)
        })`,
      detail: "Run `cleanTemp` to preview removal; inspect each entry first.",
      target: null,
    });
  }

  const processes: string[] = [];
  for (const pattern of cfg.processPatterns) {
    const pgrep = await run(["pgrep", "-af", pattern]);
    if (pgrep && pgrep.code === 0) {
      for (const line of pgrep.stdout.split("\n")) {
        if (line.trim()) processes.push(line.trim());
      }
    }
  }
  if (processes.length > 0) {
    findings.push({
      category: "process",
      severity: "info",
      message: `${processes.length} process(es) match the configured patterns`,
      detail: processes.slice(0, 5).join("\n"),
      target: null,
    });
  }

  const df = await run(["df", "-Pk", dir]);
  const diskFreeBytes = df && df.code === 0
    ? parseDfAvailableBytes(df.stdout)
    : null;
  if (diskFreeBytes !== null && diskFreeBytes < 2 * 1024 ** 3) {
    findings.push({
      category: "disk",
      severity: "warning",
      message: `Only ${
        prettyBytes(diskFreeBytes)
      } free on the project filesystem`,
      detail: null,
      target: dir,
    });
  }

  return {
    report: {
      entries,
      matched: entries.length,
      stale: staleEntries.length,
      processes,
      diskFreeBytes,
      diskPath: dir,
    },
    findings,
  };
}

async function checkBeads(
  dir: string,
  nowMs: number,
  cfg: GlobalArgs,
  logger: Logger,
): Promise<{ report: BeadsReport; findings: Finding[] }> {
  const findings: Finding[] = [];
  const present = await pathExists(`${dir}/.beads`);
  const report: BeadsReport = {
    present,
    bdVersion: null,
    expectedVersion: null,
    versionMismatch: false,
    claims: [],
    staleClaims: [],
    staleIssues: 0,
    orphans: [],
    doctor: [],
  };
  if (!present) return { report, findings };

  const bdBin = cfg.bdBin;
  const versionOut = await stdout([bdBin, "--version"], dir);
  if (versionOut === null) {
    findings.push({
      category: "beads",
      severity: "warning",
      message: `.beads/ is present but \`${bdBin} --version\` did not run`,
      detail:
        "The tracker binary is missing or not executable; every tracker check is skipped.",
      target: bdBin,
    });
    return { report, findings };
  }
  report.bdVersion = versionToken(versionOut);
  try {
    report.expectedVersion = versionToken(
      (await Deno.readTextFile(`${dir}/.beads/.local_version`)).trim(),
    );
  } catch {
    report.expectedVersion = null;
  }
  if (
    report.bdVersion && report.expectedVersion &&
    report.bdVersion !== report.expectedVersion
  ) {
    report.versionMismatch = true;
    findings.push({
      category: "beads",
      severity: "warning",
      message:
        `bd on PATH is ${report.bdVersion} but .beads/.local_version is ${report.expectedVersion}`,
      detail: "A stale binary can silently diverge from the tracker's schema.",
      target: bdBin,
    });
  }

  // Stuck claims: expired lease, or idle beyond staleClaimDays.
  const inProgressOut = await stdout(
    [bdBin, "list", "--status=in_progress", "--json"],
    dir,
  );
  if (inProgressOut) {
    try {
      const parsed = JSON.parse(inProgressOut) as Array<
        Record<string, unknown>
      >;
      for (const issue of parsed) {
        const lease = (issue.lease_expires_at as string | undefined) ?? null;
        const started = (issue.started_at as string | undefined) ?? null;
        const updated = (issue.updated_at as string | undefined) ?? null;
        const expired = isExpired(lease, nowMs);
        const idle = isOlderThan(updated ?? started, nowMs, cfg.staleClaimDays);
        const stale = expired || idle;
        const claim = {
          id: String(issue.id ?? ""),
          title: String(issue.title ?? ""),
          status: String(issue.status ?? ""),
          assignee: (issue.assignee as string | undefined) ?? null,
          startedAt: started,
          leaseExpiresAt: lease,
          stale,
        };
        report.claims.push(claim);
        if (stale) report.staleClaims.push(claim);
      }
    } catch (error) {
      logger.warn("Could not parse `bd list --status=in_progress --json`", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const claim of report.staleClaims) {
    findings.push({
      category: "beads",
      severity: "info",
      message: `Claim on ${claim.id} looks stale (${claim.title})`,
      detail:
        "Lease expired or idle past the threshold. `unclaimStaleBeads` can release it.",
      target: claim.id,
    });
  }

  const staleOut = await stdout([bdBin, "stale", "--json"], dir);
  if (staleOut) {
    try {
      const parsed = JSON.parse(staleOut);
      report.staleIssues = Array.isArray(parsed) ? parsed.length : 0;
    } catch (error) {
      logger.warn("Could not parse `bd stale --json`", {
        error: error instanceof Error ? error.message : String(error),
      });
      report.staleIssues = 0;
    }
  }
  if (report.staleIssues > 0) {
    findings.push({
      category: "beads",
      severity: "info",
      message: `${report.staleIssues} stale tracker issue(s)`,
      detail: null,
      target: null,
    });
  }

  const orphansOut = await stdout([bdBin, "orphans", "--json"], dir);
  if (orphansOut) {
    try {
      const parsed = JSON.parse(orphansOut) as Array<Record<string, unknown>>;
      report.orphans = parsed.map((o) => ({
        id: String(o.issue_id ?? o.id ?? ""),
        title: String(o.title ?? ""),
        status: String(o.status ?? ""),
      }));
    } catch (error) {
      logger.warn("Could not parse `bd orphans --json`", {
        error: error instanceof Error ? error.message : String(error),
      });
      report.orphans = [];
    }
  }
  for (const orphan of report.orphans) {
    findings.push({
      category: "beads",
      severity: "info",
      message:
        `Orphaned issue ${orphan.id}: committed but still open (${orphan.title})`,
      detail: "Confirm the work landed, then close it.",
      target: orphan.id,
    });
  }

  // Supported embedded-mode doctor checks; tolerate unsupported ones.
  for (const check of ["artifacts", "pollution", "conventions"]) {
    const out = await stdout(
      [bdBin, "doctor", `--check=${check}`, "--json"],
      dir,
    );
    if (!out) continue;
    try {
      const parsed = JSON.parse(out) as Record<string, unknown>;
      if (Array.isArray(parsed.checks)) {
        for (const c of parsed.checks as Array<Record<string, unknown>>) {
          const status = String(c.status ?? "info");
          report.doctor.push({
            check: String(c.name ?? check),
            status,
            message: String(c.message ?? ""),
          });
          if (status !== "ok") {
            findings.push({
              category: "beads",
              severity: status === "error" ? "error" : "info",
              message: `bd doctor ${String(c.name ?? check)}: ${c.message}`,
              detail: c.fix ? `fix: ${c.fix}` : null,
              target: String(c.name ?? check),
            });
          }
        }
      }
      const count = Number(parsed.total_count ?? parsed.polluted_count ?? 0);
      if (count > 0) {
        findings.push({
          category: "beads",
          severity: "warning",
          message: `bd doctor ${check} reported ${count} issue(s)`,
          detail: null,
          target: check,
        });
      }
    } catch (error) {
      logger.warn(`Could not parse \`bd doctor --check=${check} --json\``, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { report, findings };
}

// ---------- configuration resolution ---------------------------------------

function tempRootsFor(dir: string, cfg: GlobalArgs): string[] {
  if (cfg.tempRoots.length > 0) return cfg.tempRoots;
  const tmp = Deno.env.get("TMPDIR") ?? "/tmp";
  const roots = [tmp, dir];
  return roots.filter((r, i) => roots.indexOf(r) === i);
}

// ---------- methods ---------------------------------------------------------

async function doCheck(ctx: ModelContext): Promise<{
  audit: Audit;
  git: GitReport;
  worktrees: WorktreesReport;
  temp: TempReport | null;
  beads: BeadsReport | null;
}> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const dir = await resolveProjectDir(cfg.projectDir);
  const nowMs = Date.now();
  const defaultBranch = await detectDefaultBranch(dir, cfg.defaultBranch);

  ctx.logger.info("Housekeeping check starting in {dir}", {
    dir,
    beads: cfg.includeBeads,
    temp: cfg.includeTemp,
  });

  const findings: Finding[] = [];
  const git = await checkGit(dir, defaultBranch);
  findings.push(...git.findings);

  const worktrees = await checkWorktrees(dir);
  findings.push(...worktrees.findings);

  let temp: TempReport | null = null;
  if (cfg.includeTemp) {
    const tempResult = await checkTemp(dir, nowMs, cfg);
    temp = tempResult.report;
    findings.push(...tempResult.findings);
  }

  let beads: BeadsReport | null = null;
  if (cfg.includeBeads) {
    const beadsResult = await checkBeads(dir, nowMs, cfg, ctx.logger);
    beads = beadsResult.report;
    findings.push(...beadsResult.findings);
  }

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  const infoCount = findings.filter((f) => f.severity === "info").length;
  const audit: Audit = {
    projectDir: dir,
    checkedAt: new Date(nowMs).toISOString(),
    verdict: errorCount > 0 ? "error" : warningCount > 0 ? "issues" : "healthy",
    errorCount,
    warningCount,
    infoCount,
    findings,
  };
  return { audit, git: git.report, worktrees: worktrees.report, temp, beads };
}

async function check(
  _args: Record<string, never>,
  ctx: ModelContext,
): Promise<{ dataHandles: FileHandle[] }> {
  const result = await doCheck(ctx);
  ctx.logger.info(
    "Housekeeping check: {w} warning(s), {e} error(s)",
    { w: result.audit.warningCount, e: result.audit.errorCount },
  );

  const handles: FileHandle[] = [
    await ctx.writeResource("audit", "audit-current", result.audit),
    await ctx.writeResource("git", "git-current", result.git),
    await ctx.writeResource("worktrees", "worktrees-current", result.worktrees),
  ];
  if (result.temp) {
    handles.push(await ctx.writeResource("temp", "temp-current", result.temp));
  }
  if (result.beads) {
    handles.push(
      await ctx.writeResource("beads", "beads-current", result.beads),
    );
  }
  handles.push(
    await ctx.createFileWriter("report", "report-current").writeText(
      renderReport(result.audit),
    ),
  );
  return { dataHandles: handles };
}

async function pruneWorktrees(
  args: { dryRun?: boolean; verbose?: boolean },
  ctx: ModelContext,
): Promise<{ dataHandles: FileHandle[] }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const dir = await resolveProjectDir(cfg.projectDir);
  const dryRun = args.dryRun ?? true;
  const verbose = args.verbose ?? false;

  ctx.logger.info("Pruning worktrees in {dir} (dryRun={dryRun})", {
    dir,
    dryRun,
  });

  const raw = await stdout(["git", "worktree", "list", "--porcelain"], dir);
  const worktrees = raw ? parseWorktreeList(raw) : [];
  for (const wt of worktrees) wt.pathExists = await pathExists(wt.path);
  const candidates = worktrees.filter((w) => !w.pathExists && !w.isMain);

  let stdoutText = "";
  let stderrText = "";
  let code = 0;
  if (!dryRun) {
    const cmd = ["git", "worktree", "prune"];
    if (verbose) cmd.push("--verbose");
    const result = await run(cmd, dir);
    stdoutText = result?.stdout ?? "";
    stderrText = result?.stderr ?? "";
    code = result?.code ?? 1;
  }

  const report = {
    projectDir: dir,
    dryRun,
    candidates: candidates.map((c) => c.path),
    pruned: dryRun ? [] : candidates.map((c) => c.path),
    stdout: stdoutText,
    stderr: stderrText,
    exitCode: code,
  };
  ctx.logger.info(
    dryRun ? "Would prune {n} worktree(s)" : "Pruned {n} worktree(s)",
    { n: candidates.length },
  );
  return {
    dataHandles: [
      await ctx.writeResource(
        "worktreePrune",
        "worktree-prune-current",
        report,
      ),
    ],
  };
}

async function unclaimStaleBeads(
  args: { dryRun?: boolean; force?: boolean; reason?: string },
  ctx: ModelContext,
): Promise<{ dataHandles: FileHandle[] }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const dir = await resolveProjectDir(cfg.projectDir);
  const dryRun = args.dryRun ?? true;
  const force = args.force ?? false;
  const reason = args.reason ?? "housekeeping: stale claim";
  const bdBin = cfg.bdBin;

  ctx.logger.info("Releasing stale tracker claims in {dir} (dryRun={dryRun})", {
    dir,
    dryRun,
  });

  const beadsReport = await checkBeads(dir, Date.now(), cfg, ctx.logger);
  const candidates = beadsReport.report.staleClaims;

  const released: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  if (!dryRun) {
    for (const claim of candidates) {
      const cmd = [bdBin, "unclaim", claim.id, "--reason", reason];
      if (force) cmd.push("--force");
      const out = await run(cmd, dir);
      if (out && out.code === 0) {
        released.push(claim.id);
      } else {
        failed.push({
          id: claim.id,
          error: (out?.stderr || out?.stdout || "bd unavailable").trim(),
        });
      }
    }
  }

  const report = {
    projectDir: dir,
    dryRun,
    force,
    candidates: candidates.map((c) => c.id),
    released,
    failed,
  };
  ctx.logger.info(
    dryRun ? "Would unclaim {n} stale bead(s)" : "Unclaimed {n} stale bead(s)",
    { n: candidates.length },
  );
  return {
    dataHandles: [
      await ctx.writeResource("beadUnclaim", "bead-unclaim-current", report),
    ],
  };
}

async function cleanTemp(
  args: { dryRun?: boolean; force?: boolean },
  ctx: ModelContext,
): Promise<{ dataHandles: FileHandle[] }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const dir = await resolveProjectDir(cfg.projectDir);
  const dryRun = args.dryRun ?? true;
  const force = args.force ?? false;

  ctx.logger.info("Cleaning temp debris in {dir} (dryRun={dryRun})", {
    dir,
    dryRun,
  });

  const tempReport = await checkTemp(dir, Date.now(), cfg);
  const candidates = tempReport.report.entries.filter((e) => e.stale);

  const removed: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  if (!dryRun) {
    for (const entry of candidates) {
      try {
        if (force) {
          await Deno.remove(entry.path, { recursive: true });
        } else {
          await Deno.remove(entry.path);
        }
        removed.push(entry.path);
      } catch (error) {
        failed.push({
          path: entry.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const result = {
    projectDir: dir,
    dryRun,
    force,
    candidates: candidates.map((c) => c.path),
    removed,
    failed,
  };
  ctx.logger.info(
    dryRun ? "Would remove {n} temp item(s)" : "Removed {n} temp item(s)",
    { n: candidates.length },
  );
  return {
    dataHandles: [
      await ctx.writeResource("tempClean", "temp-clean-current", result),
    ],
  };
}

// ---------- definition ------------------------------------------------------

const CleanReportSchema = z.object({
  projectDir: z.string(),
  dryRun: z.boolean(),
  candidates: z.array(z.string()),
  force: z.boolean().optional(),
  released: z.array(z.string()).optional(),
  removed: z.array(z.string()).optional(),
  failed: z.array(z.record(z.string(), z.string())).optional(),
  pruned: z.array(z.string()).optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().optional(),
});

export const model = {
  type: "@maphew/housekeeping",
  version: "2026.10.15.4",
  upgrades: [
    {
      toVersion: "2026.10.15.2",
      description:
        "Packaging fix: list the bundled workflow by basename so it extracts to extension/workflows/workflow-housekeeping.yaml and registers; no schema, method, or resource changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.3",
      description:
        "Quote the bundled workflow name so the scoped @maphew/housekeeping identifier parses as YAML; no schema, method, or resource changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.4",
      description:
        "Adversarial-review fixes: entry logging in every method; warn on bd JSON parse failure and on a missing bd binary; report when the default branch cannot be resolved for merged-branch detection; expand default-branch candidates to trunk/develop",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    audit: {
      description: "Combined read-only housekeeping audit",
      schema: AuditSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    git: {
      description: "Git branch, worktree-of-origin, stash, and status findings",
      schema: GitReportSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    worktrees: {
      description: "Worktree health: stale, prunable, locked, detached",
      schema: WorktreesReportSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    temp: {
      description: "Temp debris, leftover processes, and disk pressure",
      schema: TempReportSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    beads: {
      description:
        "Tracker hygiene: version drift, stale claims, doctor checks",
      schema: BeadsReportSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    worktreePrune: {
      description: "Worktree prune candidate/result",
      schema: CleanReportSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    beadUnclaim: {
      description: "Stale-claim release candidate/result",
      schema: CleanReportSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    tempClean: {
      description: "Temp cleanup candidate/result",
      schema: CleanReportSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },
  files: {
    report: {
      description: "Markdown housekeeping report",
      contentType: "text/markdown",
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description:
        "Read-only fan-out: git, worktrees, temp/processes/disk, and tracker hygiene",
      arguments: z.object({}),
      execute: check,
    },
    pruneWorktrees: {
      description:
        "Remove worktrees whose path is missing on disk. Dry-run by default.",
      arguments: z.object({
        dryRun: z.boolean().default(true),
        verbose: z.boolean().default(false),
      }),
      execute: pruneWorktrees,
    },
    unclaimStaleBeads: {
      description:
        "Release tracker claims whose lease expired or went idle. Dry-run by default.",
      arguments: z.object({
        dryRun: z.boolean().default(true),
        force: z.boolean().default(false).describe(
          "Pass --force to release another actor's claim",
        ),
        reason: z.string().optional(),
      }),
      execute: unclaimStaleBeads,
    },
    cleanTemp: {
      description:
        "Remove matched temp debris older than staleTempHours. Dry-run by default.",
      arguments: z.object({
        dryRun: z.boolean().default(true),
        force: z.boolean().default(false).describe(
          "Remove directories recursively; without it only files are removed",
        ),
      }),
      execute: cleanTemp,
    },
  },
};
