import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  BUNDLED_SWEEPER_PROMPT,
  AGENT_TASK_INSTANCE,
  AGENT_TASK_TYPE,
  buildReviewPrompt,
  checkToolAvailable,
  combineVerifyResult,
  derivePrState,
  mergeVerdicts,
  model,
  parseRemoteRepo,
  parseReportForVerdicts,
  preflightTools,
  resolveRemoteForRepo,
  resolveSweeperPromptPath,
  TOPPED_UP_DETAIL,
  updateStrategyInstruction,
  verdictFileInstruction,
} from "./pr_sweep.ts";

Deno.test("derivePrState reads an open PR as not merged", () => {
  assertEquals(
    derivePrState({
      state: "OPEN",
      mergedAt: null,
      mergeStateStatus: "BLOCKED",
    }),
    { state: "OPEN", merged: false, mergeStateStatus: "BLOCKED" },
  );
});

Deno.test("derivePrState reads a merged PR as merged", () => {
  assertEquals(
    derivePrState({
      state: "MERGED",
      mergedAt: "2026-10-02T23:46:57Z",
      mergeStateStatus: "UNKNOWN",
    }),
    { state: "MERGED", merged: true, mergeStateStatus: "UNKNOWN" },
  );
});

Deno.test("derivePrState trusts state MERGED when mergedAt is absent", () => {
  assertEquals(derivePrState({ state: "MERGED" }).merged, true);
});

Deno.test("derivePrState flags merged on a non-null mergedAt alone", () => {
  assertEquals(
    derivePrState({ state: "OPEN", mergedAt: "2026-10-02T23:46:57Z" }).merged,
    true,
  );
});

Deno.test("derivePrState falls back to unknown for absent fields", () => {
  assertEquals(derivePrState({}), {
    state: "unknown",
    merged: false,
    mergeStateStatus: "unknown",
  });
});

Deno.test("parseReportForVerdicts reads the 'PR #n: verdict' format", () => {
  const verdicts = parseReportForVerdicts([
    "PR #7040: merged",
    "PR #7041: conflict — main moved on",
    "PR #7042: skipped",
  ].join("\n"));

  assertEquals(verdicts.size, 3);
  assertEquals(verdicts.get(7040)?.verdict, "merged");
  assertEquals(verdicts.get(7041)?.verdict, "conflict");
  assertEquals(verdicts.get(7041)?.reason, "— main moved on");
  assertEquals(verdicts.get(7042)?.verdict, "skipped");
  assertEquals(verdicts.get(7042)?.reason, undefined);
});

Deno.test("parseReportForVerdicts reads bolded em-dash PR lines", () => {
  const verdicts = parseReportForVerdicts([
    "**PR #7040** — merged",
    "**PR #7041**: merged",
  ].join("\n"));

  assertEquals(verdicts.size, 2);
  assertEquals(verdicts.get(7040)?.verdict, "merged");
  assertEquals(verdicts.get(7041)?.verdict, "merged");
});

Deno.test("parseReportForVerdicts reads an undecorated hyphen PR line", () => {
  const verdicts = parseReportForVerdicts("PR #7040 - merged");
  assertEquals(verdicts.get(7040)?.verdict, "merged");
});

Deno.test("parseReportForVerdicts ignores a dash line that is not a verdict", () => {
  const verdicts = parseReportForVerdicts("PR #7040 — Fix the rate limiter");
  assertEquals(verdicts.size, 0);
});

Deno.test("parseReportForVerdicts lowercases the verdict", () => {
  const verdicts = parseReportForVerdicts("PR #7040: Merged");
  assertEquals(verdicts.get(7040)?.verdict, "merged");
});

Deno.test("parseReportForVerdicts ignores lines without a PR reference", () => {
  const verdicts = parseReportForVerdicts([
    "Swept 3 PRs.",
    "Summary: 1 merged, 2 skipped",
    "- #7040 merged",
  ].join("\n"));

  assertEquals(verdicts.size, 0);
});

Deno.test("parseReportForVerdicts lets a later line win for the same PR", () => {
  const verdicts = parseReportForVerdicts([
    "PR #7040: conflict",
    "PR #7040: merged after rebase",
  ].join("\n"));

  assertEquals(verdicts.get(7040)?.verdict, "merged");
  assertEquals(verdicts.get(7040)?.reason, "after rebase");
});

// Regression: agents routinely end verdicts and notes with sentence
// punctuation ("merged.", "merged: main moved on"). Without stripping it,
// "merged." does not equal "merged" and every verdict lands as unknown —
// the exact symptom this model was written to fix.
Deno.test("parseReportForVerdicts strips trailing sentence punctuation", () => {
  const report = [
    "**PR #7040 — merged.**",
    "**PR #7040 — merged: main moved on**",
    "**PR #7040 — skipped (no upstream activity).**",
    "PR #7040: merged.",
  ].join("\n");
  const verdicts = parseReportForVerdicts(report);

  // Later lines win; the last one is "PR #7040: merged." with no note.
  assertEquals(verdicts.size, 1);
  assertEquals(verdicts.get(7040)?.verdict, "merged");
  assertEquals(verdicts.get(7040)?.reason, undefined);

  // Each form parses on its own.
  const oneAtATime = [
    "**PR #7040 — merged.**",
    "**PR #7040 — merged: main moved on**",
    "**PR #7040 — skipped (no upstream activity).**",
    "PR #7040: merged.",
  ].map((line) => parseReportForVerdicts(line));
  assertEquals(oneAtATime[0].get(7040)?.verdict, "merged");
  assertEquals(oneAtATime[1].get(7040)?.verdict, "merged");
  assertEquals(oneAtATime[1].get(7040)?.reason, "main moved on");
  assertEquals(oneAtATime[2].get(7040)?.verdict, "skipped");
  assertEquals(oneAtATime[2].get(7040)?.reason, "(no upstream activity)");
  assertEquals(oneAtATime[3].get(7040)?.verdict, "merged");
});

Deno.test("verdictFileInstruction names the path and the append contract", () => {
  const instruction = verdictFileInstruction("/tmp/foo/verdicts.txt");
  assertEquals(instruction.includes("/tmp/foo/verdicts.txt"), true);
  assertEquals(instruction.includes(">>"), true);
  assertEquals(instruction.includes("PR #<number>: <action>"), true);
});

Deno.test("mergeVerdicts prefers the durable file over stdout", () => {
  // The file is written per PR during the run; stdout is a truncated fallback.
  const fromStdout = parseReportForVerdicts("PR #7040: merged");
  const fromFile = parseReportForVerdicts("PR #7040: skipped — draft");
  const merged = mergeVerdicts(fromStdout, fromFile);
  assertEquals(merged.get(7040)?.verdict, "skipped");
  assertEquals(merged.get(7040)?.reason, "— draft");
});

Deno.test("mergeVerdicts keeps stdout verdicts the file missed", () => {
  // An agent that ignored the file contract still yields verdicts from stdout.
  const fromStdout = parseReportForVerdicts(
    ["PR #7040: merged", "PR #7041: skipped"].join("\n"),
  );
  const fromFile = parseReportForVerdicts("PR #7040: merged");
  const merged = mergeVerdicts(fromStdout, fromFile);
  assertEquals(merged.size, 2);
  assertEquals(merged.get(7040)?.verdict, "merged");
  assertEquals(merged.get(7041)?.verdict, "skipped");
});

Deno.test("parseRemoteRepo reads https URLs", () => {
  assertEquals(
    parseRemoteRepo("https://github.com/Kilo-Org/kilocode.git"),
    "Kilo-Org/kilocode",
  );
  assertEquals(
    parseRemoteRepo("https://github.com/maphew/kilo-cloud"),
    "maphew/kilo-cloud",
  );
});

Deno.test("parseRemoteRepo reads scp-style SSH URLs", () => {
  assertEquals(
    parseRemoteRepo("git@github.com:Kilo-Org/cloud.git"),
    "Kilo-Org/cloud",
  );
  assertEquals(
    parseRemoteRepo("git@github.com:maphew/kilocode.git"),
    "maphew/kilocode",
  );
});

Deno.test("parseRemoteRepo reads ssh:// URLs", () => {
  assertEquals(
    parseRemoteRepo("ssh://git@github.com/maphew/kilo-cloud.git"),
    "maphew/kilo-cloud",
  );
});

Deno.test("parseRemoteRepo returns null for local paths", () => {
  assertEquals(parseRemoteRepo("../kilo-cloud"), null);
  assertEquals(parseRemoteRepo("/home/mhwilkie/dev/kilo-cloud"), null);
  assertEquals(parseRemoteRepo("file:///srv/git/one-level"), null);
});

Deno.test("resolveRemoteForRepo prefers the conventional base/fork names", () => {
  const remotes = [
    { name: "origin", url: "https://github.com/maphew/kilo-cloud.git" },
    { name: "upstream", url: "https://github.com/Kilo-Org/cloud.git" },
  ];
  assertEquals(
    resolveRemoteForRepo(remotes, "Kilo-Org/cloud", ["upstream"]),
    "upstream",
  );
  assertEquals(
    resolveRemoteForRepo(remotes, "maphew/kilo-cloud", ["origin", "fork"]),
    "origin",
  );
});

Deno.test("resolveRemoteForRepo matches by URL when names are unconventional", () => {
  const remotes = [
    { name: "fork", url: "git@github.com:maphew/kilo-cloud.git" },
    { name: "base", url: "git@github.com:Kilo-Org/cloud.git" },
  ];
  assertEquals(
    resolveRemoteForRepo(remotes, "Kilo-Org/cloud", ["upstream"]),
    "base",
  );
  assertEquals(
    resolveRemoteForRepo(remotes, "maphew/kilo-cloud", ["origin", "fork"]),
    "fork",
  );
});

Deno.test("resolveRemoteForRepo never falls back to the wrong repo", () => {
  const remotes = [
    { name: "origin", url: "https://github.com/maphew/kilo-cloud.git" },
  ];
  assertEquals(
    resolveRemoteForRepo(remotes, "Kilo-Org/cloud", ["upstream"]),
    null,
  );
});

Deno.test("combineVerifyResult keeps the prior outcome when still current", () => {
  const prior = { status: "updated" as const };
  assertEquals(combineVerifyResult(prior, { status: "up-to-date" }), prior);
});

Deno.test("combineVerifyResult records drift when the base moved mid-sweep", () => {
  assertEquals(
    combineVerifyResult({ status: "up-to-date" }, { status: "updated" }),
    { status: "updated", detail: TOPPED_UP_DETAIL },
  );
});

Deno.test("combineVerifyResult passes fresh failures through as-is", () => {
  const fresh = { status: "conflict" as const, detail: "boom" };
  assertEquals(
    combineVerifyResult({ status: "up-to-date" }, fresh),
    fresh,
  );
});

Deno.test("sweep defaults to merge and resync", () => {
  const parsed = model.methods.sweep.arguments.parse({
    upstreamRepo: "a/b",
    forkRepo: "c/d",
    workdir: "/x",
  });
  assertEquals(parsed.updateStrategy, "merge");
  assertEquals(parsed.resyncBehind, true);
});

Deno.test("updateStrategyInstruction states the merge and rebase contracts", () => {
  const merge = updateStrategyInstruction("merge");
  const rebase = updateStrategyInstruction("rebase");
  assertEquals(merge.includes("never force-push"), true);
  assertEquals(merge.includes("do not rebase"), true);
  assertEquals(rebase.includes("--force-with-lease"), true);
  assertEquals(rebase.includes("never bare --force"), true);
});

Deno.test("buildReviewPrompt names the batch, strategy and verdict file", () => {
  const prompt = buildReviewPrompt(
    { upstreamRepo: "Kilo-Org/kilocode", forkRepo: "maphew/kilocode", mainBranch: "main" },
    [{ number: 7040, title: "Fix rate limiting" }],
    { updateStrategy: "merge", verdictPath: "/tmp/v.txt" },
  );
  assertEquals(prompt.includes("Kilo-Org/kilocode"), true);
  assertEquals(prompt.includes("maphew/kilocode"), true);
  assertEquals(prompt.includes("PR #7040: Fix rate limiting"), true);
  assertEquals(prompt.includes("do not rebase"), true);
  assertEquals(prompt.includes("/tmp/v.txt"), true);
});

Deno.test("buildReviewPrompt scopes the batch so one agent reports per PR", () => {
  const prompt = buildReviewPrompt(
    { upstreamRepo: "a/b", forkRepo: "c/b", mainBranch: "main" },
    [{ number: 1, title: "x" }, { number: 2, title: "y" }],
    { updateStrategy: "merge", verdictPath: "/tmp/v.txt" },
  );
  assertEquals(prompt.includes("exactly these 2 pull request(s)"), true);
  assertEquals(prompt.includes("#1, #2"), true);
  assertEquals(prompt.includes("one verdict line per PR in the batch"), true);
});

Deno.test("resolveSweeperPromptPath prefers an explicit override", () => {
  assertEquals(
    resolveSweeperPromptPath(
      { sweeperPrompt: "/custom.md", swampRepoDir: "/swamp" },
      { bundled: "/bundled.md", exists: () => true },
    ),
    "/custom.md",
  );
});

Deno.test("resolveSweeperPromptPath falls back to the bundled prompt", () => {
  // No override, and the legacy repo-local path is absent -> bundled.
  assertEquals(
    resolveSweeperPromptPath(
      { swampRepoDir: "/swamp" },
      { bundled: "/bundled.md", exists: () => false },
    ),
    "/bundled.md",
  );
  assertEquals(
    resolveSweeperPromptPath(
      {},
      { bundled: "/bundled.md", exists: () => true },
    ),
    "/bundled.md",
  );
});

Deno.test("resolveSweeperPromptPath honors a legacy repo-local prompt", () => {
  assertEquals(
    resolveSweeperPromptPath(
      { swampRepoDir: "/swamp" },
      { bundled: "/bundled.md", exists: (p) => p === "/swamp/.kilo/agents/pr-sweeper.md" },
    ),
    "/swamp/.kilo/agents/pr-sweeper.md",
  );
});

Deno.test("the bundled sweeper prompt ships with the extension", async () => {
  // Guards against an additionalFiles entry that is never actually bundled.
  const prompt = await Deno.readTextFile(
    new URL(`../${BUNDLED_SWEEPER_PROMPT}`, import.meta.url),
  );
  assertEquals(prompt.includes("PR Sweeper"), true);
  assertEquals(prompt.includes("PR #<number>"), true);
});

// ---------- composable steps: pure seams ----------------------------------

import {
  normalizeRun,
  planReviewBatches,
  prInstanceName,
  tallyPrs,
  withQueueRepoPair,
} from "./pr_sweep.ts";

Deno.test("planReviewBatches keeps the whole list as one batch when batchSize is 0", () => {
  assertEquals(
    planReviewBatches([{ number: 1 }, { number: 2 }, { number: 3 }], 0),
    [[1, 2, 3]],
  );
});

Deno.test("planReviewBatches splits into batches of at most n, in order", () => {
  const prs = [1, 2, 3, 4, 5].map((number) => ({ number }));
  assertEquals(planReviewBatches(prs, 2), [[1, 2], [3, 4], [5]]);
});

Deno.test("planReviewBatches returns no batches for an empty list", () => {
  assertEquals(planReviewBatches([], 3), []);
});

Deno.test("withQueueRepoPair fills an omitted repo pair from the queue", () => {
  const queue = {
    upstreamRepo: "Kilo-Org/kilocode",
    forkRepo: "maphew/kilocode",
    listedAt: "2026-10-18T00:00:00.000Z",
    prs: [],
    truncated: false,
  };
  assertEquals(
    withQueueRepoPair({ batchSize: 0 }, queue),
    {
      batchSize: 0,
      upstreamRepo: "Kilo-Org/kilocode",
      forkRepo: "maphew/kilocode",
    },
  );
});

Deno.test("withQueueRepoPair leaves explicit arguments alone", () => {
  const queue = {
    upstreamRepo: "Kilo-Org/kilocode",
    forkRepo: "maphew/kilocode",
    listedAt: "2026-10-18T00:00:00.000Z",
    prs: [],
    truncated: false,
  };
  const args = { upstreamRepo: "other/up", forkRepo: "me/up" };
  assertEquals(withQueueRepoPair(args, queue), args);
});

Deno.test("withQueueRepoPair keeps a partial explicit pair for normalizeRun to reject", () => {
  const queue = {
    upstreamRepo: "Kilo-Org/kilocode",
    forkRepo: "maphew/kilocode",
    listedAt: "2026-10-18T00:00:00.000Z",
    prs: [],
    truncated: false,
  };
  assertEquals(
    withQueueRepoPair({ upstreamRepo: "other/up" }, queue),
    { upstreamRepo: "other/up", forkRepo: "maphew/kilocode" },
  );
});

Deno.test("normalizeRun applies step defaults", () => {
  const { repo, settings } = normalizeRun({
    upstreamRepo: "Kilo-Org/kilocode",
    forkRepo: "maphew/kilocode",
  });
  assertEquals(repo, {
    upstreamRepo: "Kilo-Org/kilocode",
    forkRepo: "maphew/kilocode",
  });
  assertEquals(settings, {
    agent: "kilo",
    model: "",
    mainBranch: "main",
    swampRepoDir: undefined,
    sweeperPrompt: undefined,
    updateStrategy: "merge",
  });
});

Deno.test("normalizeRun carries a model through the step settings", () => {
  const { settings } = normalizeRun({
    upstreamRepo: "Kilo-Org/kilocode",
    forkRepo: "maphew/kilocode",
    model: "zai-coding-plan/glm-5.3",
  });
  assertEquals(settings.model, "zai-coding-plan/glm-5.3");
});

Deno.test("normalizeRun refuses a step with no repo pair", () => {
  let message = "";
  try {
    normalizeRun({});
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assertEquals(message.includes("upstreamRepo and forkRepo"), true);
});

Deno.test("prInstanceName is stable per upstream repo and PR number", () => {
  assertEquals(prInstanceName("Kilo-Org/kilocode", 7040), "Kilo-Org-kilocode-7040");
});

Deno.test("tallyPrs counts pending separately from skipped and failed", () => {
  const tally = tallyPrs([
    { number: 1, title: "a", verdict: "merged" },
    { number: 2, title: "b", verdict: "merged", merged: true },
    { number: 3, title: "c", verdict: "skipped" },
    { number: 4, title: "d", verdict: "conflict" },
    { number: 5, title: "e", verdict: "pending" },
    { number: 6, title: "f", verdict: "reviewed" },
  ]);
  assertEquals(tally, {
    mergedCount: 2,
    skippedCount: 1,
    failedCount: 1,
    // `reviewed` is a real verdict, not a pending one: the PR was handled.
    pendingCount: 1,
  });
});

Deno.test("tallyPrs counts an unknown verdict as pending", () => {
  assertEquals(tallyPrs([{ number: 1, title: "a", verdict: "unknown" }]).pendingCount, 1);
});

Deno.test("review routes its agent through @maphew/agent-task's run primitive", () => {
  assertEquals(AGENT_TASK_TYPE, "@maphew/agent-task");
  assertEquals(AGENT_TASK_INSTANCE, "agent-task-queue");
});

Deno.test("the behavior exposes the composable steps and the sweep convenience", () => {
  assertEquals(
    Object.keys(model.methods).sort(),
    ["list", "review", "summary", "sweep", "sync", "verdicts"],
  );
});

Deno.test("review defaults its batch and sync settings", () => {
  const parsed = model.methods.review.arguments.parse({
    upstreamRepo: "Kilo-Org/kilocode",
    forkRepo: "maphew/kilocode",
  });
  assertEquals(parsed.numbers, []);
  assertEquals(parsed.resyncBehind, true);
  assertEquals(parsed.updateStrategy, "merge");
  assertEquals(parsed.model, "");
});

Deno.test("list reports its batch grouping input default", () => {
  assertEquals(model.methods.list.arguments.parse({}).batchSize, 0);
});

Deno.test("checkToolAvailable passes when the probe finds the tool", async () => {
  const probed: string[] = [];
  await checkToolAvailable("gh", async (tool) => {
    probed.push(tool);
    return 0;
  });
  assertEquals(probed, ["gh"]);
});

Deno.test("checkToolAvailable treats a non-zero --version exit as present", async () => {
  await checkToolAvailable("kilo", async () => 2);
});

Deno.test("checkToolAvailable fails fast naming the missing tool", async () => {
  let message = "";
  try {
    await checkToolAvailable("opencode", async () => null);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(message.includes("'opencode'"), true);
  assertEquals(message.includes("not found on PATH"), true);
});

Deno.test("preflightTools probes git and gh, and the agent only when asked", async () => {
  const seen: string[][] = [];
  let logged = 0;
  const ctx = {
    logger: {
      info: () => {
        logged += 1;
      },
    },
  };
  await preflightTools({}, ctx, async (tool) => {
    seen.push([tool]);
    return 0;
  });
  assertEquals(seen.flat(), ["git", "gh"]);

  seen.length = 0;
  const tools = await preflightTools(
    { needsAgent: true, agent: "codex" },
    ctx,
    async (tool) => {
      seen.push([tool]);
      return 0;
    },
  );
  assertEquals(seen.flat(), ["git", "gh", "codex"]);
  assertEquals(tools, ["git", "gh", "codex"]);
  assertEquals(logged, 2);
});
