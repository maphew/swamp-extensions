/**
 * Unit tests for the pure helpers in {@link ./repo_doctor.ts}.
 *
 * @module
 */

import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  isCovered,
  isScaffoldingSource,
  offendingLines,
  parseDenoCheckOutput,
  parseManifestList,
  relative,
  renderReport,
  stripAnsi,
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

Deno.test("parseManifestList reads a flat additionalFiles block", () => {
  const manifest = [
    "name: '@maphew/example'",
    "version: 2026.10.14.1",
    "models:",
    "  - src/model.ts",
    "additionalFiles:",
    "  - README.md",
    "  - LICENSE",
    "platforms:",
    "  - linux-x86_64",
  ].join("\n");
  assertEquals(parseManifestList(manifest, "additionalFiles"), [
    "README.md",
    "LICENSE",
  ]);
});

Deno.test("parseManifestList returns empty when the key is absent", () => {
  assertEquals(
    parseManifestList("name: x\nversion: 1\n", "additionalFiles"),
    [],
  );
});

Deno.test("parseManifestList strips quotes", () => {
  const manifest = "binaries:\n  - 'tide-view.mjs'\n";
  assertEquals(parseManifestList(manifest, "binaries"), ["tide-view.mjs"]);
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

const ESC = "\x1b";

Deno.test("stripAnsi removes terminal colour codes", () => {
  assertEquals(
    stripAnsi(`${ESC}[1mTS2307 ${ESC}[0m[${ESC}[31mERROR${ESC}[0m]`),
    "TS2307 [ERROR]",
  );
});

Deno.test("isScaffoldingSource accepts TS sources and rejects d.ts and other files", () => {
  assertEquals(isScaffoldingSource(".kilo/plugins/bead-title.ts"), true);
  assertEquals(isScaffoldingSource("x/y.tsx"), true);
  assertEquals(isScaffoldingSource("x/y.mts"), true);
  assertEquals(isScaffoldingSource("x/y.d.ts"), false);
  assertEquals(isScaffoldingSource("x/y.json"), false);
  assertEquals(isScaffoldingSource("x/README.md"), false);
});

Deno.test("parseDenoCheckOutput pairs diagnostics with their locations", () => {
  const raw = [
    `${ESC}[1mTS2307 ${ESC}[0m[${ESC}[31mERROR${ESC}[0m]: Import "@kilocode/plugin" not a dependency`,
    "  hint: try running `deno add npm:@kilocode/plugin`",
    "    at file:///repo/.kilo/plugins/bead-title.ts:8:43",
    "",
    "TS7031 [ERROR]: Binding element 'tool' implicitly has an 'any' type.",
    '      async "tool.execute.after"({ tool, sessionID, args }) {',
    "                                   ~~~~",
    "    at file:///repo/.kilo/plugins/bead-title.ts:41:36",
    "",
    "TS6133 [WARN]: 'x' is declared but never used.",
    "    at file:///repo/.pi/extensions/swamp-audit.ts:3:7",
  ].join("\n");

  const findings = parseDenoCheckOutput(raw, "/repo");

  assertEquals(findings.length, 3);
  assertEquals(findings[0], {
    check: "scaffolding-typecheck",
    severity: "error",
    file: ".kilo/plugins/bead-title.ts",
    line: 8,
    message: 'TS2307: Import "@kilocode/plugin" not a dependency',
    detail: null,
  });
  assertEquals(findings[1].file, ".kilo/plugins/bead-title.ts");
  assertEquals(findings[1].line, 41);
  assertEquals(findings[2], {
    check: "scaffolding-typecheck",
    severity: "warning",
    file: ".pi/extensions/swamp-audit.ts",
    line: 3,
    message: "TS6133: 'x' is declared but never used.",
    detail: null,
  });
});

Deno.test("parseDenoCheckOutput ignores hint lines and location-less output", () => {
  const raw = [
    "Check .pi/extensions/swamp-audit.ts",
    "TS7006 [ERROR]: Parameter 'pi' implicitly has an 'any' type.",
    "export default function swampAudit(pi) {",
    "                                   ~~",
    "    at file:///repo/.pi/extensions/swamp-audit.ts:9:36",
    "",
    "at file:///repo/ignored.ts:1:1",
  ].join("\n");

  const findings = parseDenoCheckOutput(raw, "/repo");
  assertEquals(findings.length, 1);
  assertEquals(findings[0].file, ".pi/extensions/swamp-audit.ts");
  assertEquals(findings[0].line, 9);
});

Deno.test("parseDenoCheckOutput returns nothing for a clean run", () => {
  assertEquals(
    parseDenoCheckOutput("Check .pi/extensions/swamp-audit.ts\n", "/repo"),
    [],
  );
});

Deno.test("parseDenoCheckOutput decodes percent-encoded file URLs", () => {
  const raw =
    "TS7006 [ERROR]: Parameter 'x' implicitly has an 'any' type.\n  at file:///repo/a%20b/x.ts:2:5";
  const findings = parseDenoCheckOutput(raw, "/repo");
  assertEquals(findings[0].file, "a b/x.ts");
});
