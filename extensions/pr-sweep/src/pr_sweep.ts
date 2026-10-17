/**
 * PR sweep — adversarially review, update, and merge open pull requests that a
 * fork contributes to an upstream GitHub repository.
 *
 * A single `sweep` method lists open PRs from the fork, hands them to a
 * headless agent (kilo by default) with a bundled sweeper prompt, parses each
 * PR's verdict from a durable per-PR file (falling back to stdout), re-fetches
 * the base branch and brings behind branches up to date, and writes queryable
 * per-PR and run-summary resources.
 *
 * The sweeper prompt is bundled with the extension (`prompts/pr-sweeper.md`) so
 * the model is self-contained; a repo-local prompt can override it via
 * `sweeperPrompt` or the legacy `<swampRepoDir>/.kilo/agents/pr-sweeper.md`.
 *
 * @module
 */

import { z } from "npm:zod@4";

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
  agent: z.enum(["claude", "codex", "opencode", "kilo"]).default("kilo")
    .describe("Headless agent to run the sweep"),
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
  updateStrategy: z.enum(["merge", "rebase"]).default("merge").describe(
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
  report: z.string().optional(),
  truncated: z.boolean().optional(),
});

const PrResultSchema = z.object({
  number: z.number(),
  title: z.string(),
  verdict: z.string(),
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

/** The binary and argument vector for one headless-agent invocation. */
export type AgentInvocation = { binary: string; args: string[] };

/**
 * Build the headless-agent command for one of the supported binaries. The
 * invocations mirror `.kilo/agents/run-task.sh` (the reference driver used in
 * swamp repos), so `agent` selects a real binary instead of silently running
 * kilo for every value. Claude/codex take the whole prompt positionally;
 * opencode takes the task as its argument and the sweeper contract as
 * `--system-prompt`; kilo gets the prompt after `--`.
 */
export function buildAgentInvocation(
  agent: Repo["agent"],
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

/**
 * `gh pr list` defaults to the 30 most-recent PRs. Busy upstreams (Kilo-Org
 * repos routinely carry >100 open PRs) push an older fork's PRs past that
 * window, so a sweep that omits --limit silently under-counts and can report
 * "nothing to sweep" while fork PRs are open. Fetch a high ceiling instead.
 */
export const GH_PR_LIST_LIMIT = 1000;

/** Path of the sweeper prompt bundled with the extension (see `additionalFiles`). */
export const BUNDLED_SWEEPER_PROMPT = "prompts/pr-sweeper.md";

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

async function checkToolAvailable(tool: string): Promise<void> {
     try {
       const cmd = new Deno.Command(tool, {
         args: ["--version"],
         stdout: "null",
         stderr: "null",
       });
       const output = await cmd.output();

       if (output.code === 0) {
         return; // Tool is available
       }

       // Check if the error is due to the tool not being found.
       const stderr = new TextDecoder().decode(output.stderr).toLowerCase();
       if (output.code === 127 || stderr.includes("not found") || stderr.includes("no such file or directory")) {
         throw new Error(`Required tool '${tool}' not found. Please install it and ensure it is in your PATH.`);
       }

       // If we get here, the tool exists but returned a non-zero exit code for --version (maybe it doesn't support that flag).
       // We'll assume the tool is available.
       return;
     } catch (error) {
       if (error instanceof Deno.errors.NotFound) {
         throw new Error(`Required tool '${tool}' not found. Please install it and ensure it is in your PATH.`);
       }
       // If we get another error (like permission denied), we still consider the tool available? 
       // Actually, if we get an error that is not NotFound, it means the tool was found but we couldn't run it (e.g., permission denied).
       // We should still consider it available because the binary exists.
       return;
     }
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

type AgentRun = { stdout: string; verdictFileText: string };

async function runAgent(
  ctx: {
    logger: { info: (msg: string) => void; error: (msg: string) => void };
    signal: AbortSignal;
  },
  repo: Repo,
  prs: Array<{ number: number; title: string }>,
  systemPromptPath: string,
): Promise<AgentRun> {
  const systemPrompt = await Deno.readTextFile(systemPromptPath);
  const verdictDir = await Deno.makeTempDir({
    prefix: "swamp-pr-sweep-verdicts-",
  });
  const verdictPath = `${verdictDir}/verdicts.txt`;
  try {
    const taskPrompt =
      `Sweep the open pull requests listed below for upstream repo ${repo.upstreamRepo} from fork ${repo.forkRepo}. Base branch: ${repo.mainBranch}.\n\n` +
      `${updateStrategyInstruction(repo.updateStrategy)}\n\n` +
      prs.map((pr) => `- PR #${pr.number}: ${pr.title}`).join("\n") +
      `\n\n${verdictFileInstruction(verdictPath)}\n`;

    const { binary, args } = buildAgentInvocation(repo.agent, {
      prompt: taskPrompt,
      systemPrompt,
      workingDir: repo.workdir,
    });

    ctx.logger.info(`Running ${binary} agent for ${prs.length} PR(s)`);

    // swamp-quality-ignore deno-command: the whole point is to run the agent.
    const command = new Deno.Command(binary, {
      args,
      cwd: repo.workdir,
      stdout: "piped",
      stderr: "piped",
      signal: ctx.signal,
    });

    const output = await command.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);

    if (output.code !== 0) {
      ctx.logger.error(`Agent exited with code ${output.code}: ${stderr}`);
    }

    let verdictFileText = "";
    try {
      verdictFileText = await Deno.readTextFile(verdictPath);
    } catch {
      // Agent wrote nothing to the durable file; stdout parsing still applies.
    }

    return { stdout, verdictFileText };
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
  extensionFile: (path: string) => string;
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
  strategy: "merge" | "rebase",
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
  repo: Repo,
  prs: OpenPr[],
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
  repo: Repo,
  prs: OpenPr[],
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

async function executeSweep(
  args: Repo,
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
   const repo: Repo = {
     ...args,
     agent: args.agent ?? "kilo",
     mainBranch: args.mainBranch ?? "main",
     swampRepoDir: args.swampRepoDir ?? ".",
     resyncBehind: args.resyncBehind ?? true,
     updateStrategy: args.updateStrategy ?? "merge",
   };
   
   // Preflight checks for external tools
   await checkToolAvailable("gh");
   await checkToolAvailable("git");
   const agentBinaryMap: Record<Repo["agent"], string> = {
     claude: "claude",
     codex: "codex",
     opencode: "opencode",
     kilo: "kilo",
   };
   const agentBinary = agentBinaryMap[repo.agent];
   await checkToolAvailable(agentBinary);

  ctx.logger.info("Listing open PRs from fork in upstream", {
    upstreamRepo: repo.upstreamRepo,
    forkRepo: repo.forkRepo,
  });

  let prs: OpenPr[];
  let truncated = false;
  try {
    ({ prs, truncated } = await listOpenPrs(repo.upstreamRepo, repo.forkRepo));
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

  if (prs.length === 0) {
    ctx.logger.info("No open PRs from fork; nothing to sweep");
    const handle = await ctx.writeResource("sweep", "noop", {
      upstreamRepo: repo.upstreamRepo,
      forkRepo: repo.forkRepo,
      sweptAt: new Date().toISOString(),
      prCount: 0,
      mergedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      report: "No open PRs from fork; nothing to sweep.",
      truncated,
    });
    return { dataHandles: [handle] };
  }

  ctx.logger.info(`Found ${prs.length} open PR(s) from fork`);

  const systemPromptPath = resolveSweeperPromptPath(repo, {
    bundled: ctx.extensionFile(BUNDLED_SWEEPER_PROMPT),
    exists: (path) => {
      try {
        return Deno.statSync(path).isFile;
      } catch {
        return false;
      }
    },
  });
  let run: AgentRun;
  try {
    run = await runAgent(ctx, repo, prs, systemPromptPath);
  } catch (err) {
    ctx.logger.error("Agent run failed", { error: String(err) });
    throw err;
  }
  const report = run.stdout;

  // The durable per-PR file is authoritative: it is written as each PR
  // finishes, so it survives truncation of the agent's closing message, which
  // is where the stdout verdict block lives. stdout is the fallback.
  const verdicts = mergeVerdicts(
    parseReportForVerdicts(report),
    parseReportForVerdicts(run.verdictFileText),
  );
  if (run.verdictFileText.trim() === "") {
    ctx.logger.warn(
      "Agent wrote no durable verdict file; per-PR verdicts came from stdout only",
      { parsedVerdicts: verdicts.size },
    );
  }
  if (verdicts.size === 0 && prs.length > 0) {
    ctx.logger.warn(
      "No per-PR verdicts parsed from the agent run; PRs will record verdict=unknown",
      { prCount: prs.length },
    );
  }

  // Read every PR's post-agent state before the branch-sync pass: a merged
  // PR's branch is usually deleted, so it must not be pushed.
  const stateByNumber = new Map<number, PrState>();
  for (const pr of prs) {
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

  let syncResults = new Map<
    number,
    { status: PrSyncStatus; detail?: string }
  >();
  if (repo.resyncBehind) {
    try {
      const synced = await resyncBehindPrs(repo, prs, stateByNumber, ctx);
      syncResults = await verifySyncedPrs(
        repo,
        prs,
        stateByNumber,
        synced,
        ctx,
      );
      const updated = [...syncResults.values()].filter((r) =>
        r.status === "updated"
      ).length;
      const drifted = [...syncResults.values()].filter((r) =>
        r.detail === TOPPED_UP_DETAIL
      ).length;
      ctx.logger.info(
        `Branch sync pass updated ${updated} PR(s) (${repo.updateStrategy})` +
          (drifted > 0 ? `, ${drifted} topped up after base moved` : ""),
      );
    } catch (err) {
      ctx.logger.error("Branch sync pass failed", { error: String(err) });
    }
  }

  const now = new Date().toISOString();
  let mergedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  const prHandles: Array<{ name: string }> = [];
  const instancePrefix = repo.upstreamRepo.replace(/\//g, "-");
  for (const pr of prs) {
    const verdictInfo = verdicts.get(pr.number) ?? { verdict: "unknown" };
    const state = stateByNumber.get(pr.number) ?? { ...UNKNOWN_PR_STATE };

    const merged = state.merged || verdictInfo.verdict === "merged";
    if (merged) mergedCount++;
    else if (
      verdictInfo.verdict === "skipped" || verdictInfo.verdict === "no-op"
    ) skippedCount++;
    else if (
      verdictInfo.verdict === "conflict" ||
      verdictInfo.verdict === "unresolvable"
    ) failedCount++;

    const sync = syncResults.get(pr.number);
    const handle = await ctx.writeResource(
      "pr",
      `${instancePrefix}-${pr.number}`,
      {
        number: pr.number,
        title: pr.title,
        verdict: verdictInfo.verdict,
        merged,
        reason: verdictInfo.reason,
        state: state.state,
        mergeStateStatus: state.mergeStateStatus,
        syncStatus: sync?.status,
        syncDetail: sync?.detail,
      },
    );
    prHandles.push(handle);
  }

  const summaryHandle = await ctx.writeResource("sweep", "summary", {
    upstreamRepo: repo.upstreamRepo,
    forkRepo: repo.forkRepo,
    sweptAt: now,
    prCount: prs.length,
    mergedCount,
    skippedCount,
    failedCount,
    report,
    truncated,
  });

  return { dataHandles: [summaryHandle, ...prHandles] };
}

export const model = {
  type: "@maphew/pr-sweep",
  version: "2026.10.14.1",
  globalArguments: z.object({}),
  upgrades: [
    {
      toVersion: "2026.10.14.1",
      description:
        "Source moved to maphew/swamp-extensions (AGPL-3.0); the sweeper prompt is now bundled and a custom prompt can be set with sweeperPrompt",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
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
    sweep: {
      description: "Sweep open PRs from a fork in an upstream repo",
      arguments: RepoSchema,
      execute: async (args: Repo, ctx: ModelContext) =>
        await executeSweep(args, ctx),
    },
  },
};
