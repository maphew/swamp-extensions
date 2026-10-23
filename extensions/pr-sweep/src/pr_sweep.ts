/**
 * PR sweep — adversarially review, update, and merge open pull requests that a
 * fork contributes to an upstream GitHub repository.
 *
 * Composable steps, orchestrated by whoever runs the sweep (Ceph, a foreman
 * agent, a human, or a scheduled workflow). Each step reads its targets from
 * written data when its argument is omitted, so steps chain without anyone
 * passing handles around:
 *
 *   - `list`   — open PRs from the fork → `open-prs-current` + one `pr-spec`
 *                resource per PR (the queue of work).
 *   - `review` — one headless agent reviews a batch of PRs (default: every
 *                listed PR) with the bundled sweeper prompt, then records each
 *                verdict on its `pr` resource. Small batches only: the
 *                orchestrator splits a long list into review batches.
 *   - `sync`   — deterministic git branch-sync pass (+ bounded verify/top-up)
 *                for listed or explicitly named PRs; no agent involved.
 *   - `verdicts` / `summary` — read back what happened, as data.
 *
 * `sweep` remains as the monolithic convenience (list → one agent over all
 * PRs → sync → summary) for scheduled workflows that want one call, but new
 * orchestration should compose the steps. The orchestrator owns how PRs group
 * into review batches and when sync runs; the behavior only does the work it
 * is told to do.
 *
 * The sweeper prompt is bundled with the extension (`prompts/pr-sweeper.md`) so
 * the model is self-contained; a repo-local prompt can override it via
 * `sweeperPrompt` or the legacy `<swampRepoDir>/.kilo/agents/pr-sweeper.md`.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Headless agents a sweep can run. */
export const AGENT_NAMES = ["claude", "codex", "opencode", "kilo"] as const;
export type AgentName = typeof AGENT_NAMES[number];

/**
 * Probe one executable and return its exit code, or `null` when the binary is
 * not on PATH. Injected in tests so the preflight is testable without the real
 * tools installed.
 */
export type ToolProbe = (tool: string) => Promise<number | null>;

/** Default probe: run `<tool> --version` and read the exit code. */
export const probeTool: ToolProbe = async (tool) => {
  try {
    const output = await new Deno.Command(tool, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return output.code;
  } catch (error) {
    // NotFound is the only answer that means "binary missing"; a permission or
    // cwd failure means the binary is there but unusable, which is a different
    // (and later) error.
    if (error instanceof Deno.errors.NotFound) return null;
    return 0;
  }
};

/**
 * Fail fast, naming the tool, when a binary the sweep shells out to is absent.
 * A non-zero `--version` exit still means the binary exists.
 */
export async function checkToolAvailable(
  tool: string,
  probe: ToolProbe = probeTool,
): Promise<void> {
  if ((await probe(tool)) === null) {
    throw new Error(
      `pr-sweep requires '${tool}' but it was not found on PATH; install it or fix PATH before sweeping`,
    );
  }
}

/**
 * Verify the binaries a step depends on before it starts work: `git` and `gh`
 * always, plus the selected headless agent when the step will run one. Keeps a
 * missing tool from surfacing later as an opaque subprocess exit.
 */
export async function preflightTools(
  deps: { agent?: AgentName; needsAgent?: boolean },
  ctx: {
    logger: { info: (msg: string, props?: Record<string, unknown>) => void };
  },
  probe: ToolProbe = probeTool,
): Promise<string[]> {
  const tools = ["git", "gh"];
  if (deps.needsAgent) tools.push(deps.agent ?? "kilo");
  for (const tool of tools) await checkToolAvailable(tool, probe);
  ctx.logger.info("pr-sweep tool preflight passed", { tools });
  return tools;
}

/** How a behind branch is brought up to date. */
export const UPDATE_STRATEGIES = ["merge", "rebase"] as const;
export type UpdateStrategy = typeof UPDATE_STRATEGIES[number];

const RepoSchema = z.object({
  upstreamRepo: z.string().describe(
    "Upstream GitHub repo as owner/name (e.g. Kilo-Org/kilocode)",
  ),
  forkRepo: z.string().describe(
    "Fork GitHub repo as owner/name (e.g. maphew/kilocode)",
  ),
  workdir: z.string().describe(
    "Local checkout directory for the upstream repo",
  ),
  agent: z.enum(AGENT_NAMES).default("kilo").describe(
    "Headless agent to run the sweep",
  ),
  model: z.string().default("").describe(
    "Model for the agent in provider/model form; empty uses the agent's default",
  ),
  mainBranch: z.string().default("main").describe(
    "Base branch to rebase and merge into",
  ),
  swampRepoDir: z.string().optional().describe(
    "Path to the swamp repo that owns this workflow. Optional: only used to find a legacy `<swampRepoDir>/.kilo/agents/pr-sweeper.md` prompt override; the bundled prompt is used otherwise.",
  ),
  sweeperPrompt: z.string().optional().describe(
    "Absolute path to a custom sweeper prompt file. Overrides both the bundled prompt and the legacy `<swampRepoDir>/.kilo/agents/pr-sweeper.md` lookup.",
  ),
  resyncBehind: z.boolean().default(true).describe(
    "After the agent run, re-fetch the base branch and bring any behind PR branch up to date",
  ),
  updateStrategy: z.enum(UPDATE_STRATEGIES).default("merge").describe(
    "How to update a behind branch: merge the base in (no force-push) or rebase onto it (force-push)",
  ),
});

const SweepSummarySchema = z.object({
  upstreamRepo: z.string(),
  forkRepo: z.string(),
  sweptAt: z.string().datetime(),
  prCount: z.number(),
  mergedCount: z.number(),
  skippedCount: z.number(),
  failedCount: z.number(),
  pendingCount: z.number().optional().describe(
    "Listed PRs with no verdict yet",
  ),
  report: z.string().optional(),
  truncated: z.boolean().optional(),
});

const PrResultSchema = z.object({
  number: z.number(),
  title: z.string(),
  /** Set once a review batch has recorded this PR's outcome. */
  verdict: z.string().default("pending"),
  upstreamRepo: z.string().optional(),
  forkRepo: z.string().optional(),
  headRefName: z.string().optional(),
  baseRefName: z.string().optional(),
  reviewedAt: z.string().optional(),
  merged: z.boolean().optional(),
  reason: z.string().optional(),
  state: z.string().optional(),
  mergeStateStatus: z.string().optional(),
  syncStatus: z.string().optional(),
  syncDetail: z.string().optional(),
});

type Repo = z.infer<typeof RepoSchema>;
type SweepSummary = z.infer<typeof SweepSummarySchema>;
type PrResult = z.infer<typeof PrResultSchema>;

/**
 * Per-run settings shared by every step. Defaults match the RepoSchema
 * defaults so a step whose arguments omit them behaves identically.
 */
type RunSettings = {
  agent: AgentName;
  model: string;
  mainBranch: string;
  swampRepoDir?: string;
  sweeperPrompt?: string;
  updateStrategy: UpdateStrategy;
};

/** What the branch-sync pass needs from a PR: its head and base branches. */
export type SyncTarget = {
  number: number;
  headRefName: string;
  baseRefName: string;
};

/**
 * The fields the deterministic branch-sync pass needs. A composable step
 * builds it from its own arguments plus the resolved workdir, so sync does not
 * require a full monolithic `sweep` argument set.
 */
export type SyncRepo = {
  upstreamRepo: string;
  forkRepo: string;
  workdir: string;
  agent: AgentName;
  mainBranch: string;
  updateStrategy: UpdateStrategy;
  swampRepoDir?: string;
  sweeperPrompt?: string;
};

/** One listed PR carried in `open-prs-current`. */
export type ListedPr = {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
};

/** The `open-prs` resource instance `open-prs-current`. */
export const OpenPrsSchema = z.object({
  upstreamRepo: z.string(),
  forkRepo: z.string(),
  listedAt: z.string(),
  prs: z.array(
    z.object({
      number: z.number(),
      title: z.string(),
      headRefName: z.string(),
      baseRefName: z.string(),
    }),
  ),
  truncated: z.boolean(),
});
export type OpenPrsRecord = z.infer<typeof OpenPrsSchema>;

/**
 * Normalize step arguments into full per-run settings plus the repo pair.
 * Shared by every composable step so their defaults cannot drift apart.
 */
export function normalizeRun(input: StepArgsInput): {
  repo: { upstreamRepo: string; forkRepo: string };
  settings: RunSettings;
} {
  const args = { ...input, batchSize: input.batchSize ?? 0 };
  if (!args.upstreamRepo?.trim() || !args.forkRepo?.trim()) {
    throw new Error(
      "this step needs upstreamRepo and forkRepo (or run list first so open-prs-current can supply them)",
    );
  }
  return {
    repo: {
      upstreamRepo: args.upstreamRepo!.trim(),
      forkRepo: args.forkRepo!.trim(),
    },
    settings: {
      agent: args.agent ?? "kilo",
      model: args.model ?? "",
      mainBranch: args.mainBranch ?? "main",
      swampRepoDir: args.swampRepoDir,
      sweeperPrompt: args.sweeperPrompt,
      updateStrategy: args.updateStrategy ?? "merge",
    },
  };
}

/**
 * Split a PR list into review batches of at most `batchSize` (0 = one batch,
 * the whole list). An orchestrator uses this to decide how many agents to
 * spawn; the behavior never decides for itself.
 */
export function planReviewBatches(
  prs: Array<{ number: number }>,
  batchSize: number,
): number[][] {
  if (prs.length === 0) return [];
  if (batchSize <= 0) return [prs.map((pr) => pr.number)];
  const batches: number[][] = [];
  for (let i = 0; i < prs.length; i += batchSize) {
    batches.push(prs.slice(i, i + batchSize).map((pr) => pr.number));
  }
  return batches;
}

/**
 * `gh pr list` defaults to the 30 most-recent PRs. Busy upstreams (Kilo-Org
 * repos routinely carry >100 open PRs) push an older fork's PRs past that
 * window, so a sweep that omits --limit silently under-counts and can report
 * "nothing to sweep" while fork PRs are open. Fetch a high ceiling instead.
 */
export const GH_PR_LIST_LIMIT = 1000;

/**
 * Where the agent runner lives: `@maphew/agent-task`'s `run` method. pr-sweep
 * depends on that extension (manifest `dependencies`) so the call is allowed.
 */
export const AGENT_TASK_TYPE = "@maphew/agent-task";
export const AGENT_TASK_INSTANCE = "agent-task-queue";

/** Path of the sweeper prompt bundled with the extension (see `additionalFiles`). */
export const BUNDLED_SWEEPER_PROMPT = "prompts/pr-sweeper.md";

/**
 * How a review batch reports findings. The contract is written per PR, not
 * once for the batch, so a batch's results always land on the machine-readable
 * line shape regardless of how many PRs one agent handled.
 */
export function batchContractInstruction(batch: number[]): string {
  return [
    "Batch scope (required).",
    `This review batch covers exactly these ${batch.length} pull request(s): ${
      batch.map((n) => `#${n}`).join(", ")
    }. Report one verdict line per PR in the batch — no more, no less — even when several PRs share a finding.`,
  ].join("\n");
}

/**
 * Choose the sweeper prompt file. An explicit `sweeperPrompt` wins; else a
 * legacy repo-local `.kilo/agents/pr-sweeper.md` is used when it exists; else
 * the prompt bundled with the extension. Pure and injectable so the fallback
 * order is unit-testable without touching the filesystem.
 */
export function resolveSweeperPromptPath(
  repo: { sweeperPrompt?: string; swampRepoDir?: string },
  opts: { bundled: string; exists: (path: string) => boolean },
): string {
  if (repo.sweeperPrompt) return repo.sweeperPrompt;
  if (repo.swampRepoDir) {
    const legacy = `${repo.swampRepoDir}/.kilo/agents/pr-sweeper.md`;
    if (opts.exists(legacy)) return legacy;
  }
  return opts.bundled;
}

/** An open pull request as returned by `gh pr list`. */
export type OpenPr = {
  number: number;
  title: string;
  headRepository: { nameWithOwner: string } | null;
  headRefName: string;
  baseRefName: string;
};

/** A git remote name paired with its URL. */
export type Remote = { name: string; url: string };

/** Extract `owner/name` from a git remote URL; null for local paths. */
export function parseRemoteRepo(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (/^[./]/.test(trimmed)) return null;
  const scp = trimmed.match(/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:(.+)$/);
  let path: string | null = null;
  if (scp) {
    path = scp[1];
  } else {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "file:") return null;
      path = parsed.pathname;
    } catch {
      path = null;
    }
  }
  if (!path) return null;
  const parts = path.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return parts.slice(-2).join("/");
}

/**
 * Pick the remote whose URL points at `repo`, preferring names in order. The
 * checkout's `origin` is usually the fork, not the upstream, so callers must
 * resolve the base remote by URL rather than assuming a name.
 */
export function resolveRemoteForRepo(
  remotes: Remote[],
  repo: string,
  prefer: string[],
): string | null {
  const target = repo.toLowerCase();
  const matches = remotes.filter(
    (r) => parseRemoteRepo(r.url)?.toLowerCase() === target,
  );
  for (const name of prefer) {
    if (matches.some((r) => r.name === name)) return name;
  }
  return matches[0]?.name ?? null;
}

async function listOpenPrs(
  upstreamRepo: string,
  forkRepo: string,
): Promise<{ prs: OpenPr[]; truncated: boolean }> {
  // swamp-quality-ignore deno-command: gh CLI is the PR-sweep contract.
  const cmd = new Deno.Command("gh", {
    args: [
      "pr",
      "list",
      "--repo",
      upstreamRepo,
      "--state",
      "open",
      "--json",
      "number,title,headRepository,headRefName,baseRefName",
      "--limit",
      String(GH_PR_LIST_LIMIT),
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  const stderr = new TextDecoder().decode(output.stderr);
  if (output.code !== 0) {
    throw new Error(`gh pr list failed: ${stderr}`);
  }
  const all = JSON.parse(new TextDecoder().decode(output.stdout)) as OpenPr[];
  return {
    prs: all.filter((pr) => pr.headRepository?.nameWithOwner === forkRepo),
    truncated: all.length >= GH_PR_LIST_LIMIT,
  };
}

type AgentRun = {
  stdout: string;
  stderr: string;
  exitCode: number;
  verdictFileText: string;
};

/**
 * Compose the review prompt for one batch: what to sweep, which PRs this batch
 * covers, how to update branches, and where to write the durable verdict file.
 * Pure, so the wording is testable without running an agent.
 */
export function buildReviewPrompt(
  repo: { upstreamRepo: string; forkRepo: string; mainBranch: string },
  prs: Array<{ number: number; title: string }>,
  opts: { updateStrategy: UpdateStrategy; verdictPath: string },
): string {
  return `Sweep the open pull requests listed below for upstream repo ${repo.upstreamRepo} from fork ${repo.forkRepo}. Base branch: ${repo.mainBranch}.\n\n` +
    `${batchContractInstruction(prs.map((pr) => pr.number))}\n\n` +
    `${updateStrategyInstruction(opts.updateStrategy)}\n\n` +
    prs.map((pr) => `- PR #${pr.number}: ${pr.title}`).join("\n") +
    `\n\n${verdictFileInstruction(opts.verdictPath)}\n`;
}

/**
 * Run one review batch through `@maphew/agent-task`'s `run` method, which owns
 * how a headless agent is launched. pr-sweep owns the prompt, the batch and
 * the durable verdict file; it does not own the invocation.
 *
 * A non-zero exit is reported to the caller but does not throw: a review that
 * timed out can still have written verdicts for the PRs it did finish, and
 * those are what the caller records.
 */
async function runAgent(
  ctx: ModelContext,
  repo: Pick<Repo, "upstreamRepo" | "forkRepo" | "workdir"> & {
    agent: RunSettings["agent"];
    model: RunSettings["model"];
    mainBranch: string;
    updateStrategy: RunSettings["updateStrategy"];
  },
  prs: Array<{ number: number; title: string }>,
  systemPromptPath: string,
): Promise<AgentRun> {
  const systemPrompt = await Deno.readTextFile(systemPromptPath);
  const verdictDir = await Deno.makeTempDir({
    prefix: "swamp-pr-sweep-verdicts-",
  });
  const verdictPath = `${verdictDir}/verdicts.txt`;
  try {
    const taskPrompt = buildReviewPrompt(repo, prs, {
      updateStrategy: repo.updateStrategy,
      verdictPath,
    });

    if (!ctx.runModel) {
      throw new Error(
        "review: cross-behavior calls are unavailable in this context, so the agent runner (@maphew/agent-task's `run`) cannot be reached",
      );
    }
    const result = await ctx.runModel({
      modelType: AGENT_TASK_TYPE,
      name: AGENT_TASK_INSTANCE,
      method: "run",
      arguments: {
        prompt: taskPrompt,
        systemPrompt,
        workdir: repo.workdir,
        agent: repo.agent,
        model: repo.model,
      },
    });
    if (!result.ok) {
      throw new Error(`agent-task run failed: ${result.error.message}`);
    }

    // The run's outcome lives on the runner's own data, not in this process.
    const runRecords = await ctx.readModelData?.(
      AGENT_TASK_INSTANCE,
      "run",
    ) ?? [];
    const latest = runRecords[runRecords.length - 1]?.attributes ?? {};
    const stdout = typeof latest.stdout === "string" ? latest.stdout : "";
    const stderr = typeof latest.stderr === "string" ? latest.stderr : "";
    const exitCode = typeof latest.exitCode === "number" ? latest.exitCode : 1;
    if (exitCode !== 0) {
      ctx.logger.error(`Review agent exited with code ${exitCode}: ${stderr}`);
    }

    let verdictFileText = "";
    try {
      verdictFileText = await Deno.readTextFile(verdictPath);
    } catch {
      // Agent wrote nothing to the durable file; stdout parsing still applies.
    }

    return { stdout, stderr, exitCode, verdictFileText };
  } finally {
    try {
      await Deno.remove(verdictDir, { recursive: true });
    } catch {
      // best effort
    }
  }
}

/** Post-run GitHub state for one PR, as read by `gh pr view`. */
export type PrState = {
  state: string;
  merged: boolean;
  mergeStateStatus: string;
};

/** Placeholder used when a PR's state cannot be read. */
export const UNKNOWN_PR_STATE: PrState = {
  state: "unknown",
  merged: false,
  mergeStateStatus: "unknown",
};

/** Derive the merged flag from a `gh pr view` payload. */
export function derivePrState(
  data: { state?: string; mergedAt?: string | null; mergeStateStatus?: string },
): PrState {
  const state = data.state ?? "unknown";
  return {
    state,
    merged: state === "MERGED" || data.mergedAt != null,
    mergeStateStatus: data.mergeStateStatus ?? "unknown",
  };
}

async function queryPrState(
  upstreamRepo: string,
  number: number,
  logger?: { warn: (msg: string, props?: Record<string, unknown>) => void },
): Promise<PrState> {
  // 'merged' is not a gh pr view field; the query fails wholesale on it.
  // swamp-quality-ignore deno-command: gh CLI is the PR-sweep contract.
  const cmd = new Deno.Command("gh", {
    args: [
      "pr",
      "view",
      String(number),
      "--repo",
      upstreamRepo,
      "--json",
      "state,mergedAt,mergeStateStatus",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (output.code !== 0) {
    logger?.warn(`gh pr view failed for ${upstreamRepo}#${number}`, {
      exitCode: output.code,
      stderr: new TextDecoder().decode(output.stderr).trim(),
    });
    return { ...UNKNOWN_PR_STATE };
  }
  const data = JSON.parse(new TextDecoder().decode(output.stdout));
  return derivePrState(data);
}

// Actions the sweep summary counts and the sweeper contract may report. A
// dashed reference like "PR #7040 — Fix rate limiting" is prose, not a
// verdict, so the loose dash forms are only accepted for these words.
const PR_ACTIONS = [
  "merged",
  "skipped",
  "no-op",
  "conflict",
  "unresolvable",
  "reviewed",
];

/** A single PR's verdict: an action word plus an optional reason. */
export type Verdict = { verdict: string; reason?: string };

/**
 * Instruction appended to the agent task prompt naming the durable verdict
 * file. A sweep is long and the closing report is one big message: an agent
 * that runs out of output budget while composing it loses the verdict block at
 * its tail, which is exactly how a completed sweep lands as every-PR
 * `unknown`. Appending one line the moment each PR finishes commits that
 * verdict before the next PR starts, so truncation of the final message can no
 * longer erase it. The file is authoritative; the prose report is a fallback.
 */
export function verdictFileInstruction(path: string): string {
  return [
    "Machine-readable verdict file (required).",
    `As soon as you finish each PR — merged, skipped, or found in conflict — append exactly one line to \`${path}\` before starting the next PR:`,
    "",
    `    printf '%s\\n' 'PR #<number>: <action> — <short note>' >> ${path}`,
    "",
    "Append one line per PR; do not rewrite the file and do not wait until the end of the run. This file is the authoritative machine-readable record. The closing prose report is only a fallback, so a truncated final message must not be the only place a verdict appears.",
  ].join("\n");
}

/**
 * Merge verdicts parsed from the durable file with those parsed from stdout.
 * The file wins on conflict: it is written per PR during the run, whereas the
 * stdout verdict block is emitted once at the end and is what a truncated run
 * loses. stdout still fills any PR the file missed — e.g. an older agent that
 * ignored the file contract, or a PR whose append failed.
 */
export function mergeVerdicts(
  fromStdout: Map<number, Verdict>,
  fromFile: Map<number, Verdict>,
): Map<number, Verdict> {
  const merged = new Map(fromStdout);
  for (const [number, verdict] of fromFile) merged.set(number, verdict);
  return merged;
}

/**
 * Parse the agent's machine-readable `PR #<n>: <action>` lines into verdicts.
 * Later lines win for the same PR, and trailing sentence punctuation on the
 * action is stripped so "merged." still resolves to "merged".
 */
export function parseReportForVerdicts(
  report: string,
): Map<number, Verdict> {
  const verdicts = new Map<number, Verdict>();
  const lines = report.split("\n");
  for (const raw of lines) {
    // Sweeper reports are markdown, so "**PR #7040** — merged" is a normal
    // line shape; drop the bold markers before matching.
    const line = raw.replace(/\*\*/g, "");
    const match = line.match(/PR\s+#(\d+)\s*(:|[—–-])\s*(\S+)(.*)/i);
    if (match) {
      const colon = match[2] === ":";
      const number = parseInt(match[1], 10);
      // Agents routinely end verdicts and notes with sentence punctuation
      // ("merged.", "merged: main moved on"). Strip trailing punctuation
      // from the verdict token so "merged." still resolves to "merged".
      const verdict = match[3].toLowerCase().replace(/[.,;:]+$/, "");
      if (!colon && !PR_ACTIONS.includes(verdict)) continue;
      const reason = (match[4]?.trim() ?? "").replace(/[.,;:]+$/, "") ||
        undefined;
      verdicts.set(number, { verdict, reason });
    }
  }
  return verdicts;
}

type ModelContext = {
  signal: AbortSignal;
  globalArgs: Record<string, never>;
  definition: { id: string; name: string; version: string };
  extensionFile: (path: string) => string;
  /** Present when swamp runs methods in-process; steps degrade without it. */
  readModelData?: (
    modelName: string,
    specName: string,
  ) => Promise<Array<{ name?: string; attributes?: Record<string, unknown> }>>;
  queryData?: (
    predicate: string,
    select?: string,
  ) => Promise<DataRecord[] | unknown[]>;
  /** Call another extension's behavior type (declared under `dependencies`). */
  runModel?: (options: {
    modelType: string;
    name?: string;
    method: string;
    arguments?: Record<string, unknown>;
  }) => Promise<
    | { ok: true; resources: Array<{ name: string }> }
    | { ok: false; error: { message: string; stack?: string } }
  >;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: { tags?: Record<string, string> },
  ) => Promise<{ name: string }>;
  createFileWriter: (
    specName: string,
    name: string,
  ) => { writeText: (text: string) => Promise<{ name: string }> };
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
};

/** One durable data record as `readModelData`/`queryData` hand it back. */
export interface DataRecord {
  name?: string;
  specName?: string;
  modelName?: string;
  attributes?: Record<string, unknown>;
}

type GitResult = { ok: boolean; code: number; stdout: string; stderr: string };

async function runGit(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<GitResult> {
  // swamp-quality-ignore deno-command: branch sync runs real git commands.
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    signal,
  });
  const out = await cmd.output();
  return {
    ok: out.code === 0,
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout).trim(),
    stderr: new TextDecoder().decode(out.stderr).trim(),
  };
}

async function listRemotes(
  workdir: string,
  signal?: AbortSignal,
): Promise<Remote[]> {
  const res = await runGit(workdir, ["remote", "-v"], signal);
  if (!res.ok) return [];
  const byName = new Map<string, string>();
  for (const line of res.stdout.split("\n")) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
    if (m) byName.set(m[1], m[2]);
  }
  return [...byName].map(([name, url]) => ({ name, url }));
}

/** Outcome of the end-of-run branch-sync pass for one PR. */
export type PrSyncStatus =
  | "up-to-date"
  | "updated"
  | "conflict"
  | "error"
  | "skipped";

/** Instruction describing the configured merge/rebase update contract. */
export function updateStrategyInstruction(
  strategy: UpdateStrategy,
): string {
  return strategy === "merge"
    ? "Update strategy: merge. Bring each PR branch up to date by merging the base branch into it; do not rebase, and never force-push."
    : "Update strategy: rebase. Bring each PR branch up to date by rebasing it onto the base branch, then push with --force-with-lease (never bare --force).";
}

/**
 * Merge the base into the branch and push fast-forward. The merge commit
 * descends from the branch tip, so no force is needed; a concurrent push makes
 * it non-fast-forward and the push fails rather than clobbering.
 */
async function mergeBaseIn(
  worktree: string,
  baseRemote: string,
  baseBranch: string,
  baseSha: string,
  branch: string,
  forkRemote: string,
  ctx: ModelContext,
): Promise<{ status: PrSyncStatus; detail?: string }> {
  const merge = await runGit(
    worktree,
    [
      "merge",
      "--no-verify",
      "--no-edit",
      "-m",
      `Merge ${baseRemote}/${baseBranch} into ${branch}`,
      baseSha,
    ],
    ctx.signal,
  );
  if (!merge.ok) {
    await runGit(worktree, ["merge", "--abort"], ctx.signal);
    return {
      status: "conflict",
      detail: (merge.stderr || merge.stdout).split("\n")[0],
    };
  }
  const push = await runGit(
    worktree,
    ["push", "--no-verify", forkRemote, `HEAD:refs/heads/${branch}`],
    ctx.signal,
  );
  return push.ok
    ? { status: "updated" }
    : { status: "error", detail: `push failed: ${push.stderr}` };
}

/**
 * Rebase the branch onto the base and force-push. Rewriting history means a
 * non-fast-forward push, so the lease pins the expected fork tip to avoid
 * clobbering a concurrent push.
 */
async function rebaseOnto(
  worktree: string,
  baseSha: string,
  branch: string,
  forkSha: string,
  forkRemote: string,
  ctx: ModelContext,
): Promise<{ status: PrSyncStatus; detail?: string }> {
  const rebase = await runGit(worktree, ["rebase", baseSha], ctx.signal);
  if (!rebase.ok) {
    await runGit(worktree, ["rebase", "--abort"], ctx.signal);
    return {
      status: "conflict",
      detail: (rebase.stderr || rebase.stdout).split("\n")[0],
    };
  }
  const push = await runGit(
    worktree,
    [
      "push",
      "--no-verify",
      `--force-with-lease=refs/heads/${branch}:${forkSha}`,
      forkRemote,
      `HEAD:refs/heads/${branch}`,
    ],
    ctx.signal,
  );
  return push.ok
    ? { status: "updated" }
    : { status: "error", detail: `push failed: ${push.stderr}` };
}

/**
 * End-of-run branch-sync pass. The agent brings each PR up to date once, early
 * in a sweep that can run for an hour; on a busy upstream the base branch moves
 * again before the sweep ends, leaving branches behind and GitHub showing
 * "Update branch". Re-fetch the base and bring anything it moved past up to
 * date, following `updateStrategy` (merge by default, or rebase).
 *
 * Updates happen in a throwaway worktree so the operator's checkout is never
 * touched. Pre-push hooks are skipped (CI is the gate; husky segfaults in
 * constrained environments). Merged PRs and primary branches are skipped.
 *
 * One pass still leaves early PRs stale on a busy upstream: follow it with
 * verifySyncedPrs for a per-PR fresh check and a bounded top-up.
 */
export async function resyncBehindPrs(
  repo: SyncRepo,
  prs: SyncTarget[],
  stateByNumber: Map<number, PrState>,
  ctx: ModelContext,
): Promise<Map<number, { status: PrSyncStatus; detail?: string }>> {
  const results = new Map<number, { status: PrSyncStatus; detail?: string }>();
  const remotes = await listRemotes(repo.workdir, ctx.signal);
  const baseRemote = resolveRemoteForRepo(remotes, repo.upstreamRepo, [
    "upstream",
  ]);
  const forkRemote = resolveRemoteForRepo(remotes, repo.forkRepo, [
    "origin",
    "fork",
  ]);
  if (!baseRemote || !forkRemote) {
    ctx.logger.warn("Branch sync pass skipped: remotes not resolved", {
      workdir: repo.workdir,
      baseRemote,
      forkRemote,
      remotes: remotes.map((r) => `${r.name}=${r.url}`),
    });
    return results;
  }

  const baseShaByBranch = new Map<string, string | null>();
  const baseShaFor = async (branch: string): Promise<string | null> => {
    if (baseShaByBranch.has(branch)) return baseShaByBranch.get(branch) ?? null;
    const fetchRes = await runGit(
      repo.workdir,
      ["fetch", "--no-tags", baseRemote, branch],
      ctx.signal,
    );
    let sha: string | null = null;
    if (fetchRes.ok) {
      const head = await runGit(
        repo.workdir,
        ["rev-parse", "FETCH_HEAD"],
        ctx.signal,
      );
      sha = head.ok ? head.stdout : null;
    }
    baseShaByBranch.set(branch, sha);
    return sha;
  };

  for (const pr of prs) {
    if (stateByNumber.get(pr.number)?.merged) {
      results.set(pr.number, { status: "skipped", detail: "already merged" });
      continue;
    }
    const branch = pr.headRefName;
    const baseBranch = pr.baseRefName || repo.mainBranch;
    if (!branch) {
      results.set(pr.number, {
        status: "skipped",
        detail: "unknown head branch",
      });
      continue;
    }
    if (
      branch === repo.mainBranch || branch === "main" || branch === "master"
    ) {
      results.set(pr.number, { status: "skipped", detail: "primary branch" });
      continue;
    }

    const baseSha = await baseShaFor(baseBranch);
    if (!baseSha) {
      results.set(pr.number, {
        status: "error",
        detail: `could not resolve ${baseRemote}/${baseBranch}`,
      });
      continue;
    }

    const tmpRef = `refs/swamp-sweep/${branch}`;
    const fetchFork = await runGit(
      repo.workdir,
      ["fetch", "--no-tags", forkRemote, `+refs/heads/${branch}:${tmpRef}`],
      ctx.signal,
    );
    if (!fetchFork.ok) {
      results.set(pr.number, {
        status: "error",
        detail: `fork fetch failed: ${fetchFork.stderr}`,
      });
      continue;
    }
    const forkSha = (
      await runGit(repo.workdir, ["rev-parse", tmpRef], ctx.signal)
    ).stdout;

    const ancestor = await runGit(
      repo.workdir,
      ["merge-base", "--is-ancestor", baseSha, forkSha],
      ctx.signal,
    );
    if (ancestor.code === 0) {
      results.set(pr.number, { status: "up-to-date" });
      await runGit(repo.workdir, ["update-ref", "-d", tmpRef], ctx.signal);
      continue;
    }
    if (ancestor.code !== 1) {
      results.set(pr.number, {
        status: "error",
        detail: ancestor.stderr || `merge-base exited ${ancestor.code}`,
      });
      await runGit(repo.workdir, ["update-ref", "-d", tmpRef], ctx.signal);
      continue;
    }

    const tmpRoot = await Deno.makeTempDir({ prefix: "swamp-pr-sweep-" });
    const tmpWorktree = `${tmpRoot}/wt`;
    try {
      const added = await runGit(
        repo.workdir,
        ["worktree", "add", "--detach", "--force", tmpWorktree, forkSha],
        ctx.signal,
      );
      if (!added.ok) {
        results.set(pr.number, {
          status: "error",
          detail: `worktree add failed: ${added.stderr}`,
        });
        continue;
      }
      results.set(
        pr.number,
        repo.updateStrategy === "merge"
          ? await mergeBaseIn(
            tmpWorktree,
            baseRemote,
            baseBranch,
            baseSha,
            branch,
            forkRemote,
            ctx,
          )
          : await rebaseOnto(
            tmpWorktree,
            baseSha,
            branch,
            forkSha,
            forkRemote,
            ctx,
          ),
      );
    } finally {
      try {
        await runGit(
          repo.workdir,
          ["worktree", "remove", "--force", tmpWorktree],
          ctx.signal,
        );
      } catch {
        // best effort
      }
      try {
        await Deno.remove(tmpRoot, { recursive: true });
      } catch {
        // best effort
      }
      try {
        await runGit(repo.workdir, ["update-ref", "-d", tmpRef], ctx.signal);
      } catch {
        // best effort
      }
    }
  }

  return results;
}

/** Detail recorded when the verify pass has to update a PR the sync pass
 * already left current: the base moved mid-sweep. Kept as a constant so
 * the run summary can count drifted PRs without matching prose. */
export const TOPPED_UP_DETAIL = "topped up after base moved mid-sweep";

/**
 * Merge a fresh per-PR verification result into the prior sync outcome. A
 * branch the sync pass left current can fall behind again while the pass
 * works through the remaining PRs on a busy upstream; when the follow-up
 * check has to update it again that drift is recorded in the detail, so the
 * status reflects reality at decision time rather than the earlier verdict.
 */
export function combineVerifyResult(
  prior: { status: PrSyncStatus; detail?: string },
  fresh: { status: PrSyncStatus; detail?: string },
): { status: PrSyncStatus; detail?: string } {
  if (fresh.status === "up-to-date") return prior;
  if (fresh.status === "updated") {
    return { status: "updated", detail: TOPPED_UP_DETAIL };
  }
  return fresh;
}

/**
 * Freshness verification for the branch-sync pass. The agent updates each PR
 * against a fetch taken at run start and the sync pass fetches each base
 * branch once, so on a busy upstream an early PR's "current" verdict is
 * stale before the run ends. Re-run the sync for every PR still claiming to
 * be current: each single-PR call re-fetches the base and the fork branch,
 * so the check is authoritative at decision time and no longer depends on
 * agent timing. A branch the base moved past gets one bounded top-up, and
 * the outcome is recorded as-is — never re-checked in a loop, because
 * perfect freshness is unattainable while the upstream keeps merging.
 */
export async function verifySyncedPrs(
  repo: SyncRepo,
  prs: SyncTarget[],
  stateByNumber: Map<number, PrState>,
  prior: Map<number, { status: PrSyncStatus; detail?: string }>,
  ctx: ModelContext,
): Promise<Map<number, { status: PrSyncStatus; detail?: string }>> {
  const final = new Map(prior);
  for (const pr of prs) {
    const prev = prior.get(pr.number);
    if (
      !prev || (prev.status !== "updated" && prev.status !== "up-to-date")
    ) {
      continue;
    }
    const fresh = await resyncBehindPrs(repo, [pr], stateByNumber, ctx);
    const res = fresh.get(pr.number);
    if (!res) continue;
    final.set(pr.number, combineVerifyResult(prev, res));
  }
  return final;
}

// ---------- composable steps ------------------------------------------------

/** Arguments shared by every composable step (repo pair + per-run settings). */
const StepArgsBaseSchema = z.object({
  workdir: z.string().optional().describe(
    "Local checkout directory for the upstream repo. Omit to resolve it from pr-sweep-config's registered pairs.",
  ),
  upstreamRepo: z.string().optional().describe(
    "Upstream GitHub repo as owner/name. Omit to use the newest open-prs-current.",
  ),
  forkRepo: z.string().optional().describe(
    "Fork GitHub repo as owner/name. Omit to use the newest open-prs-current.",
  ),
  agent: z.enum(AGENT_NAMES).default("kilo").describe(
    "Headless agent for review batches",
  ),
  model: z.string().default("").describe(
    "Model for the agent in provider/model form; empty uses the agent's default or the registered repo pair's model",
  ),
  mainBranch: z.string().default("main").describe(
    "Base branch to rebase and merge into",
  ),
  swampRepoDir: z.string().optional().describe(
    "Path to the swamp repo that owns this workflow; only for the legacy prompt override.",
  ),
  sweeperPrompt: z.string().optional().describe(
    "Absolute path to a custom sweeper prompt file.",
  ),
  updateStrategy: z.enum(UPDATE_STRATEGIES).default("merge").describe(
    "How to update a behind branch: merge the base in (no force-push) or rebase onto it (force-push)",
  ),
  batchSize: z.number().int().min(0).default(0).describe(
    "list only: group PRs into review batches of at most this many (0 = one batch, the whole list) and report the grouping for the orchestrator",
  ),
});
/** Inference-time input shape (defaults optional); swamp parses at runtime. */
type StepArgsInput = z.input<typeof StepArgsBaseSchema>;

/** Workdir of the local checkout, resolved from config or an explicit argument. */
async function resolveWorkdir(
  ctx: ModelContext,
  repoPair: { upstreamRepo: string; forkRepo: string },
  explicit?: string,
): Promise<string> {
  return (await resolveRepoPair(ctx, repoPair, explicit)).workdir;
}

/**
 * Resolve the local checkout and optional model for a repo pair from an
 * explicit argument or the pair registered in pr-sweep-config.
 */
async function resolveRepoPair(
  ctx: ModelContext,
  repoPair: { upstreamRepo: string; forkRepo: string },
  explicit?: string,
): Promise<{ workdir: string; model: string }> {
  let registered: { workdir: string; model: string } | null = null;
  if (ctx.queryData) {
    try {
      const rows = await ctx.queryData(
        'modelName == "pr-sweep-config" && specName == "config"',
      );
      for (const raw of rows as Array<Record<string, unknown>>) {
        const attrs = (raw.attributes ?? {}) as Record<string, unknown>;
        const pairs = (attrs.repoPairs ?? []) as Array<Record<string, unknown>>;
        const match = pairs.find((p) =>
          p.upstreamRepo === repoPair.upstreamRepo &&
          p.forkRepo === repoPair.forkRepo
        );
        if (match) {
          registered = {
            workdir: typeof match.workdir === "string"
              ? match.workdir.trim()
              : "",
            model: typeof match.model === "string" ? match.model.trim() : "",
          };
          break;
        }
      }
    } catch (err) {
      ctx.logger.warn("Could not query pr-sweep-config for the repo pair", {
        error: String(err),
      });
    }
  }

  const workdir = explicit?.trim() || registered?.workdir;
  if (!workdir) {
    throw new Error(
      `no workdir for ${repoPair.upstreamRepo} / ${repoPair.forkRepo}: pass workdir= or register the pair in pr-sweep-config`,
    );
  }
  return { workdir, model: registered?.model ?? "" };
}

/** Durably read the newest `open-prs-current`, or null when absent/unparsable. */
async function readOpenPrs(ctx: ModelContext): Promise<OpenPrsRecord | null> {
  if (!ctx.readModelData) {
    ctx.logger.warn(
      "ceph steps: readModelData unavailable; open-prs-current unreadable",
    );
    return null;
  }
  try {
    const rows = await ctx.readModelData(ctx.definition.name, "open-prs");
    const record = rows.find((r) => r.name === OPEN_PRS_INSTANCE);
    if (!record?.attributes) return null;
    const parsed = OpenPrsSchema.safeParse(record.attributes);
    return parsed.success ? parsed.data : null;
  } catch (err) {
    ctx.logger.warn("Could not read open-prs-current", { error: String(err) });
    return null;
  }
}

/**
 * Fill in the repo pair from `open-prs-current` when a step's arguments omit
 * it, so a step run right after `list` needs no wiring. Explicit arguments
 * always win.
 */
export function withQueueRepoPair(
  args: StepArgsInput,
  current: OpenPrsRecord | null,
): StepArgsInput {
  if (args.upstreamRepo?.trim() && args.forkRepo?.trim()) return args;
  if (!current) return args;
  return {
    ...args,
    upstreamRepo: args.upstreamRepo?.trim() || current.upstreamRepo,
    forkRepo: args.forkRepo?.trim() || current.forkRepo,
  };
}

/** The instance name one PR's `pr` resource is written under. */
export function prInstanceName(upstreamRepo: string, number: number): string {
  return `${upstreamRepo.replace(/\//g, "-")}-${number}`;
}

/** Read back one PR's recorded result, or null when never written. */
async function readPrResource(
  ctx: ModelContext,
  name: string,
): Promise<PrResult | null> {
  if (!ctx.readModelData) return null;
  try {
    const rows = await ctx.readModelData(ctx.definition.name, "pr");
    const record = rows.find((r) => r.name === name);
    if (!record?.attributes) return null;
    const parsed = PrResultSchema.safeParse(record.attributes);
    return parsed.success ? parsed.data : null;
  } catch (err) {
    ctx.logger.warn(`Could not read pr resource ${name}`, {
      error: String(err),
    });
    return null;
  }
}

/** Merge fresh verdict/state/sync fields onto a PR's existing record. */
function mergePrFields(
  prior: PrResult | null,
  listed: ListedPr | null,
  patch: Partial<PrResult>,
): PrResult {
  const base: PrResult = prior ?? {
    number: listed?.number ?? patch.number ?? 0,
    title: listed?.title ?? patch.title ?? "",
    verdict: "pending",
  };
  return {
    ...base,
    ...(listed
      ? {
        headRefName: listed.headRefName,
        baseRefName: listed.baseRefName,
      }
      : {}),
    ...patch,
  };
}

/** Count verdicts across the given records the way a summary reports them. */
export function tallyPrs(records: Array<PrResult>): {
  mergedCount: number;
  skippedCount: number;
  failedCount: number;
  pendingCount: number;
} {
  let mergedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  for (const rec of records) {
    if (rec.merged || rec.verdict === "merged") mergedCount++;
    else if (rec.verdict === "skipped" || rec.verdict === "no-op") {
      skippedCount++;
    } else if (rec.verdict === "conflict" || rec.verdict === "unresolvable") {
      failedCount++;
    } else if (rec.verdict === "pending" || rec.verdict === "unknown") {
      pendingCount++;
    }
  }
  return { mergedCount, skippedCount, failedCount, pendingCount };
}

const OPEN_PRS_INSTANCE = "open-prs-current";

async function stepList(
  args: StepArgsInput & { workdir?: string },
  ctx: ModelContext,
): Promise<{
  upstreamRepo: string;
  forkRepo: string;
  prs: ListedPr[];
  batches: number[][];
  truncated: boolean;
  dataHandles: Array<{ name: string }>;
}> {
  const { repo, settings } = normalizeRun(args);
  await preflightTools({}, ctx);
  ctx.logger.info("list: open PRs from fork in upstream", repo);

  let open: OpenPr[];
  let truncated = false;
  try {
    ({ prs: open, truncated } = await listOpenPrs(
      repo.upstreamRepo,
      repo.forkRepo,
    ));
  } catch (err) {
    ctx.logger.error("Failed to list PRs", { error: String(err) });
    throw err;
  }
  if (truncated) {
    ctx.logger.warn(
      `gh pr list hit the ${GH_PR_LIST_LIMIT}-PR ceiling; some open PRs may be missing`,
      { upstreamRepo: repo.upstreamRepo },
    );
  }

  const prs: ListedPr[] = open.map((pr) => ({
    number: pr.number,
    title: pr.title,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName || settings.mainBranch,
  }));

  const record: OpenPrsRecord = {
    upstreamRepo: repo.upstreamRepo,
    forkRepo: repo.forkRepo,
    listedAt: new Date().toISOString(),
    prs,
    truncated,
  };
  const handles: Array<{ name: string }> = [];
  handles.push(await ctx.writeResource("open-prs", OPEN_PRS_INSTANCE, record));

  // Seed/refresh one `pr` resource per listed PR so the queue is queryable
  // before any review happens; existing verdicts and sync state are preserved.
  for (const listed of prs) {
    const name = prInstanceName(repo.upstreamRepo, listed.number);
    const prior = await readPrResource(ctx, name);
    handles.push(
      await ctx.writeResource("pr", name, mergePrFields(prior, listed, {})),
    );
  }

  const batchSize = args.batchSize ?? 0;
  const batches = planReviewBatches(prs, batchSize);
  ctx.logger.info(
    `list: ${prs.length} open PR(s) in ${batches.length} review batch(es)`,
    { truncated },
  );
  return { ...repo, prs, batches, truncated, dataHandles: handles };
}

async function stepReview(
  args: StepArgsInput & {
    numbers?: number[];
    workdir?: string;
    resyncBehind?: boolean;
  },
  ctx: ModelContext,
): Promise<{
  reviewed: number[];
  verdicts: Record<string, string>;
  unreviewed: number[];
  dataHandles: Array<{ name: string }>;
}> {
  const current = await readOpenPrs(ctx);
  const { repo, settings } = normalizeRun(
    withQueueRepoPair(args, current),
  );
  await preflightTools(
    { needsAgent: true, agent: settings.agent },
    ctx,
  );
  const byNumber = new Map<number, ListedPr>(
    (current?.prs ?? []).map((pr) => [pr.number, pr]),
  );

  const requested = args.numbers && args.numbers.length > 0
    ? args.numbers
    : [...byNumber.keys()];
  if (requested.length === 0) {
    throw new Error(
      "review: no PR numbers given and open-prs-current lists none — run list first",
    );
  }
  const unknown = requested.filter((n) => !byNumber.has(n));
  if (unknown.length > 0) {
    throw new Error(
      `review: PR(s) ${
        unknown.join(", ")
      } are not in open-prs-current — run list again or pass the right numbers`,
    );
  }

  const pair = await resolveRepoPair(ctx, repo, args.workdir);
  const workdir = pair.workdir;
  const model = settings.model || pair.model;
  const systemPromptPath = resolveSweeperPromptPath(
    {
      swampRepoDir: settings.swampRepoDir,
      sweeperPrompt: settings.sweeperPrompt,
    } as Repo,
    {
      bundled: ctx.extensionFile(BUNDLED_SWEEPER_PROMPT),
      exists: (path) => {
        try {
          return Deno.statSync(path).isFile;
        } catch {
          return false;
        }
      },
    },
  );

  const batch = requested.map((n) => byNumber.get(n)!);
  const run = await runAgent(
    ctx,
    {
      ...repo,
      workdir,
      agent: settings.agent,
      model,
      mainBranch: settings.mainBranch,
      updateStrategy: settings.updateStrategy,
    },
    batch,
    systemPromptPath,
  );

  const verdicts = mergeVerdicts(
    parseReportForVerdicts(run.stdout),
    parseReportForVerdicts(run.verdictFileText),
  );
  if (run.verdictFileText.trim() === "") {
    ctx.logger.warn(
      "Agent wrote no durable verdict file; per-PR verdicts came from stdout only",
      { parsedVerdicts: verdicts.size },
    );
  }
  if (verdicts.size === 0) {
    ctx.logger.warn(
      "No per-PR verdicts parsed from the review run; PRs will record verdict=unknown",
      { prCount: batch.length },
    );
  }

  const stateByNumber = new Map<number, PrState>();
  for (const pr of batch) {
    try {
      stateByNumber.set(
        pr.number,
        await queryPrState(repo.upstreamRepo, pr.number, ctx.logger),
      );
    } catch (err) {
      ctx.logger.warn(`Could not read state for PR #${pr.number}`, {
        error: String(err),
      });
      stateByNumber.set(pr.number, { ...UNKNOWN_PR_STATE });
    }
  }

  // The review agent already brings its PRs up to date as part of the sweep
  // procedure; the deterministic sync pass afterwards catches drift. It is
  // opt-out for callers that sync on their own schedule.
  let syncResults = new Map<
    number,
    { status: PrSyncStatus; detail?: string }
  >();
  if (args.resyncBehind !== false) {
    try {
      const syncRepo: SyncRepo = { ...repo, workdir, ...settings };
      const synced = await resyncBehindPrs(syncRepo, batch, stateByNumber, ctx);
      syncResults = await verifySyncedPrs(
        syncRepo,
        batch,
        stateByNumber,
        synced,
        ctx,
      );
    } catch (err) {
      ctx.logger.error("Branch sync pass after review failed", {
        error: String(err),
      });
    }
  }

  const now = new Date().toISOString();
  const handles: Array<{ name: string }> = [];
  const verdictByName: Record<string, string> = {};
  for (const pr of batch) {
    const verdictInfo = verdicts.get(pr.number) ?? { verdict: "unknown" };
    const state = stateByNumber.get(pr.number) ?? { ...UNKNOWN_PR_STATE };
    const sync = syncResults.get(pr.number);
    const name = prInstanceName(repo.upstreamRepo, pr.number);
    const prior = await readPrResource(ctx, name);
    verdictByName[String(pr.number)] = verdictInfo.verdict;
    handles.push(
      await ctx.writeResource(
        "pr",
        name,
        mergePrFields(prior, pr, {
          number: pr.number,
          title: pr.title,
          upstreamRepo: repo.upstreamRepo,
          forkRepo: repo.forkRepo,
          verdict: verdictInfo.verdict,
          reason: verdictInfo.reason,
          merged: state.merged || verdictInfo.verdict === "merged",
          state: state.state,
          mergeStateStatus: state.mergeStateStatus,
          reviewedAt: now,
          syncStatus: sync?.status,
          syncDetail: sync?.detail,
        }),
      ),
    );
  }

  const unreviewed = [...byNumber.keys()].filter((n) => !requested.includes(n));
  ctx.logger.info(
    `review: ${batch.length} PR(s) reviewed; ${unreviewed.length} still pending`,
    { verdicts: verdictByName },
  );
  return {
    reviewed: requested,
    verdicts: verdictByName,
    unreviewed,
    dataHandles: handles,
  };
}

async function stepSync(
  args: StepArgsInput & { numbers?: number[]; workdir?: string },
  ctx: ModelContext,
): Promise<{
  synced: Record<string, string>;
  dataHandles: Array<{ name: string }>;
}> {
  const current = await readOpenPrs(ctx);
  const { repo, settings } = normalizeRun(
    withQueueRepoPair(args, current),
  );
  await preflightTools({}, ctx);
  const byNumber = new Map<number, ListedPr>(
    (current?.prs ?? []).map((pr) => [pr.number, pr]),
  );
  const requested = args.numbers && args.numbers.length > 0
    ? args.numbers
    : [...byNumber.keys()];
  if (requested.length === 0) {
    throw new Error(
      "sync: no PR numbers given and open-prs-current lists none — run list first",
    );
  }

  const workdir = await resolveWorkdir(ctx, repo, args.workdir);
  const batch = requested
    .map((n) => byNumber.get(n))
    .filter((pr): pr is ListedPr => pr !== undefined);
  const stale = requested.filter((n) => !byNumber.has(n));
  if (stale.length > 0) {
    ctx.logger.warn(
      "sync: PR(s) not in open-prs-current are skipped (branch names unknown)",
      { stale },
    );
  }

  const stateByNumber = new Map<number, PrState>();
  for (const pr of batch) {
    stateByNumber.set(
      pr.number,
      await queryPrState(repo.upstreamRepo, pr.number, ctx.logger),
    );
  }

  const syncRepo: SyncRepo = { ...repo, workdir, ...settings };
  const synced = await resyncBehindPrs(syncRepo, batch, stateByNumber, ctx);
  const finalResults = await verifySyncedPrs(
    syncRepo,
    batch,
    stateByNumber,
    synced,
    ctx,
  );

  const handles: Array<{ name: string }> = [];
  const statuses: Record<string, string> = {};
  for (const pr of batch) {
    const res = finalResults.get(pr.number);
    if (!res) continue;
    statuses[String(pr.number)] = res.status;
    const name = prInstanceName(repo.upstreamRepo, pr.number);
    const prior = await readPrResource(ctx, name);
    handles.push(
      await ctx.writeResource(
        "pr",
        name,
        mergePrFields(prior, pr, {
          upstreamRepo: repo.upstreamRepo,
          forkRepo: repo.forkRepo,
          syncStatus: res.status,
          syncDetail: res.detail,
        }),
      ),
    );
  }
  ctx.logger.info(`sync: ${batch.length} PR(s) checked`, { statuses });
  return { synced: statuses, dataHandles: handles };
}

async function stepVerdicts(
  args: StepArgsInput,
  ctx: ModelContext,
): Promise<{ results: PrResult[]; dataHandles: Array<{ name: string }> }> {
  const current = await readOpenPrs(ctx);
  const { repo } = normalizeRun(withQueueRepoPair(args, current));
  const results: PrResult[] = [];
  for (const listed of current?.prs ?? []) {
    const prior = await readPrResource(
      ctx,
      prInstanceName(repo.upstreamRepo, listed.number),
    );
    results.push(prior ?? mergePrFields(null, listed, {}));
  }
  ctx.logger.info("verdicts: {result}", {
    result: JSON.stringify(
      results.map((r) => ({ pr: r.number, verdict: r.verdict })),
    ),
  });
  return { results, dataHandles: [] };
}

async function stepSummary(
  args: StepArgsInput,
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const current = await readOpenPrs(ctx);
  const { repo } = normalizeRun(withQueueRepoPair(args, current));
  const records: PrResult[] = [];
  for (const listed of current?.prs ?? []) {
    const prior = await readPrResource(
      ctx,
      prInstanceName(repo.upstreamRepo, listed.number),
    );
    records.push(prior ?? mergePrFields(null, listed, {}));
  }
  const tally = tallyPrs(records);
  const reportLines = [
    `# PR sweep summary — ${repo.upstreamRepo}`,
    "",
    `Listed: ${records.length} · Merged: ${tally.mergedCount} · Skipped: ${tally.skippedCount} · Failed: ${tally.failedCount} · Pending: ${tally.pendingCount}`,
    "",
    "| PR | Verdict | State | Sync | Note |",
    "| -- | ------- | ----- | ---- | ---- |",
    ...records.map((r) =>
      `| #${r.number} | ${r.verdict} | ${r.state ?? "?"} | ${
        r.syncStatus ?? "-"
      } | ${(r.reason ?? "").slice(0, 80)} |`
    ),
  ];
  const handle = await ctx.writeResource("sweep", "summary", {
    upstreamRepo: repo.upstreamRepo,
    forkRepo: repo.forkRepo,
    sweptAt: new Date().toISOString(),
    prCount: records.length,
    ...tally,
    report: reportLines.join("\n"),
    truncated: current?.truncated ?? false,
  });
  ctx.logger.info("summary: {result}", {
    result: JSON.stringify({ prCount: records.length, ...tally }),
  });
  return { dataHandles: [handle] };
}

// ---------- monolithic convenience -----------------------------------------

/**
 * Run the whole sweep in one call: `list`, one `review` batch over every
 * listed PR, then `summary`. Scheduled workflows that want a single step keep
 * working; an orchestrator that batches or syncs on its own calls the steps
 * instead.
 */
async function sweepAll(
  args: Repo,
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const stepArgs: StepArgsInput & { workdir: string; resyncBehind: boolean } = {
    upstreamRepo: args.upstreamRepo,
    forkRepo: args.forkRepo,
    workdir: args.workdir,
    agent: args.agent,
    model: args.model,
    mainBranch: args.mainBranch,
    swampRepoDir: args.swampRepoDir,
    sweeperPrompt: args.sweeperPrompt,
    updateStrategy: args.updateStrategy,
    resyncBehind: args.resyncBehind,
  };
  const listed = await stepList(stepArgs, ctx);
  if (listed.prs.length === 0) {
    const handle = await ctx.writeResource("sweep", "noop", {
      upstreamRepo: args.upstreamRepo,
      forkRepo: args.forkRepo,
      sweptAt: new Date().toISOString(),
      prCount: 0,
      mergedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      pendingCount: 0,
      report: "No open PRs from fork; nothing to sweep.",
      truncated: listed.truncated,
    });
    return { dataHandles: [handle] };
  }
  await stepReview(
    { ...stepArgs, numbers: listed.prs.map((pr) => pr.number) },
    ctx,
  );
  const summary = await stepSummary(stepArgs, ctx);
  return {
    dataHandles: [...listed.dataHandles, ...summary.dataHandles],
  };
}

export const model = {
  type: "@maphew/pr-sweep",
  version: "2026.10.23.1",
  globalArguments: z.object({}),
  upgrades: [
    {
      toVersion: "2026.10.14.1",
      description:
        "Source moved to maphew/swamp-extensions (AGPL-3.0); the sweeper prompt is now bundled and a custom prompt can be set with sweeperPrompt",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.18.1",
      description:
        "Composable steps: list / review / sync / verdicts / summary split the monolithic sweep, which remains as a convenience method. New `open-prs` queue resource and a `pending` verdict on per-PR records.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.23.1",
      description:
        "Add an optional `model` to the repo pair and step arguments (and to the registered pr-sweep-config pair), passed through to every review and sweep agent invocation; empty keeps the agent's default",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    "open-prs": {
      description:
        "The queue of open fork PRs one `list` step produced (instance `open-prs-current`)",
      schema: OpenPrsSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    sweep: {
      description: "PR sweep run summary",
      schema: SweepSummarySchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    pr: {
      description: "Per-PR sweep result",
      schema: PrResultSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "List open PRs the fork contributes to the upstream repo, write them as the sweep queue (`open-prs-current` plus one `pr` record each), and report how they group into review batches. The first step an orchestrator runs.",
      arguments: StepArgsBaseSchema,
      execute: stepList,
    },
    review: {
      description:
        "Run one headless agent over a batch of PRs from the queue with the bundled sweeper prompt, then record each PR's verdict, post-run state, and branch-sync outcome on its `pr` record. Small batches only — the orchestrator decides grouping; pass `numbers` for one batch.",
      arguments: StepArgsBaseSchema.extend({
        numbers: z.array(z.number().int()).default([]).describe(
          "PR numbers this batch covers; empty means every PR in open-prs-current",
        ),
        resyncBehind: z.boolean().default(true).describe(
          "Run the deterministic branch-sync pass after the agent finishes (turn off to sync separately)",
        ),
      }),
      execute: stepReview,
    },
    sync: {
      description:
        "Deterministic branch-sync pass with bounded verify/top-up for the queue (or `numbers`): re-fetch the base and bring behind PR branches up to date. No agent runs.",
      arguments: StepArgsBaseSchema,
      execute: stepSync,
    },
    verdicts: {
      description:
        "Read back the recorded per-PR results for the current queue as data (logs the payload so a harness can see it). Read-only.",
      arguments: StepArgsBaseSchema,
      execute: stepVerdicts,
    },
    summary: {
      description:
        "Tally the recorded per-PR results (`merged`/`skipped`/`failed`/`pending`) into the `sweep` summary resource and a markdown report.",
      arguments: StepArgsBaseSchema,
      execute: stepSummary,
    },
    sweep: {
      description:
        "Monolithic convenience: list, one review batch over every open PR, and summary in a single call. Prefer the composable steps when orchestrating.",
      arguments: RepoSchema,
      execute: async (args: Repo, ctx: ModelContext) =>
        await sweepAll(args, ctx),
    },
  },
};
