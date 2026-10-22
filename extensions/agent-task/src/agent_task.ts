/**
 * Agent task dispatch behavior.
 *
 * Replaces the shell dispatch cluster that used to live in a swamp repo's
 * `.kilo/agents/` directory (`ready-queue.sh`, `run-task.sh`, `bd-sweep.sh`):
 *
 *   - `filterQueue` reads the `bd ready` queue, drops work a human must unblock,
 *     checks each remaining issue is not already covered by a local or remote
 *     branch, and writes a typed `manifest` resource of dispatch candidates.
 *   - `dispatch` runs one headless agent on one task in a target checkout:
 *     it branches from the base branch, launches the agent inside the target
 *     repo (loading that repo's own `AGENTS.md`), and expects the agent to
 *     commit, push, and open a pull request.
 *   - `sweep` fans out over a manifest's candidates with a single method call,
 *     so one behavior lock covers the whole sweep instead of one lock per
 *     issue.
 *
 * A dispatched agent gets a distinct `BEADS_ACTOR` (`<agent>-<branch>`) so
 * concurrent runs cannot silently double-claim a bead, mirroring the old
 * `run-task.sh` guarantee.
 *
 *   - `run` is the runner primitive: given a prompt, a checkout and an agent,
 *     it builds that agent's invocation and runs it, capturing stdout, stderr
 *     and the exit code. It does no git work and makes no plan — it is the one
 *     authority on *how* a headless agent is launched, so every caller that
 *     needs an agent (this behavior's `dispatch`/`sweep`, `@maphew/pr-sweep`'s
 *     review batches, or a foreman agent's ad-hoc work) gets identical
 *     invocations instead of a copy of the same switch statement.
 *
 * `git` and `bd` are subprocess dependencies, exactly as in `@maphew/bd` and
 * `@maphew/handoff`. `dispatch` and `sweep` use no cross-behavior `runModel`,
 * so the behavior is portable to any Git checkout and any beads repository;
 * `run` is callable on its own by another extension, which does declare this
 * one under `dependencies`.
 *
 * @module
 */

import { z } from "npm:zod@4";

// ---------- schemas ---------------------------------------------------------

/** A supported headless agent binary. */
export type Agent = "claude" | "codex" | "opencode" | "kilo";

const AgentSchema = z.enum(["claude", "codex", "opencode", "kilo"]);

/** One dispatchable issue: where to work, what branch, which agent, what task. */
export interface Candidate {
  /** Bead id, e.g. myswamp-xcy. */
  id: string;
  /** Issue title. */
  title: string;
  /** Priority 0-4. */
  priority: number;
  /** bd issue type (task, bug, feature, ...). */
  issueType: string;
  /** Local checkout the agent runs in. */
  workdir: string;
  /** Feature branch the agent creates. */
  branch: string;
  /** Base branch to branch from. */
  base: string;
  /** Headless agent to run. */
  agent: Agent;
  /** Free-form task prompt for the agent. */
  task: string;
}

const CandidateSchema = z.object({
  id: z.string().describe("Bead id, e.g. myswamp-xcy"),
  title: z.string().describe("Issue title"),
  priority: z.number().int().min(0).max(4).describe("Priority (0-4)"),
  issueType: z.string().describe("bd issue type (task, bug, feature, ...)"),
  workdir: z.string().describe("Local checkout the agent runs in"),
  branch: z.string().describe("Feature branch the agent creates"),
  base: z.string().describe("Base branch to branch from"),
  agent: AgentSchema.describe("Headless agent to run"),
  task: z.string().describe("Free-form task prompt for the agent"),
});

/** An issue dropped from the queue, with the reason it was dropped. */
export interface Dropped {
  /** Bead id. */
  id: string;
  /** Why the issue was not dispatched. */
  reason: string;
}

const DroppedSchema = z.object({
  id: z.string().describe("Bead id"),
  reason: z.string().describe("Why the issue was not dispatched"),
});

/** The filtered ready queue and the disposition of the issues that were read. */
export interface Manifest {
  /** ISO-8601 timestamp of the filter run. */
  generatedAt: string;
  /** Base branch recorded on every candidate. */
  base: string;
  /** Default agent recorded on every candidate. */
  agent: Agent;
  /** Issues ready to dispatch. */
  candidates: Candidate[];
  /** Issues skipped as blocked, covered, or non-implementation. */
  dropped: Dropped[];
  /** Issue ids with no workdir mapping (silently un-dispatchable). */
  unmapped: string[];
  /** True when the bd ready probe hit its read ceiling. */
  truncated: boolean;
}

const ManifestSchema = z.object({
  generatedAt: z.string().describe("ISO-8601 timestamp of the filter run"),
  base: z.string().describe("Base branch recorded on every candidate"),
  agent: AgentSchema.describe("Default agent recorded on every candidate"),
  candidates: z.array(CandidateSchema).describe("Issues ready to dispatch"),
  dropped: z.array(DroppedSchema).describe(
    "Issues skipped as blocked, covered, or non-implementation",
  ),
  unmapped: z.array(z.string()).describe(
    "Issue ids with no workdir mapping (silently un-dispatchable)",
  ),
  truncated: z.boolean().describe(
    "True when the bd ready probe hit its read ceiling",
  ),
});

/** The outcome of one agent dispatch. */
interface DispatchResult {
  /** Bead id when known, else null. */
  issueId: string | null;
  /** Checkout the agent ran in. */
  workdir: string;
  /** Feature branch the agent created. */
  branch: string;
  /** Base branch the feature branch was cut from. */
  base: string;
  /** Headless agent that was run. */
  agent: Agent;
  /** BEADS_ACTOR exported to the agent for double-claim protection. */
  actor: string;
  /** ISO-8601 start timestamp. */
  startedAt: string;
  /** ISO-8601 finish timestamp. */
  finishedAt: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Agent exit code. */
  exitCode: number;
  /** True when the agent exited zero. */
  success: boolean;
  /** Agent stdout. */
  stdout: string;
  /** Agent stderr, or the preflight failure. */
  stderr: string;
}

const DispatchResultSchema = z.object({
  issueId: z.string().nullable().describe("Bead id when known, else null"),
  workdir: z.string().describe("Checkout the agent ran in"),
  branch: z.string().describe("Feature branch the agent created"),
  base: z.string().describe("Base branch the feature branch was cut from"),
  agent: AgentSchema.describe("Headless agent that was run"),
  actor: z.string().describe(
    "BEADS_ACTOR exported to the agent for double-claim protection",
  ),
  startedAt: z.string().describe("ISO-8601 start timestamp"),
  finishedAt: z.string().describe("ISO-8601 finish timestamp"),
  durationMs: z.number().int().describe("Wall-clock duration in milliseconds"),
  exitCode: z.number().int().describe("Agent exit code"),
  success: z.boolean().describe("True when the agent exited zero"),
  stdout: z.string().describe("Agent stdout"),
  stderr: z.string().describe("Agent stderr, or the preflight failure"),
});

/** One row of a sweep summary. */
export interface SweepRow {
  /** Bead id. */
  id: string;
  /** Feature branch the agent created. */
  branch: string;
  /** Checkout the agent ran in. */
  workdir: string;
  /** True when the agent exited zero. */
  success: boolean;
  /** Agent exit code. */
  exitCode: number;
}

const SweepRowSchema = z.object({
  id: z.string().describe("Bead id"),
  branch: z.string().describe("Feature branch the agent created"),
  workdir: z.string().describe("Checkout the agent ran in"),
  success: z.boolean().describe("True when the agent exited zero"),
  exitCode: z.number().int().describe("Agent exit code"),
});

/** Aggregate outcome of a fan-out sweep. */
export interface SweepSummary {
  /** ISO-8601 timestamp of the sweep run. */
  sweptAt: string;
  /** Candidates in the manifest. */
  candidateCount: number;
  /** Dispatches that exited zero. */
  succeeded: number;
  /** Dispatches that did not exit zero. */
  failed: number;
  /** Per-candidate outcome. */
  results: SweepRow[];
}

const SweepSummarySchema = z.object({
  sweptAt: z.string().describe("ISO-8601 timestamp of the sweep run"),
  candidateCount: z.number().int().describe("Candidates in the manifest"),
  succeeded: z.number().int().describe("Dispatches that exited zero"),
  failed: z.number().int().describe("Dispatches that did not exit zero"),
  results: z.array(SweepRowSchema).describe("Per-candidate outcome"),
});

/** Arguments for the `filterQueue` method. */
const FilterArgsSchema = z.object({
  workdirMap: z.preprocess(
    (value) => coerceWorkdirMap(value),
    z.record(z.string(), z.string()),
  ).describe(
    "Map of issue-id prefix to local checkout path; issues with no mapping are reported, not dispatched",
  ),
  maxItems: z.number().int().min(0).default(0).describe(
    "Optional cap on candidates (0 = unlimited)",
  ),
  base: z.string().default("main").describe("Base branch for new branches"),
  agent: AgentSchema.default("kilo").describe("Default headless agent"),
  bdCommand: z.string().default("bd").describe("Path to the beads CLI"),
  bdDir: z.string().default(".").describe(
    "Project directory containing a .beads/ database",
  ),
  gitCommand: z.string().default("git").describe("Path to the git CLI"),
});

/** Arguments for the `dispatch` method. */
const DispatchArgsSchema = z.object({
  workdir: z.string().min(1).describe("Local checkout the agent runs in"),
  branch: z.string().min(1).describe("Feature branch to create"),
  task: z.string().min(1).describe("Task prompt for the agent"),
  agent: AgentSchema.default("kilo").describe("Headless agent binary to run"),
  mainBranch: z.string().default("main").describe(
    "Base branch to branch from",
  ),
  issueId: z.string().optional().describe(
    "Bead id the task belongs to, for result naming and reporting",
  ),
  gitCommand: z.string().default("git").describe("Path to the git CLI"),
});

/** Arguments for the `run` method: launch one agent process, nothing else. */
const RunArgsSchema = z.object({
  prompt: z.string().min(1).describe(
    "The task prompt handed to the agent",
  ),
  systemPrompt: z.string().default("").describe(
    "Instruction prepended to the task prompt (the run contract); empty means the task prompt alone",
  ),
  workdir: z.string().min(1).describe("Checkout the agent runs in"),
  agent: AgentSchema.default("kilo").describe("Headless agent binary to run"),
  actor: z.string().default("").describe(
    "BEADS_ACTOR exported to the agent. Empty means no actor is exported, which is right for callers that do their own bookkeeping; dispatch/sweep derive one per branch.",
  ),
});

/** Outcome of one `run` invocation. */
const RunResultSchema = z.object({
  workdir: z.string().describe("Checkout the agent ran in"),
  agent: AgentSchema.describe("Headless agent that was run"),
  binary: z.string().describe("Resolved agent binary"),
  actor: z.string().describe("BEADS_ACTOR exported, or empty"),
  startedAt: z.string().describe("ISO-8601 start timestamp"),
  finishedAt: z.string().describe("ISO-8601 finish timestamp"),
  durationMs: z.number().int().describe("Wall-clock duration in milliseconds"),
  exitCode: z.number().int().describe("Agent exit code"),
  success: z.boolean().describe("True when the agent exited zero"),
  stdout: z.string().describe("Agent stdout"),
  stderr: z.string().describe("Agent stderr"),
});

/** Arguments for the `sweep` method. */
const SweepArgsSchema = z.object({
  candidates: z.array(CandidateSchema).default([]).describe(
    "Candidates from filterQueue (wire from data.latest(...).attributes.candidates)",
  ),
  gitCommand: z.string().default("git").describe("Path to the git CLI"),
});

// ---------- pure helpers ----------------------------------------------------

/** Labels that mean a human must act before an agent can proceed. */
const DEFAULT_SKIP_LABELS = [
  "waiting-on-user",
  "blocked",
  "needs-human",
  "wontfix",
  "duplicate",
];

/**
 * Issue types that are not dispatchable work on their own.
 *
 * `spike` is investigation, not implementation. `epic` and `convoy` are
 * containers: bd returns them from `bd ready` (verified on 1.3.1, where a
 * parent epic and its child are both ready), and an agent handed one has no
 * concrete deliverable — it would invent scope. Their children are the
 * dispatchable units and are queued individually; the container closes when
 * they close.
 */
const DEFAULT_SKIP_TYPES = ["spike", "epic", "convoy"];

/** Cap on the `bd ready` probe so a truncated queue is visible, not silent. */
const BD_READY_LIMIT = 500;

/** A normalized bd issue, accepting both snake_case and camelCase bd output. */
export interface NormalizedIssue {
  /** Bead id. */
  id: string;
  /** Issue title. */
  title: string;
  /** Issue description (empty string when absent). */
  description: string;
  /** Priority 0-4. */
  priority: number;
  /** bd issue type. */
  issueType: string;
  /** Number of open dependencies blocking the issue. */
  dependencyCount: number;
  /** Labels attached to the issue. */
  labels: string[];
}

/** Normalize one `bd ready --json` record, tolerating snake_case or camelCase. */
export function normalizeBdIssue(
  raw: Record<string, unknown>,
): NormalizedIssue {
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map((label) => String(label))
    : [];
  return {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? ""),
    description: typeof raw.description === "string" ? raw.description : "",
    priority: Number(raw.priority ?? 2),
    issueType: String(raw.issue_type ?? raw.issueType ?? "task"),
    dependencyCount: Number(raw.dependency_count ?? raw.dependencyCount ?? 0),
    labels,
  };
}

/** Why an issue must not be dispatched, or null when it is actionable. */
export function skipReason(
  issue: NormalizedIssue,
  opts: { skipLabels?: string[]; skipTypes?: string[] } = {},
): string | null {
  const skipLabels = opts.skipLabels ?? DEFAULT_SKIP_LABELS;
  const skipTypes = opts.skipTypes ?? DEFAULT_SKIP_TYPES;
  for (const label of issue.labels) {
    const lower = label.toLowerCase();
    const hit = skipLabels.find((token) => lower.includes(token.toLowerCase()));
    if (hit) return `label:${hit}`;
  }
  if (skipTypes.includes(issue.issueType)) return `type:${issue.issueType}`;
  if (issue.dependencyCount > 0) return "blocked-by-dependencies";
  return null;
}

/** Pick the checkout for an issue by longest matching prefix; null if none. */
export function matchWorkdir(
  issueId: string,
  workdirMap: Record<string, string>,
): string | null {
  let best: string | null = null;
  let bestLength = -1;
  for (const [prefix, workdir] of Object.entries(workdirMap)) {
    if (issueId.startsWith(prefix) && prefix.length > bestLength) {
      best = workdir;
      bestLength = prefix.length;
    }
  }
  return best;
}

/** Coerce a workdir map supplied as an object or a JSON string into an object. */
export function coerceWorkdirMap(value: unknown): Record<string, string> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(
        "workdirMap must be an object mapping issue-id prefix to checkout path",
      );
    }
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const out: Record<string, string> = {};
    for (
      const [key, val] of Object.entries(parsed as Record<string, unknown>)
    ) {
      out[key] = String(val);
    }
    return out;
  }
  throw new Error(
    "workdirMap must be an object mapping issue-id prefix to checkout path",
  );
}

/** Repo-scoped, slash-safe branch name for an issue. */
export function branchNameFor(issueId: string): string {
  return `bd/${issueId.replace(/\//g, "-")}`;
}

/** The per-dispatch bd actor, `<agent>-<branch>` with slashes flattened. */
export function actorFor(agent: string, branch: string): string {
  return `${agent}-${branch.replace(/\//g, "-")}`;
}

/** Make an arbitrary string safe as a data instance name. */
export function sanitizeInstanceName(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

/** Build the agent task prompt for a ready issue. */
export function buildTaskPrompt(
  issue: { id: string; title: string; description: string },
  workdir: string,
  base: string,
): string {
  return `Work on bd issue ${issue.id}: ${issue.title}\n\n` +
    `${issue.description}\n\n` +
    `Context: this is a swamp automation repo. Use \`bd show ${issue.id}\` ` +
    `for full detail. When done, commit, push to origin on this branch, ` +
    `and open a PR against ${workdir}'s ${base} branch. Run the repo's ` +
    `quality gates (deno check / swamp model validate) before shipping.`;
}

/**
 * Runtime instruction the agent runs under. It lives only in the dispatched
 * process, never written into the target repo, so the target's own `AGENTS.md`
 * stays authoritative.
 */
export function runnerInstruction(candidate: {
  workdir: string;
  branch: string;
  base: string;
}): string {
  return `You are working in ${candidate.workdir} on branch ${candidate.branch}, branched from ${candidate.base} of
the fork \`origin\` (upstream is \`upstream\`). Do the requested task, then:
commit your changes with a clear conventional message, push to \`origin\` on
\`${candidate.branch}\`, and open a pull request against ${candidate.base} with \`gh pr create\`
describing the change. Follow this repo's own AGENTS.md conventions. If you
cannot open a PR (e.g. CI failures you cannot fix), stop and report.

Only act on ${candidate.workdir} — do not touch swamp's control-plane repo.`;
}

/** The binary and argument vector for one headless-agent invocation. */
export interface AgentInvocation {
  /** The agent binary to execute. */
  binary: string;
  /** Arguments to pass to the agent binary. */
  args: string[];
}

/**
 * Build the headless-agent command for one of the supported binaries. The
 * invocations mirror the retired `.kilo/agents/run-task.sh` reference driver:
 * claude/codex take the whole prompt positionally, opencode takes the task as
 * its argument and the instruction as `--system-prompt`, and kilo gets the
 * prompt after `--`.
 */
export function buildAgentInvocation(
  agent: Agent,
  opts: { prompt: string; systemPrompt: string; workingDir: string },
): AgentInvocation {
  const full = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n${opts.prompt}`
    : opts.prompt;
  switch (agent) {
    case "claude":
      return {
        binary: "claude",
        args: ["-p", "--dangerously-skip-permissions", full],
      };
    case "codex":
      return {
        binary: "codex",
        args: ["exec", "--dangerously-bypass-approvals-and-sandbox", full],
      };
    case "opencode":
      return {
        binary: "opencode",
        args: [opts.prompt, `--system-prompt=${opts.systemPrompt}`],
      };
    case "kilo":
    default:
      return {
        binary: "kilo",
        args: ["run", "--auto", "--dir", opts.workingDir, "--", full],
      };
  }
}

/** Render a filtered queue as a markdown report. */
export function renderManifestReport(manifest: Manifest): string {
  const lines: string[] = [
    "# bd ready queue",
    "",
    `Generated: ${manifest.generatedAt}`,
    `Base: ${manifest.base} · Agent: ${manifest.agent}`,
    "",
    `- Candidates: ${manifest.candidates.length}`,
    `- Dropped: ${manifest.dropped.length}`,
    `- Unmapped: ${manifest.unmapped.length}`,
  ];
  if (manifest.truncated) {
    lines.push(
      `- Warning: the bd ready probe reached its ${BD_READY_LIMIT}-issue ceiling`,
    );
  }
  lines.push("", "## Candidates", "");
  if (manifest.candidates.length === 0) {
    lines.push("_None._");
  } else {
    lines.push("| Issue | Priority | Type | Workdir | Branch |");
    lines.push("| ----- | -------- | ---- | ------- | ------ |");
    for (const c of manifest.candidates) {
      lines.push(
        `| ${c.id} | ${c.priority} | ${c.issueType} | \`${c.workdir}\` | \`${c.branch}\` |`,
      );
    }
  }
  if (manifest.dropped.length > 0) {
    lines.push("", "## Dropped", "");
    for (const d of manifest.dropped) lines.push(`- ${d.id} — ${d.reason}`);
  }
  if (manifest.unmapped.length > 0) {
    lines.push(
      "",
      "## Unmapped",
      "",
      manifest.unmapped.map((id) => `\`${id}\``).join(", "),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Render a sweep as a markdown report. */
export function renderSweepReport(summary: SweepSummary): string {
  const lines: string[] = [
    "# Agent dispatch sweep",
    "",
    `Swept: ${summary.sweptAt}`,
    "",
    `- Candidates: ${summary.candidateCount}`,
    `- Succeeded: ${summary.succeeded}`,
    `- Failed: ${summary.failed}`,
    "",
    "## Results",
    "",
  ];
  if (summary.results.length === 0) {
    lines.push("_Nothing to dispatch._");
  } else {
    lines.push("| Issue | Branch | Workdir | Result | Exit |");
    lines.push("| ----- | ------ | ------- | ------ | ---- |");
    for (const r of summary.results) {
      lines.push(
        `| ${r.id} | \`${r.branch}\` | \`${r.workdir}\` | ${
          r.success ? "ok" : "failed"
        } | ${r.exitCode} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

// ---------- subprocess helpers ---------------------------------------------

/** Result of a subprocess invocation. */
interface RunResult {
  code: number;
  success: boolean;
  stdout: string;
  stderr: string;
}

const decoder = new TextDecoder();

async function runCommand(
  binary: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<RunResult> {
  try {
    // swamp-quality-ignore deno-command: git, bd, and the agent CLIs are the dispatch contract.
    const command = new Deno.Command(binary, {
      args,
      cwd: opts.cwd,
      env: opts.env,
      stdout: "piped",
      stderr: "piped",
      signal: opts.signal,
    });
    const output = await command.output();
    return {
      code: output.code,
      success: output.success,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return {
        code: 127,
        success: false,
        stdout: "",
        stderr: `${binary}: command not found`,
      };
    }
    throw err;
  }
}

/** Run a bd command and return its stdout, throwing a diagnostic on failure. */
async function runBd(
  bdCommand: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<RunResult> {
  const result = await runCommand(bdCommand, args, { cwd, signal });
  if (!result.success) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(
      0,
      2000,
    );
    throw new Error(
      `bd ${args.join(" ")} failed (exit ${result.code}): ${detail}`,
    );
  }
  return result;
}

interface GitContext {
  gitCommand: string;
  workdir: string;
  signal?: AbortSignal;
}

async function git(
  ctx: GitContext,
  args: string[],
): Promise<RunResult> {
  return await runCommand(ctx.gitCommand, args, {
    cwd: ctx.workdir,
    signal: ctx.signal,
  });
}

async function gitStrict(ctx: GitContext, args: string[]): Promise<RunResult> {
  const result = await git(ctx, args);
  if (!result.success) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(
      0,
      2000,
    );
    throw new Error(
      `git ${args.join(" ")} failed (exit ${result.code}): ${detail}`,
    );
  }
  return result;
}

/**
 * True when a local or remote branch named `branch` already exists. Returns a
 * human-readable reason, or null when the branch is free. A missing `git`
 * binary skips the guard rather than failing the whole queue.
 */
async function branchConflict(
  gitCommand: string,
  workdir: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const ctx: GitContext = { gitCommand, workdir, signal };
  const local = await git(ctx, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (local.code === 0) return `branch ${branch} already exists locally`;
  if (local.code === 127) return null;
  const remote = await git(ctx, [
    "ls-remote",
    "--exit-code",
    "--heads",
    "origin",
    branch,
  ]);
  if (remote.code === 0) return `branch ${branch} already exists on origin`;
  if (remote.code === 127) return null;
  return null;
}

// ---------- dispatch core ---------------------------------------------------

interface Logger {
  info: (msg: string, props?: Record<string, unknown>) => void;
  warn: (msg: string, props?: Record<string, unknown>) => void;
  error: (msg: string, props?: Record<string, unknown>) => void;
}

interface DispatchDeps {
  gitCommand: string;
  signal?: AbortSignal;
  traceHeaders?: Readonly<Record<string, string>>;
  logger: Logger;
}

/** Reset the checkout onto a fresh branch, preflighting every destructive step. */
async function setupBranch(
  candidate: Candidate,
  deps: DispatchDeps,
): Promise<void> {
  const ctx: GitContext = {
    gitCommand: deps.gitCommand,
    workdir: candidate.workdir,
    signal: deps.signal,
  };

  const inside = await git(ctx, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.success || inside.stdout.trim() !== "true") {
    throw new Error(`Not a git checkout: ${candidate.workdir}`);
  }
  const remote = await git(ctx, ["remote", "get-url", "origin"]);
  if (!remote.success) {
    throw new Error(`No 'origin' remote in ${candidate.workdir}`);
  }
  const status = await git(ctx, ["status", "--porcelain"]);
  if (!status.success) {
    throw new Error(
      `Could not read git status in ${candidate.workdir}: ${status.stderr.trim()}`,
    );
  }
  if (status.stdout.trim() !== "") {
    throw new Error(
      `Refusing to run: ${candidate.workdir} has uncommitted changes`,
    );
  }
  const local = await git(ctx, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${candidate.branch}`,
  ]);
  if (local.code === 0) {
    throw new Error(
      `Local branch '${candidate.branch}' already exists in ${candidate.workdir}; refusing to reset it`,
    );
  }
  const remoteBranch = await git(ctx, [
    "ls-remote",
    "--exit-code",
    "--heads",
    "origin",
    candidate.branch,
  ]);
  if (remoteBranch.code === 0) {
    throw new Error(
      `Branch '${candidate.branch}' already exists on origin; refusing to reset it`,
    );
  }

  await gitStrict(ctx, ["fetch", "origin"]);
  await gitStrict(ctx, ["checkout", candidate.base]);
  await gitStrict(ctx, ["reset", "--hard", `origin/${candidate.base}`]);
  await gitStrict(ctx, ["checkout", "-b", candidate.branch]);
}

/** Run one agent dispatch, returning a result even when preflight fails. */
async function dispatchOne(
  candidate: Candidate,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const startedAt = new Date().toISOString();
  const actor = actorFor(candidate.agent, candidate.branch);
  let stdout = "";
  let stderr = "";
  let exitCode = 1;
  let success = false;

  try {
    if (candidate.branch === candidate.base) {
      throw new Error(
        `branch must differ from base (both are '${candidate.base}')`,
      );
    }
    deps.logger.info("Dispatching {agent} on {branch} in {workdir}", {
      agent: candidate.agent,
      branch: candidate.branch,
      workdir: candidate.workdir,
    });
    await setupBranch(candidate, deps);

    const result = await runAgentProcess({
      prompt: candidate.task,
      systemPrompt: runnerInstruction(candidate),
      workdir: candidate.workdir,
      agent: candidate.agent,
      actor,
    }, deps);
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode;
    success = result.success;
    if (!success) {
      deps.logger.error("Agent {agent} exited {code} on {branch}", {
        agent: candidate.agent,
        code: result.exitCode,
        branch: candidate.branch,
        stderr: stderr.slice(0, 2000),
      });
    }
  } catch (err) {
    stderr = err instanceof Error ? err.message : String(err);
    deps.logger.error("Dispatch failed on {branch}: {error}", {
      branch: candidate.branch,
      error: stderr,
    });
  }

  const finishedAt = new Date().toISOString();
  return {
    issueId: candidate.id || null,
    workdir: candidate.workdir,
    branch: candidate.branch,
    base: candidate.base,
    agent: candidate.agent,
    actor,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    exitCode,
    success,
    stdout,
    stderr,
  };
}

/**
 * Launch one headless agent. This is the runner primitive: no git, no plan, no
 * bookkeeping beyond the process itself. `dispatch` branches and then calls it;
 * `sweep` calls it per candidate; another extension calls it through
 * `runModel` when it wants an agent but owns its own git workflow.
 *
 * A non-zero exit is reported in the result, never thrown: the caller decides
 * whether an agent that failed is fatal (dispatch does) or one row of a sweep.
 */
async function run(
  args: z.infer<typeof RunArgsSchema>,
  ctx: {
    writeResource: (
      spec: string,
      instance: string,
      data: Record<string, unknown>,
    ) => Promise<{ name: string }>;
    signal: AbortSignal;
    traceHeaders?: Readonly<Record<string, string>>;
    logger: Logger;
  },
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const parsed = RunArgsSchema.parse(args);
  const result = await runAgentProcess(parsed, {
    signal: ctx.signal,
    traceHeaders: ctx.traceHeaders,
    logger: ctx.logger,
  });
  const instance = `run-${sanitizeInstanceName(parsed.actor || parsed.agent)}`;
  const handle = await ctx.writeResource("run", instance, { ...result });
  return { dataHandles: [handle] };
}

/**
 * The process-level half of a dispatch: build the invocation, export the actor
 * and trace context, run it, capture the streams. Shared by `run` and by
 * `dispatchOne` so an ad-hoc run and a dispatched one cannot drift apart.
 */
async function runAgentProcess(
  args: z.infer<typeof RunArgsSchema>,
  deps: {
    signal?: AbortSignal;
    traceHeaders?: Readonly<Record<string, string>>;
    logger: Logger;
  },
): Promise<z.infer<typeof RunResultSchema>> {
  const startedAt = new Date().toISOString();
  const { binary, args: argv } = buildAgentInvocation(args.agent, {
    prompt: args.prompt,
    systemPrompt: args.systemPrompt,
    workingDir: args.workdir,
  });

  const env: Record<string, string> = {};
  if (args.actor) env.BEADS_ACTOR = args.actor;
  if (deps.traceHeaders?.traceparent) {
    env.TRACEPARENT = deps.traceHeaders.traceparent;
  }
  if (deps.traceHeaders?.tracestate) {
    env.TRACESTATE = deps.traceHeaders.tracestate;
  }

  deps.logger.info("Running {binary} in {workdir}", {
    binary,
    workdir: args.workdir,
  });
  const result = await runCommand(binary, argv, {
    cwd: args.workdir,
    env: Object.keys(env).length > 0 ? env : undefined,
    signal: deps.signal,
  });
  if (!result.success) {
    deps.logger.error("{binary} exited {code}", {
      binary,
      code: result.code,
      stderr: result.stderr.slice(0, 2000),
    });
  }

  const finishedAt = new Date().toISOString();
  return {
    workdir: args.workdir,
    agent: args.agent,
    binary,
    actor: args.actor,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    exitCode: result.code,
    success: result.success,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** A candidate derived from ad-hoc `dispatch` arguments. */
function candidateFromArgs(
  args: z.infer<typeof DispatchArgsSchema>,
): Candidate {
  return {
    id: args.issueId ?? "",
    title: "",
    priority: 2,
    issueType: "task",
    workdir: args.workdir,
    branch: args.branch,
    base: args.mainBranch,
    agent: args.agent,
    task: args.task,
  };
}

// ---------- methods ---------------------------------------------------------

async function filterQueue(
  args: z.infer<typeof FilterArgsSchema>,
  ctx: {
    writeResource: (
      spec: string,
      instance: string,
      data: Record<string, unknown>,
    ) => Promise<{ name: string }>;
    createFileWriter: (
      spec: string,
      instance: string,
    ) => { writeText: (text: string) => Promise<{ name: string }> };
    signal: AbortSignal;
    logger: Logger;
  },
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const parsed = FilterArgsSchema.parse(args);
  ctx.logger.info("Filtering the bd ready queue in {bdDir}", {
    bdDir: parsed.bdDir,
  });
  const { stdout } = await runBd(
    parsed.bdCommand,
    ["ready", "--json", "--limit", String(BD_READY_LIMIT)],
    parsed.bdDir,
    ctx.signal,
  );

  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error("bd ready --json did not return valid JSON");
  }
  if (!Array.isArray(raw)) {
    throw new Error("bd ready --json did not return an array");
  }
  const issues = (raw as Record<string, unknown>[]).map(normalizeBdIssue);
  const truncated = issues.length >= BD_READY_LIMIT;

  const candidates: Candidate[] = [];
  const dropped: Array<{ id: string; reason: string }> = [];
  const unmapped: string[] = [];

  for (const issue of issues) {
    const reason = skipReason(issue);
    if (reason) {
      dropped.push({ id: issue.id, reason });
      continue;
    }
    const workdir = matchWorkdir(issue.id, parsed.workdirMap);
    if (!workdir) {
      unmapped.push(issue.id);
      continue;
    }
    const branch = branchNameFor(issue.id);
    const conflict = await branchConflict(
      parsed.gitCommand,
      workdir,
      branch,
      ctx.signal,
    );
    if (conflict) {
      dropped.push({ id: issue.id, reason: conflict });
      continue;
    }
    candidates.push({
      id: issue.id,
      title: issue.title,
      priority: issue.priority,
      issueType: issue.issueType,
      workdir,
      branch,
      base: parsed.base,
      agent: parsed.agent,
      task: buildTaskPrompt(issue, workdir, parsed.base),
    });
  }

  const capped = parsed.maxItems > 0
    ? candidates.slice(0, parsed.maxItems)
    : candidates;
  for (const extra of candidates.slice(capped.length)) {
    dropped.push({
      id: extra.id,
      reason: `capped by maxItems=${parsed.maxItems}`,
    });
  }

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    base: parsed.base,
    agent: parsed.agent,
    candidates: capped,
    dropped,
    unmapped,
    truncated: truncated || capped.length < candidates.length,
  };

  const report = renderManifestReport(manifest);
  const manifestHandle = await ctx.writeResource("manifest", "manifest", {
    ...manifest,
  });
  const reportHandle = await ctx.createFileWriter("report", "report-manifest")
    .writeText(report);

  if (unmapped.length > 0) {
    ctx.logger.warn(
      "Dropped {count} ready issue(s) with no workdir mapping: {ids}",
      { count: unmapped.length, ids: unmapped.join(", ") },
    );
  }
  ctx.logger.info(
    "bd ready queue filtered: {candidates} candidate(s), {dropped} dropped",
    { candidates: capped.length, dropped: dropped.length },
  );
  return { dataHandles: [manifestHandle, reportHandle] };
}

async function dispatch(
  args: z.infer<typeof DispatchArgsSchema>,
  ctx: {
    writeResource: (
      spec: string,
      instance: string,
      data: Record<string, unknown>,
    ) => Promise<{ name: string }>;
    signal: AbortSignal;
    traceHeaders?: Readonly<Record<string, string>>;
    logger: Logger;
  },
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const parsed = DispatchArgsSchema.parse(args);
  const candidate = candidateFromArgs(parsed);
  const deps: DispatchDeps = {
    gitCommand: parsed.gitCommand,
    signal: ctx.signal,
    traceHeaders: ctx.traceHeaders,
    logger: ctx.logger,
  };
  const result = await dispatchOne(candidate, deps);
  const instance = `dispatch-${
    sanitizeInstanceName(parsed.issueId ?? parsed.branch)
  }`;
  const handle = await ctx.writeResource("dispatch", instance, { ...result });
  if (!result.success) {
    throw new Error(
      `Agent dispatch failed (exit ${result.exitCode}) on ${parsed.branch}: ${
        result.stderr.trim().slice(0, 2000)
      }`,
    );
  }
  return { dataHandles: [handle] };
}

async function sweep(
  args: z.infer<typeof SweepArgsSchema>,
  ctx: {
    writeResource: (
      spec: string,
      instance: string,
      data: Record<string, unknown>,
    ) => Promise<{ name: string }>;
    createFileWriter: (
      spec: string,
      instance: string,
    ) => { writeText: (text: string) => Promise<{ name: string }> };
    signal: AbortSignal;
    traceHeaders?: Readonly<Record<string, string>>;
    logger: Logger;
  },
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const parsed = SweepArgsSchema.parse(args);
  const deps: DispatchDeps = {
    gitCommand: parsed.gitCommand,
    signal: ctx.signal,
    traceHeaders: ctx.traceHeaders,
    logger: ctx.logger,
  };

  // Iterations are serialized on purpose: setupBranch force-resets the
  // checkout, so parallel dispatch against the same workdir would race.
  const handles: Array<{ name: string }> = [];
  const rows: SweepSummary["results"] = [];
  let succeeded = 0;
  let failed = 0;

  for (const candidate of parsed.candidates) {
    const result = await dispatchOne(candidate, deps);
    const instance = `dispatch-${
      sanitizeInstanceName(candidate.id || candidate.branch)
    }`;
    handles.push(
      await ctx.writeResource("dispatch", instance, { ...result }),
    );
    if (result.success) succeeded++;
    else failed++;
    rows.push({
      id: candidate.id || candidate.branch,
      branch: candidate.branch,
      workdir: candidate.workdir,
      success: result.success,
      exitCode: result.exitCode,
    });
  }

  const summary: SweepSummary = {
    sweptAt: new Date().toISOString(),
    candidateCount: parsed.candidates.length,
    succeeded,
    failed,
    results: rows,
  };
  const summaryHandle = await ctx.writeResource("sweep", "sweep", {
    ...summary,
  });
  const reportHandle = await ctx.createFileWriter("report", "report-sweep")
    .writeText(renderSweepReport(summary));

  ctx.logger.info(
    "Sweep dispatched {count} candidate(s): {ok} ok, {bad} failed",
    {
      count: summary.candidateCount,
      ok: succeeded,
      bad: failed,
    },
  );
  return { dataHandles: [summaryHandle, reportHandle, ...handles] };
}

// ---------- behavior definition ---------------------------------------------

/** Swamp behavior definition for agent task dispatch. */
export const model = {
  type: "@maphew/agent-task",
  version: "2026.10.21.1",
  globalArguments: z.object({}),
  upgrades: [
    {
      toVersion: "2026.10.15.1",
      description:
        "Initial release: filterQueue / dispatch / sweep methods extracted from .kilo/agents ready-queue.sh, run-task.sh, and bd-sweep.sh",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.18.1",
      description:
        "Add the `run` runner primitive (one agent process, no git) and route dispatch through it; other extensions call `run` via runModel instead of copying buildAgentInvocation",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.21.1",
      description:
        "Treat container issue types (epic, convoy) as non-dispatchable: bd ready returns them, and an agent handed one has no concrete deliverable. Their children stay dispatchable and are queued individually; no schema or resource changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  checks: {
    "git-usable": {
      description: "Verify the git CLI resolves before a dispatch runs",
      labels: ["dependency"],
      execute: async () => {
        const result = await runCommand("git", ["--version"]);
        if (!result.success) {
          return {
            pass: false,
            errors: [
              "The git CLI is not runnable. Install git or fix PATH before dispatching.",
            ],
          };
        }
        return { pass: true };
      },
    },
  },
  resources: {
    run: {
      description: "Outcome of one raw agent invocation (`run`)",
      schema: RunResultSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    manifest: {
      description: "Filtered bd ready queue of dispatch candidates",
      schema: ManifestSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    dispatch: {
      description: "Outcome of one headless-agent dispatch",
      schema: DispatchResultSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    sweep: {
      description: "Aggregate outcome of a fan-out agent sweep",
      schema: SweepSummarySchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },
  files: {
    report: {
      description: "Markdown dispatch report",
      contentType: "text/markdown",
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    filterQueue: {
      description:
        "Filter the bd ready queue into a typed dispatch manifest, dropping blocked, non-implementation, and branch-covered issues",
      arguments: FilterArgsSchema,
      execute: filterQueue,
    },
    dispatch: {
      description:
        "Branch a target checkout and run one headless agent on a task",
      arguments: DispatchArgsSchema,
      execute: dispatch,
    },
    sweep: {
      description:
        "Dispatch every candidate in a manifest serially under one behavior lock",
      arguments: SweepArgsSchema,
      execute: sweep,
    },
    run: {
      description:
        "Run one headless agent on a prompt in a checkout, and nothing else: no branching, no source control, no plan. The runner primitive other extensions call through `runModel` when they own their own git workflow.",
      arguments: RunArgsSchema,
      execute: run,
    },
  },
};
