/**
 * Unit tests for the pure helpers in {@link ./repo_doctor.ts}.
 *
 * @module
 */

import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  isCovered,
  offendingLines,
  relative,
  renderReport,
} from "./repo_doctor.ts";

Deno.test("relative strips the repo root prefix", () => {
  assertEquals(
    relative("/home/maphew/repo", "/home/maphew/repo/workflows/a.yaml"),
    "workflows/a.yaml",
  );
  assertEquals(
    relative("/home/maphew/repo/", "/home/maphew/repo/workflows/a.yaml"),
    "workflows/a.yaml",
  );
});

Deno.test("relative leaves non-rooted paths untouched", () => {
  assertEquals(relative("/home/maphew/repo", "/etc/hosts"), "/etc/hosts");
});

Deno.test("offendingLines flags any absolute home path with line numbers", () => {
  const text = [
    "const a = '/home/alice/project';",
    "// '/Users/bob/other' is also non-portable",
    "const b = 'relative/path';",
  ].join("\n");
  const hits = offendingLines(text);
  assertEquals(hits.length, 2);
  assertEquals(hits[0].line, 1);
  assertEquals(hits[0].match, "/home/alice");
  assertEquals(hits[1].line, 2);
  assertEquals(hits[1].match, "/Users/bob");
});

Deno.test("offendingLines returns nothing for portable text", () => {
  assertEquals(offendingLines("projectDir: .\n").length, 0);
});

Deno.test("isCovered matches exact, directory-prefix, and parent rules", () => {
  assertEquals(isCovered(".swamp/data/", [".swamp/data/"]), true);
  assertEquals(isCovered(".swamp/data/", [".swamp/"]), true);
  assertEquals(isCovered(".swamp/", [".swamp/data/"]), true);
  assertEquals(isCovered(".swamp/data/", [".swamp/bundles/"]), false);
});

Deno.test("isCovered ignores comments and negations", () => {
  assertEquals(isCovered(".swamp/data/", ["# .swamp/data/"]), false);
  assertEquals(isCovered(".swamp/data/", ["!.swamp/data/"]), false);
});

Deno.test("renderReport says healthy when there are no findings", () => {
  const md = renderReport({
    projectDir: ".",
    healthy: true,
    errorCount: 0,
    warningCount: 0,
    findings: [],
  });
  assertEquals(md.includes("healthy"), true);
  assertEquals(md.includes("No findings."), true);
});

Deno.test("renderReport groups findings by severity", () => {
  const md = renderReport({
    projectDir: ".",
    healthy: false,
    errorCount: 1,
    warningCount: 1,
    findings: [
      {
        check: "hardcoded-home-path",
        severity: "error",
        file: "a.ts",
        line: 3,
        message: "Absolute home path /home/x is hardcoded",
        detail: "const a = '/home/x';",
      },
      {
        check: "gitignore-coverage",
        severity: "warning",
        file: ".gitignore",
        line: null,
        message: "missing",
        detail: null,
      },
    ],
  });
  assertEquals(md.includes("## error (1)"), true);
  assertEquals(md.includes("## warning (1)"), true);
  assertEquals(md.includes("`a.ts:3`"), true);
});
