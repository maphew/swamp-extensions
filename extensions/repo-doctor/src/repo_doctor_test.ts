/**
 * Unit tests for the pure helpers in {@link ./repo_doctor.ts}.
 *
 * @module
 */

import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  declaredScheduleOf,
  diffSchedules,
  extractScriptPaths,
  extractShellInvocations,
  inspectScript,
  isCovered,
  isScaffoldingSource,
  normalizePath,
  offendingLines,
  parseDenoCheckOutput,
  parseManifestList,
  parseServeHealthJson,
  parseWorkflowSearchJson,
  relative,
  renderReport,
  resolveScriptPath,
  shellWords,
  stripAnsi,
  workflowNameOf,
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

Deno.test("shellWords keeps quoted segments joined and strips quotes", () => {
  assertEquals(
    shellWords("'/repo root'/.kilo/agents/run.sh --flag 'two words'"),
    ["/repo root/.kilo/agents/run.sh", "--flag", "two words"],
  );
});

Deno.test("extractScriptPaths finds scripts and skips data paths", () => {
  const command =
    "'/var/home/matt/dev/myswamp'/.kilo/agents/ready-queue.sh '{}' '0' > /tmp/bd-ready-manifest.json";
  assertEquals(
    extractScriptPaths(command),
    ["/var/home/matt/dev/myswamp/.kilo/agents/ready-queue.sh"],
  );
  assertEquals(extractScriptPaths("python3 -c 'print(1)'"), []);
  assertEquals(extractScriptPaths("echo $HOME/scripts/run.sh"), []);
  assertEquals(extractScriptPaths("https://example.com/run.sh"), []);
  assertEquals(extractScriptPaths("./tools/check"), ["./tools/check"]);
});

Deno.test("normalizePath collapses dot segments without node:path", () => {
  assertEquals(normalizePath("/a/b/../c/./d"), "/a/c/d");
  assertEquals(normalizePath("../x/../y"), "../y");
});

Deno.test("resolveScriptPath resolves relative paths and expands ~", () => {
  assertEquals(resolveScriptPath("./a.sh", "/repo"), "/repo/a.sh");
  assertEquals(
    resolveScriptPath("~/bin/a.sh", "/repo", "/home/me"),
    "/home/me/bin/a.sh",
  );
  assertEquals(resolveScriptPath("/abs/a.sh", "/repo"), "/abs/a.sh");
  assertEquals(resolveScriptPath("./a.sh", "."), "a.sh");
  assertEquals(resolveScriptPath("./a.sh", ""), "a.sh");
});

Deno.test("inspectScript reports exec bit and shebang from a temp file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "repo-doctor-" });
  try {
    const script = `${dir}/run.sh`;
    await Deno.writeTextFile(script, "#!/usr/bin/env bash\necho hi\n");
    await Deno.chmod(script, 0o755);
    const executable = await inspectScript(script);
    assertEquals(executable.exists, true);
    assertEquals(executable.executable, true);
    assertEquals(executable.shebang, "#!/usr/bin/env bash");

    await Deno.chmod(script, 0o644);
    const plain = await inspectScript(script);
    assertEquals(plain.executable, false);

    const noShebang = `${dir}/plain.sh`;
    await Deno.writeTextFile(noShebang, "echo hi\n");
    assertEquals((await inspectScript(noShebang)).shebang, null);

    const missing = await inspectScript(`${dir}/nope.sh`);
    assertEquals(missing, { exists: false, executable: false, shebang: null });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("extractShellInvocations reads command/shell model_method steps", () => {
  const workflow = {
    name: "demo",
    jobs: [{
      name: "job",
      steps: [{
        name: "run-helper",
        task: {
          type: "model_method",
          modelType: "command/shell",
          inputs: {
            run: "./scripts/run.sh",
            workingDir: "/repo",
          },
        },
      }],
    }],
  };
  assertEquals(extractShellInvocations(workflow), [{
    step: "run-helper",
    command: "./scripts/run.sh",
    workingDir: "/repo",
  }]);
  assertEquals(workflowNameOf(workflow), "demo");
  assertEquals(declaredScheduleOf(workflow), null);
});

Deno.test("declaredScheduleOf reads a quoted or plain cron", () => {
  assertEquals(
    declaredScheduleOf({ trigger: { schedule: "  */5 * * * *  " } }),
    "*/5 * * * *",
  );
  assertEquals(declaredScheduleOf({ trigger: {} }), null);
  assertEquals(declaredScheduleOf({}), null);
});

Deno.test("diffSchedules reports unregistered, mismatched, and undeclared", () => {
  const declared = [
    { workflow: "keep", file: "workflows/keep.yaml", cron: "0 1 * * *" },
    { workflow: "missing", file: "workflows/missing.yaml", cron: "0 2 * * *" },
    { workflow: "changed", file: "workflows/changed.yaml", cron: "0 3 * * *" },
  ];
  const live = [
    { workflow: "keep", file: null, cron: "0 1 * * *" },
    { workflow: "changed", file: null, cron: "30 3 * * *" },
    { workflow: "extra", file: null, cron: "0 4 * * *" },
  ];
  assertEquals(diffSchedules(declared, live), [
    {
      kind: "declared-unregistered",
      workflow: "missing",
      declared: "0 2 * * *",
      live: null,
      file: "workflows/missing.yaml",
    },
    {
      kind: "mismatch",
      workflow: "changed",
      declared: "0 3 * * *",
      live: "30 3 * * *",
      file: "workflows/changed.yaml",
    },
    {
      kind: "registered-undeclared",
      workflow: "extra",
      declared: null,
      live: "0 4 * * *",
      file: null,
    },
  ]);
});

Deno.test("parseWorkflowSearchJson reads trigger schedules", () => {
  const raw = JSON.stringify({
    query: "",
    results: [
      { name: "a", trigger: { schedule: "0 1 * * *" } },
      { name: "b" },
      { name: "c", trigger: { schedule: "  */5 * * * * " } },
    ],
  });
  assertEquals(parseWorkflowSearchJson(raw), [
    { workflow: "a", file: null, cron: "0 1 * * *" },
    { workflow: "c", file: null, cron: "*/5 * * * *" },
  ]);
  assertEquals(parseWorkflowSearchJson("not json"), []);
});

Deno.test("parseServeHealthJson reads scheduling.schedules", () => {
  const raw = JSON.stringify({
    scheduling: {
      enabled: true,
      schedules: [{
        workflowId: "id",
        workflowName: "a",
        cronExpression: "0 1 * * *",
        nextRun: null,
        running: false,
        queued: 0,
        oldestQueuedAt: null,
        lastQueueDelayMs: null,
      }],
    },
  });
  assertEquals(parseServeHealthJson(raw), [
    { workflow: "a", file: null, cron: "0 1 * * *" },
  ]);
});
