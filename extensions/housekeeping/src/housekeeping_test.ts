/**
 * Unit tests for the pure parsers and classifiers in
 * {@link ./housekeeping.ts}. The I/O methods are exercised by the smoke test
 * against a real checkout; these keep the string handling honest.
 *
 * @module
 */

import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  countStatusFiles,
  globToRegExp,
  isExpired,
  isOlderThan,
  matchesGlob,
  parseDfAvailableBytes,
  parseForEachRef,
  parseOrphans,
  parseStashList,
  parseStatusHeader,
  parseWorktreeList,
  renderReport,
  versionToken,
} from "./housekeeping.ts";

Deno.test("parseStatusHeader reads branch, upstream, ahead/behind", () => {
  const h = parseStatusHeader(
    "## main...origin/main [ahead 2, behind 3]",
  );
  assertEquals(h.currentBranch, "main");
  assertEquals(h.upstream, "origin/main");
  assertEquals(h.ahead, 2);
  assertEquals(h.behind, 3);
  assertEquals(h.gone, false);
});

Deno.test("parseStatusHeader detects gone upstream", () => {
  const h = parseStatusHeader("## work/mk1...origin/work/mk1 [gone]");
  assertEquals(h.gone, true);
  assertEquals(h.currentBranch, "work/mk1");
});

Deno.test("parseStatusHeader detects detached HEAD", () => {
  const h = parseStatusHeader("## HEAD (no branch)");
  assertEquals(h.detached, true);
  assertEquals(h.currentBranch, null);
});

Deno.test("parseStatusHeader ignores non-header lines", () => {
  assertEquals(parseStatusHeader(" M file.txt").detached, false);
});

Deno.test("countStatusFiles separates modified from untracked", () => {
  assertEquals(
    countStatusFiles([" M a.ts", "?? b.ts", "?? c/", "R  old -> new"]),
    { dirty: 2, untracked: 2 },
  );
});

Deno.test("parseForEachRef reads gone and tracking states", () => {
  const out = [
    "main\torigin/main\t",
    "wip/a\t\t",
    "wip/b\torigin/wip/b\t[gone]",
    "wip/c\torigin/wip/c\t[ahead 1, behind 2]",
  ].join("\n");
  const branches = parseForEachRef(out);
  assertEquals(branches.length, 4);
  assertEquals(branches[0].upstream, "origin/main");
  assertEquals(branches[1].upstream, null);
  assertEquals(branches[2].gone, true);
  assertEquals(branches[3].ahead, 1);
  assertEquals(branches[3].behind, 2);
});

Deno.test("parseWorktreeList parses blocks and flags", () => {
  const out = [
    "worktree /repo",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /repo/.worktrees/wt",
    "HEAD def",
    "branch refs/heads/wip",
    "",
    "worktree /tmp/gone",
    "HEAD 123",
    "detached",
    "prunable gitdir file points to non-existent location",
    "",
  ].join("\n");
  const wts = parseWorktreeList(out);
  assertEquals(wts.length, 3);
  assertEquals(wts[0].isMain, true);
  assertEquals(wts[1].branch, "wip");
  assertEquals(wts[2].detached, true);
  assertEquals(wts[2].prunable, true);
});

Deno.test("parseStashList splits ref, date, and subject", () => {
  const out = [
    "stash@{0}|2026-07-24 10:00:00 -0700|WIP on main: keep me",
    "stash@{1}|2026-07-23 09:00:00 -0700|On wip: a|b",
  ].join("\n");
  const stashes = parseStashList(out);
  assertEquals(stashes.length, 2);
  assertEquals(stashes[0].ref, "stash@{0}");
  assertEquals(stashes[1].subject, "On wip: a|b");
});

Deno.test("globToRegExp anchors and escapes", () => {
  assertEquals(globToRegExp("beads-bd-tests-*").test("beads-bd-tests-x"), true);
  assertEquals(globToRegExp("*.tmp").test("x.tmp"), true);
  assertEquals(globToRegExp("*.tmp").test("x.tmp.bak"), false);
  assertEquals(globToRegExp("a.b").test("axb"), false);
});

Deno.test("matchesGlob handles question marks", () => {
  assertEquals(matchesGlob("tmp1", "tmp?"), true);
  assertEquals(matchesGlob("tmp12", "tmp?"), false);
});

Deno.test("isOlderThan respects the threshold", () => {
  const now = Date.parse("2026-07-24T12:00:00Z");
  assertEquals(isOlderThan("2026-07-24T00:00:00Z", now, 24), false);
  assertEquals(isOlderThan("2026-07-22T00:00:00Z", now, 24), true);
  assertEquals(isOlderThan(null, now, 24), false);
  assertEquals(isOlderThan("not-a-date", now, 24), false);
});

Deno.test("isExpired checks the past", () => {
  const now = Date.parse("2026-07-24T12:00:00Z");
  assertEquals(isExpired("2026-07-24T11:59:00Z", now), true);
  assertEquals(isExpired("2026-07-24T12:01:00Z", now), false);
  assertEquals(isExpired(null, now), false);
});

Deno.test("versionToken extracts the first semver", () => {
  assertEquals(versionToken("bd version 1.3.1 (Homebrew)"), "1.3.1");
  assertEquals(versionToken("1.2.2"), "1.2.2");
  assertEquals(versionToken("none"), null);
});

Deno.test("parseDfAvailableBytes reads the available column", () => {
  const out = [
    "Filesystem     1024-blocks     Used Available Capacity Mounted on",
    "/dev/sda1        419430400 10000000 377681152      3% /",
  ].join("\n");
  assertEquals(parseDfAvailableBytes(out), 377681152 * 1024);
  assertEquals(parseDfAvailableBytes("header only\n"), null);
});

Deno.test("renderReport groups findings and closes with the open question", () => {
  const md = renderReport({
    projectDir: "/repo",
    checkedAt: "2026-07-24T12:00:00Z",
    verdict: "issues",
    errorCount: 0,
    warningCount: 1,
    infoCount: 0,
    findings: [
      {
        category: "git",
        severity: "warning",
        message: "dirty tree",
        detail: null,
        target: null,
      },
    ],
  });
  assertEquals(md.includes("## warning (1)"), true);
  assertEquals(md.includes("`/repo`"), true);
  assertEquals(md.includes("isn't on any list"), true);
});

Deno.test("renderReport says clean when there are no findings", () => {
  const md = renderReport({
    projectDir: ".",
    checkedAt: "2026-07-24T12:00:00Z",
    verdict: "healthy",
    errorCount: 0,
    warningCount: 0,
    infoCount: 0,
    findings: [],
  });
  assertEquals(md.includes("Nothing to report"), true);
});

Deno.test("parseOrphans coerces bd's null no-orphans output to empty", () => {
  assertEquals(parseOrphans("null"), []);
});

Deno.test("parseOrphans normalizes issue_id and title", () => {
  assertEquals(
    parseOrphans(
      JSON.stringify([
        { issue_id: "myswamp-1", title: "done work", status: "open" },
      ]),
    ),
    [{ id: "myswamp-1", title: "done work", status: "open" }],
  );
});
