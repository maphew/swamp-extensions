import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import {
  actorFor,
  branchNameFor,
  buildAgentInvocation,
  buildTaskPrompt,
  coerceWorkdirMap,
  matchWorkdir,
  normalizeBdIssue,
  renderManifestReport,
  renderSweepReport,
  runnerInstruction,
  sandboxNameFor,
  sandboxPathFor,
  sandboxVerdict,
  sanitizeInstanceName,
  skipReason,
} from "./agent_task.ts";

Deno.test("normalizeBdIssue reads bd snake_case fields", () => {
  const issue = normalizeBdIssue({
    id: "myswamp-abc",
    title: "Do the thing",
    description: "Details",
    priority: 1,
    issue_type: "bug",
    dependency_count: 2,
    labels: ["security", "waiting-on-user"],
  });
  assertEquals(issue, {
    id: "myswamp-abc",
    title: "Do the thing",
    description: "Details",
    priority: 1,
    issueType: "bug",
    dependencyCount: 2,
    labels: ["security", "waiting-on-user"],
  });
});

Deno.test("normalizeBdIssue falls back to camelCase fields", () => {
  const issue = normalizeBdIssue({
    id: "x",
    issueType: "feature",
    dependencyCount: 3,
  });
  assertEquals(issue.issueType, "feature");
  assertEquals(issue.dependencyCount, 3);
});

Deno.test("normalizeBdIssue defaults missing fields", () => {
  const issue = normalizeBdIssue({ id: "x" });
  assertEquals(issue.priority, 2);
  assertEquals(issue.issueType, "task");
  assertEquals(issue.dependencyCount, 0);
  assertEquals(issue.description, "");
  assertEquals(issue.labels, []);
});

Deno.test("skipReason drops a human-blocked label", () => {
  const issue = normalizeBdIssue({ id: "x", labels: ["waiting-on-user"] });
  assertEquals(skipReason(issue), "label:waiting-on-user");
});

Deno.test("skipReason drops a spike", () => {
  const issue = normalizeBdIssue({ id: "x", issue_type: "spike" });
  assertEquals(skipReason(issue), "type:spike");
});

Deno.test("skipReason drops an epic: a container is not a dispatch unit", () => {
  // bd ready returns epics (verified on bd 1.3.1), so this default is what
  // keeps one from being handed to an agent as if it were implementation.
  const issue = normalizeBdIssue({
    id: "x",
    issue_type: "epic",
    labels: [],
  });
  assertEquals(skipReason(issue), "type:epic");
});

Deno.test("skipReason drops a convoy for the same reason", () => {
  const issue = normalizeBdIssue({ id: "x", issue_type: "convoy" });
  assertEquals(skipReason(issue), "type:convoy");
});

Deno.test("skipReason still admits a plain feature", () => {
  const issue = normalizeBdIssue({ id: "x", issue_type: "feature" });
  assertEquals(skipReason(issue), null);
});

Deno.test("skipReason drops an issue with open dependencies", () => {
  const issue = normalizeBdIssue({ id: "x", dependency_count: 1 });
  assertEquals(skipReason(issue), "blocked-by-dependencies");
});

Deno.test("skipReason returns null for an actionable task", () => {
  const issue = normalizeBdIssue({ id: "x", issue_type: "task" });
  assertEquals(skipReason(issue), null);
});

Deno.test("matchWorkdir chooses the longest matching prefix", () => {
  const map = {
    myswamp: "/repo/a",
    "myswamp-pih": "/repo/b",
  };
  assertEquals(matchWorkdir("myswamp-pih-1", map), "/repo/b");
  assertEquals(matchWorkdir("myswamp-xyz", map), "/repo/a");
});

Deno.test("matchWorkdir returns null when nothing matches", () => {
  assertEquals(matchWorkdir("other-1", { myswamp: "/repo/a" }), null);
});

Deno.test("branchNameFor flattens slashes and scopes to bd/", () => {
  assertEquals(branchNameFor("myswamp-xcy"), "bd/myswamp-xcy");
  assertEquals(branchNameFor("a/b"), "bd/a-b");
});

Deno.test("actorFor flattens the branch into the actor", () => {
  assertEquals(actorFor("kilo", "bd/myswamp-xcy"), "kilo-bd-myswamp-xcy");
});

Deno.test("sanitizeInstanceName keeps safe characters and strips edges", () => {
  assertEquals(sanitizeInstanceName("bd/myswamp-xcy"), "bd-myswamp-xcy");
  assertEquals(sanitizeInstanceName("---"), "unknown");
  assertEquals(sanitizeInstanceName(""), "unknown");
});

Deno.test("sandboxNameFor is repo plus flattened issue id", () => {
  assertEquals(sandboxNameFor("/home/mhw/dev/myswamp", "myswamp-xcy"), "myswamp-myswamp-xcy");
  assertEquals(sandboxNameFor("/repo/", "a/b"), "repo-a-b");
  assertEquals(sandboxNameFor("/repo", ""), "repo-task");
});

Deno.test("sandboxPathFor joins an absolute root", () => {
  assertEquals(
    sandboxPathFor("/srv/.worktrees", "/home/mhw/dev/myswamp", "myswamp-xcy"),
    "/srv/.worktrees/myswamp-myswamp-xcy",
  );
});

Deno.test("sandboxPathFor resolves a relative root against the source", () => {
  assertEquals(
    sandboxPathFor("../.worktrees", "/home/mhw/dev/myswamp/", "myswamp-xcy"),
    "/home/mhw/dev/myswamp/../.worktrees/myswamp-myswamp-xcy",
  );
});

Deno.test("sandboxVerdict never removes a dirty worktree", () => {
  assertEquals(sandboxVerdict({ dirty: true, merged: true, prState: "MERGED" }), {
    removable: false,
    reason: "uncommitted changes",
  });
});

Deno.test("sandboxVerdict removes merged and closed-PR worktrees", () => {
  assertEquals(sandboxVerdict({ dirty: false, merged: true, prState: null }), {
    removable: true,
    reason: null,
  });
  assertEquals(
    sandboxVerdict({ dirty: false, merged: false, prState: "closed" }),
    { removable: true, reason: null },
  );
});

Deno.test("sandboxVerdict keeps an unmerged, unclosed worktree", () => {
  assertEquals(sandboxVerdict({ dirty: false, merged: false, prState: "OPEN" }), {
    removable: false,
    reason: "PR is open",
  });
  assertEquals(sandboxVerdict({ dirty: false, merged: false, prState: null }), {
    removable: false,
    reason: "branch not merged",
  });
});

Deno.test("coerceWorkdirMap passes an object through", () => {
  assertEquals(coerceWorkdirMap({ a: "/x" }), { a: "/x" });
});

Deno.test("coerceWorkdirMap parses a JSON string", () => {
  assertEquals(coerceWorkdirMap('{"a":"/x"}'), { a: "/x" });
});

Deno.test("coerceWorkdirMap rejects an array", () => {
  assertThrows(() => coerceWorkdirMap(["a"]));
});

Deno.test("coerceWorkdirMap rejects malformed JSON", () => {
  assertThrows(() => coerceWorkdirMap("{not json"));
});

Deno.test("buildAgentInvocation gives claude the full prompt positionally", () => {
  const inv = buildAgentInvocation("claude", {
    prompt: "task",
    systemPrompt: "sys",
    workingDir: "/repo",
  });
  assertEquals(inv.binary, "claude");
  assertEquals(inv.args, [
    "-p",
    "--dangerously-skip-permissions",
    "sys\n\ntask",
  ]);
});

Deno.test("buildAgentInvocation splits opencode into task and system prompt", () => {
  const inv = buildAgentInvocation("opencode", {
    prompt: "task",
    systemPrompt: "sys",
    workingDir: "/repo",
  });
  assertEquals(inv.args, ["task", "--system-prompt=sys"]);
});

Deno.test("buildAgentInvocation sends kilo the dir and full prompt", () => {
  const inv = buildAgentInvocation("kilo", {
    prompt: "task",
    systemPrompt: "sys",
    workingDir: "/repo",
  });
  assertEquals(inv.args, [
    "run",
    "--auto",
    "--dir",
    "/repo",
    "--",
    "sys\n\ntask",
  ]);
});

Deno.test("buildTaskPrompt names the issue and the base branch", () => {
  const prompt = buildTaskPrompt(
    { id: "myswamp-1", title: "T", description: "D" },
    "/repo",
    "main",
  );
  if (
    !prompt.includes("myswamp-1") || !prompt.includes("/repo's main branch")
  ) {
    throw new Error(`unexpected prompt: ${prompt}`);
  }
});

Deno.test("runnerInstruction names the branch and forbids the control repo", () => {
  const instruction = runnerInstruction({
    workdir: "/repo",
    branch: "bd/x",
    base: "main",
  });
  if (!instruction.includes("bd/x") || !instruction.includes("control-plane")) {
    throw new Error(`unexpected instruction: ${instruction}`);
  }
});

Deno.test("renderManifestReport lists candidates and dropped reasons", () => {
  const report = renderManifestReport({
    generatedAt: "2026-10-15T00:00:00Z",
    base: "main",
    agent: "kilo",
    candidates: [{
      id: "myswamp-1",
      title: "T",
      priority: 1,
      issueType: "task",
      workdir: "/repo",
      branch: "bd/myswamp-1",
      base: "main",
      agent: "kilo",
      task: "go",
    }],
    dropped: [{ id: "myswamp-2", reason: "label:blocked" }],
    unmapped: ["myswamp-3"],
    truncated: false,
  });
  if (!report.includes("myswamp-1") || !report.includes("label:blocked")) {
    throw new Error(`unexpected report: ${report}`);
  }
  if (!report.includes("myswamp-3")) {
    throw new Error("unmapped issue missing from report");
  }
});

Deno.test("renderSweepReport renders the result table", () => {
  const report = renderSweepReport({
    sweptAt: "2026-10-15T00:00:00Z",
    candidateCount: 1,
    succeeded: 1,
    failed: 0,
    results: [{
      id: "myswamp-1",
      branch: "bd/myswamp-1",
      workdir: "/repo",
      success: true,
      exitCode: 0,
    }],
  });
  if (!report.includes("| myswamp-1 |") || !report.includes("ok")) {
    throw new Error(`unexpected report: ${report}`);
  }
});
