import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  BUNDLED_SWEEPER_PROMPT,
  buildAgentInvocation,
  combineVerifyResult,
  derivePrState,
  mergeVerdicts,
  model,
  parseRemoteRepo,
  parseReportForVerdicts,
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

Deno.test("buildAgentInvocation maps each agent to its real binary", () => {
  const opts = {
    prompt: "TASK",
    systemPrompt: "SYS",
    workingDir: "/repo",
  };
  assertEquals(buildAgentInvocation("kilo", opts).binary, "kilo");
  assertEquals(buildAgentInvocation("claude", opts).binary, "claude");
  assertEquals(buildAgentInvocation("codex", opts).binary, "codex");
  assertEquals(buildAgentInvocation("opencode", opts).binary, "opencode");
});

Deno.test("buildAgentInvocation passes the system prompt and task", () => {
  const opts = {
    prompt: "TASK",
    systemPrompt: "SYS",
    workingDir: "/repo",
  };
  const kilo = buildAgentInvocation("kilo", opts);
  assertEquals(kilo.args.join("\n").includes("SYS\n\nTASK"), true);
  assertEquals(kilo.args.includes("/repo"), true);

  const opencode = buildAgentInvocation("opencode", opts);
  assertEquals(opencode.args[0], "TASK");
  assertEquals(opencode.args.includes("--system-prompt=SYS"), true);
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
