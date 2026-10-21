/**
 * Swamp repository doctor model.
 *
 * Audits the local swamp repo for portability and hygiene problems that the
 * CLI does not surface as failures:
 *
 *   - absolute home paths hardcoded into model/workflow sources (breaks the
 *     repo the moment it is cloned to a different machine or username)
 *   - pulled extensions whose source files are missing (the types resolve in
 *     the lockfile but blow up at run time)
 *   - `.swamp/` artifacts that are not covered by `.gitignore`
 *
 * Methods:
 *   - `scan`       run every check and write a combined report
 *   - `findPaths`  hardcoded absolute-path findings only
 *   - `checkExtensions`  pulled-extension integrity only
 *   - `checkGitignore`   .swamp/ gitignore coverage only
 *
 * @module
 */

import { z } from "npm:zod@4";

// ---------- schemas ---------------------------------------------------------

const FindingSchema = z.object({
  check: z.string().describe("Which check produced this finding"),
  severity: z.enum(["error", "warning", "info"]),
  file: z.string().describe("Repo-relative path of the offending file"),
  line: z.number().int().nullable().describe(
    "1-based line number, null if file-level",
  ),
  message: z.string(),
  detail: z.string().nullable(),
});

const PathsReportSchema = z.object({
  scannedFiles: z.number().int(),
  findings: z.array(FindingSchema),
});

const ExtensionSchema = z.object({
  name: z.string(),
  version: z.string(),
  installed: z.boolean(),
  missingFiles: z.array(z.string()),
});

const ExtensionsReportSchema = z.object({
  lockfilePresent: z.boolean(),
  extensions: z.array(ExtensionSchema),
  missing: z.array(z.string()),
});

const GitignoreReportSchema = z.object({
  gitignorePresent: z.boolean(),
  ignored: z.array(z.string()),
  expected: z.array(z.string()),
  uncovered: z.array(z.string()),
});

const ScaffoldingReportSchema = z.object({
  projectDir: z.string(),
  denoBin: z.string().nullable().describe(
    "Resolved deno executable, or null when the check was skipped",
  ),
  skipped: z.boolean().describe("True when no deno executable was found"),
  skipReason: z.string().nullable(),
  checkedDirs: z.array(z.string()).describe(
    "Scaffolding dirs that existed and were typechecked",
  ),
  missingDirs: z.array(z.string()).describe(
    "Configured scaffolding dirs absent from this checkout",
  ),
  packageRoots: z.array(z.string()).describe(
    "Package roots deno check ran from, chosen so npm deps resolve",
  ),
  checkedFiles: z.number().int(),
  findings: z.array(FindingSchema),
  errorCount: z.number().int(),
  warningCount: z.number().int(),
});

const ScanReportSchema = z.object({
  projectDir: z.string(),
  healthy: z.boolean(),
  errorCount: z.number().int(),
  warningCount: z.number().int(),
  findings: z.array(FindingSchema),
});

const GlobalArgsSchema = z.object({
  projectDir: z.string().default(".").describe(
    "Swamp repo root to audit. Defaults to the current directory so the model stays portable across machines.",
  ),
  sourceDirs: z.array(z.string()).default([
    "extensions/models",
    "workflows",
  ]).describe("Repo-relative directories scanned for hardcoded absolute paths"),
  includeWorkflows: z.boolean().default(true).describe(
    "Also scan workflows/ for hardcoded absolute paths",
  ),
  scaffoldingDirs: z.array(z.string()).default([
    ".kilo/plugins",
    ".opencode/plugins",
    ".pi/extensions",
  ]).describe(
    "Repo-relative directories holding generated agent scaffolding to typecheck",
  ),
  denoBin: z.string().default("deno").describe(
    "deno executable used for scaffolding typechecks; falls back to DENO_BIN and ~/.swamp/deno/deno",
  ),
});

// ---------- helpers ---------------------------------------------------------

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type Finding = z.infer<typeof FindingSchema>;
type ModelContext = {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  createFileWriter: (spec: string, instance: string) => {
    writeText: (text: string) => Promise<{ name: string }>;
  };
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
};

/** Absolute paths under a home directory: the single most common portability break. */
const HOME_PATH_RE = /(\/home\/[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+)/g;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".swamp",
  "vendor",
  "dist",
  "build",
]);

async function* walk(dir: string): AsyncGenerator<string> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name)) continue;
        yield* walk(`${dir}/${entry.name}`);
      } else if (entry.isFile) {
        yield `${dir}/${entry.name}`;
      }
    }
  } catch {
    // Missing or unreadable directory: yield nothing rather than throw. The
    // read error surfaces from iterating `Deno.readDir`, not from creating it.
    return;
  }
}

/**
 * Read a flat YAML list block (`additionalFiles:`, `binaries:`) from a pulled
 * extension manifest. Only scalar list items count; nested mappings are
 * ignored. Used to verify every declared file actually landed on disk.
 */
export function parseManifestList(manifest: string, key: string): string[] {
  const re = new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+\\S+.*\\n?)*)`, "m");
  const block = re.exec(manifest)?.[1];
  if (!block) return [];
  return block
    .split("\n")
    .map((line) => /^\s+-\s+(\S+)/.exec(line)?.[1])
    .filter((v): v is string => v !== undefined)
    .map((v) => v.replace(/^["']|["']$/g, ""));
}

/**
 * Strip a leading repo root from an absolute path, leaving a repo-relative
 * path. Returns the input unchanged when it is not under the root.
 */
export function relative(projectDir: string, abs: string): string {
  const root = projectDir.endsWith("/") ? projectDir : `${projectDir}/`;
  return abs.startsWith(root) ? abs.slice(root.length) : abs;
}

/**
 * Flag *any* absolute home path, not just this machine's. A `/home/<user>/...`
 * literal in source is non-portable whether or not the username matches the
 * current machine — and a path left behind by a previous machine is precisely
 * the case that breaks on someone else's clone.
 *
 * Documentation-style references are excluded by requiring the path to be
 * followed by a real directory-ish segment or end at a path boundary.
 */
export function offendingLines(
  text: string,
): Array<{ line: number; match: string; text: string }> {
  const out: Array<{ line: number; match: string; text: string }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i];
    for (const match of current.matchAll(HOME_PATH_RE)) {
      out.push({ line: i + 1, match: match[0], text: current.trim() });
    }
  }
  return out;
}

async function findHardcodedPaths(
  ctx: ModelContext,
  overrides?: { dirs?: string[] },
): Promise<{ scannedFiles: number; findings: Finding[] }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const dirs = overrides?.dirs ?? cfg.sourceDirs;
  const findings: Finding[] = [];
  let scannedFiles = 0;

  const walkDirs = cfg.includeWorkflows
    ? dirs
    : dirs.filter((d) => !d.startsWith("workflows"));

  for (const dir of walkDirs) {
    for await (const abs of walk(`${cfg.projectDir}/${dir}`)) {
      if (!/\.(ts|tsx|js|mjs|yaml|yml|json|md)$/.test(abs)) continue;
      scannedFiles++;
      let text: string;
      try {
        text = new TextDecoder().decode(await Deno.readFile(abs));
      } catch {
        continue;
      }
      for (const hit of offendingLines(text)) {
        findings.push({
          check: "hardcoded-home-path",
          severity: "error",
          file: relative(cfg.projectDir, abs),
          line: hit.line,
          message: `Absolute home path ${hit.match} is hardcoded`,
          detail: hit.text,
        });
      }
    }
  }

  ctx.logger.info(
    "Scanned {files} file(s) for hardcoded paths, {n} finding(s)",
    {
      files: scannedFiles,
      n: findings.length,
    },
  );
  return { scannedFiles, findings };
}

async function checkExtensions(
  ctx: ModelContext,
): Promise<z.infer<typeof ExtensionsReportSchema>> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const lockfile = `${cfg.projectDir}/.swamp/extensions.lock.yaml`;
  let lockfilePresent = false;
  try {
    await Deno.stat(lockfile);
    lockfilePresent = true;
  } catch {
    // fall through
  }

  const found: Array<z.infer<typeof ExtensionSchema>> = [];
  const missing: string[] = [];

  for await (const abs of walk(`${cfg.projectDir}/.swamp/pulled-extensions`)) {
    if (!abs.endsWith("manifest.yaml")) continue;
    let manifest: string;
    try {
      manifest = new TextDecoder().decode(await Deno.readFile(abs));
    } catch {
      continue;
    }
    const name = /\nname:\s*"?([^"\n]+)"?/.exec(manifest)?.[1]?.trim() ?? "";
    const version = /\nversion:\s*"?([^"\n]+)"?/.exec(manifest)?.[1]?.trim() ??
      "";
    const extDir = abs.slice(0, abs.length - "/manifest.yaml".length);

    const missingFiles: string[] = [];
    // Every file the manifest declares must actually be on disk under files/.
    for (const declared of parseManifestList(manifest, "additionalFiles")) {
      if (!(await exists(`${extDir}/files/${declared}`))) {
        missingFiles.push(declared);
      }
    }
    // The concrete failure mode: extension dir exists but has no files/ tree.
    let hasFiles = true;
    try {
      await Deno.stat(`${extDir}/files`);
    } catch {
      hasFiles = false;
    }
    if (!hasFiles) {
      missingFiles.push(
        "files/ (directory absent — run `swamp extension install`)",
      );
    }

    const installed = hasFiles;
    if (!installed) missing.push(name || relative(cfg.projectDir, extDir));
    found.push({ name, version, installed, missingFiles });
  }

  found.sort((a, b) => a.name.localeCompare(b.name));
  missing.sort();

  ctx.logger.info("Checked {n} pulled extension(s), {m} with missing sources", {
    n: found.length,
    m: missing.length,
  });
  return { lockfilePresent, extensions: found, missing };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function realPathOf(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return path.replace(/\/+$/, "") || ".";
  }
}

const EXPECTED_IGNORED = [
  ".swamp/bundles/",
  ".swamp/data/",
  ".swamp/outputs/",
  ".swamp/logs/",
  ".swamp/pulled-extensions/",
  ".kilo/skills/",
];

/**
 * A gitignore rule covers a path when it matches the path itself, or when it
 * is a directory rule (`dir/`) that is a prefix of the path. Negations (`!x`)
 * re-open a path rather than cover it, so they are ignored here.
 */
export function isCovered(entry: string, rules: string[]): boolean {
  const target = entry.replace(/\/$/, "");
  for (const rule of rules) {
    if (rule.startsWith("!")) continue;
    const clean = rule.replace(/^\//, "").replace(/\/$/, "");
    if (clean === "" || clean.startsWith("#")) continue;
    if (clean === target) return true;
    if (target.startsWith(`${clean}/`)) return true;
    if (clean.startsWith(`${target}/`)) return true;
  }
  return false;
}

async function checkGitignore(
  ctx: ModelContext,
): Promise<z.infer<typeof GitignoreReportSchema>> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const path = `${cfg.projectDir}/.gitignore`;
  let gitignorePresent = false;
  let text = "";
  try {
    text = new TextDecoder().decode(await Deno.readFile(path));
    gitignorePresent = true;
  } catch {
    // fall through
  }

  const ignored = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  const uncovered = EXPECTED_IGNORED.filter((entry) =>
    !isCovered(entry, ignored)
  );

  return { gitignorePresent, ignored, expected: EXPECTED_IGNORED, uncovered };
}

// ---------- scaffolding typecheck -------------------------------------------

// deno-lint-ignore no-control-regex -- matching ANSI colour codes requires the ESC control character
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const DIAG_RE = /^TS(\d+)\s+\[(ERROR|WARN)\]:\s*(.*)$/;
const AT_RE = /\bat (file:\/\/\S+?):(\d+):(\d+)\b/;
const SCAFFOLDING_SOURCE_RE = /\.(ts|tsx|mts|cts)$/;

/** Strip ANSI colour codes so deno's pretty diagnostics parse deterministically. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Only TypeScript sources are typechecked; skip maps, markdown, and d.ts. */
export function isScaffoldingSource(path: string): boolean {
  if (path.endsWith(".d.ts")) return false;
  return SCAFFOLDING_SOURCE_RE.test(path);
}

/** `file:///home/u/repo/x.ts` -> `/home/u/repo/x.ts` (no node: dependency). */
function fileUrlToPath(url: string): string {
  let path = url.replace(/^file:\/\//, "");
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function dirOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

/**
 * Parse `deno check` diagnostics into findings.
 *
 * Deno prints each diagnostic as a `TS<code> [ERROR|WARN]: <message>` header
 * optionally followed by a code snippet and an `at file://<path>:<line>:<col>`
 * location. We pair each header with the next location line and ignore the
 * snippet, which varies in shape between deno versions.
 */
export function parseDenoCheckOutput(
  raw: string,
  projectDir: string,
): Finding[] {
  const findings: Finding[] = [];
  let pending:
    | { code: string; severity: "error" | "warning"; message: string }
    | null = null;

  for (const rawLine of stripAnsi(raw).split("\n")) {
    const diag = DIAG_RE.exec(rawLine);
    if (diag) {
      pending = {
        code: `TS${diag[1]}`,
        severity: diag[2] === "ERROR" ? "error" : "warning",
        message: diag[3].trim(),
      };
      continue;
    }
    if (!pending) continue;
    const at = AT_RE.exec(rawLine);
    if (!at) continue;
    findings.push({
      check: "scaffolding-typecheck",
      severity: pending.severity,
      file: relative(projectDir, fileUrlToPath(at[1])),
      line: Number(at[2]),
      message: `${pending.code}: ${pending.message}`,
      detail: null,
    });
    pending = null;
  }
  return findings;
}

async function collectScaffoldingFiles(dirAbs: string): Promise<string[]> {
  const files: string[] = [];
  for await (const abs of walk(dirAbs)) {
    if (isScaffoldingSource(abs)) files.push(abs);
  }
  files.sort();
  return files;
}

/**
 * Walk up from a scaffolding dir to the nearest package root so `deno check`
 * resolves npm deps (e.g. `@kilocode/plugin` in `.kilo/node_modules`) from the
 * same context the plugin actually loads in.
 */
async function nearestPackageRoot(
  startAbs: string,
  projectDir: string,
): Promise<string> {
  const root = projectDir.replace(/\/+$/, "");
  let dir = startAbs.replace(/\/+$/, "");
  while (dir.length >= root.length) {
    for (const marker of ["package.json", "deno.json", "deno.jsonc"]) {
      if (await exists(`${dir}/${marker}`)) return dir;
    }
    if (dir === root) break;
    const parent = dirOf(dir);
    if (parent === dir || !parent.startsWith(root)) break;
    dir = parent;
  }
  return root || ".";
}

async function resolveDenoBin(explicit: string): Promise<string | null> {
  const home = Deno.env.get("HOME") ?? "";
  const candidates: string[] = [];
  for (
    const candidate of [
      explicit,
      Deno.env.get("DENO_BIN") ?? "",
      "deno",
      `${home}/.swamp/deno/deno`,
    ]
  ) {
    if (candidate && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }
  for (const bin of candidates) {
    if (bin.includes("/") && !(await exists(bin))) continue;
    try {
      const out = await new Deno.Command(bin, {
        args: ["--version"],
        stdout: "null",
        stderr: "null",
      }).output();
      if (out.code === 0) return bin;
    } catch {
      // candidate not on PATH or not executable; try the next
    }
  }
  return null;
}

async function runDenoCheck(
  denoBin: string,
  cwd: string,
  files: string[],
): Promise<{ code: number; stderr: string }> {
  const command = new Deno.Command(denoBin, {
    args: ["check", ...files],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    code: output.code,
    stderr: new TextDecoder().decode(output.stderr) +
      new TextDecoder().decode(output.stdout),
  };
}

async function checkScaffolding(
  ctx: ModelContext,
): Promise<z.infer<typeof ScaffoldingReportSchema>> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const empty = {
    projectDir: cfg.projectDir,
    denoBin: null,
    skipped: true,
    checkedDirs: [] as string[],
    missingDirs: [] as string[],
    packageRoots: [] as string[],
    checkedFiles: 0,
    findings: [] as Finding[],
    errorCount: 0,
    warningCount: 0,
  };

  const denoBin = await resolveDenoBin(cfg.denoBin);
  if (!denoBin) {
    const skipReason =
      "deno executable not found (set denoBin or DENO_BIN, or install ~/.swamp/deno/deno)";
    ctx.logger.warn("Scaffolding typecheck skipped: {reason}", {
      reason: skipReason,
    });
    return { ...empty, skipReason };
  }

  const findings: Finding[] = [];
  const checkedDirs: string[] = [];
  const missingDirs: string[] = [];
  const packageRoots: string[] = [];
  let checkedFiles = 0;

  const projectAbs = await realPathOf(cfg.projectDir);

  for (const dir of cfg.scaffoldingDirs) {
    const dirAbs = `${projectAbs}/${dir}`;
    if (!(await exists(dirAbs))) {
      missingDirs.push(dir);
      continue;
    }
    const files = await collectScaffoldingFiles(dirAbs);
    if (files.length === 0) {
      missingDirs.push(dir);
      continue;
    }
    checkedDirs.push(dir);
    checkedFiles += files.length;

    const packageRoot = await nearestPackageRoot(dirAbs, projectAbs);
    if (!packageRoots.includes(packageRoot)) packageRoots.push(packageRoot);

    const result = await runDenoCheck(denoBin, packageRoot, files);
    const parsed = parseDenoCheckOutput(result.stderr, projectAbs);
    if (result.code !== 0 && parsed.length === 0) {
      findings.push({
        check: "scaffolding-typecheck",
        severity: "error",
        file: dir,
        line: null,
        message: `deno check failed for ${dir} (exit ${result.code})`,
        detail: result.stderr.trim().split("\n").slice(-3).join("\n") || null,
      });
    } else {
      findings.push(...parsed);
    }
  }

  const report: z.infer<typeof ScaffoldingReportSchema> = {
    projectDir: cfg.projectDir,
    denoBin,
    skipped: false,
    skipReason: null,
    checkedDirs,
    missingDirs,
    packageRoots,
    checkedFiles,
    findings,
    errorCount: findings.filter((f) => f.severity === "error").length,
    warningCount: findings.filter((f) => f.severity === "warning").length,
  };

  ctx.logger.info(
    "Scaffolding typecheck: {files} file(s) in {dirs} dir(s), {e} error(s)",
    {
      files: checkedFiles,
      dirs: checkedDirs.length,
      e: report.errorCount,
    },
  );
  return report;
}

/** Render a scan report as markdown, grouped by severity. */
export function renderReport(report: z.infer<typeof ScanReportSchema>): string {
  const lines: string[] = [];
  lines.push("# Swamp Repo Doctor");
  lines.push("");
  lines.push(`- Repo: \`${report.projectDir}\``);
  lines.push(`- Verdict: **${report.healthy ? "healthy" : "issues found"}**`);
  lines.push(
    `- Findings: ${report.errorCount} error(s), ${report.warningCount} warning(s)`,
  );
  lines.push("");

  if (report.findings.length === 0) {
    lines.push("No findings.");
    return lines.join("\n");
  }

  const bySeverity = ["error", "warning", "info"] as const;
  for (const severity of bySeverity) {
    const group = report.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    lines.push(`## ${severity} (${group.length})`);
    lines.push("");
    for (const f of group) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      lines.push(`- **${f.check}** \`${loc}\` — ${f.message}`);
      if (f.detail) lines.push(`  - \`${f.detail}\``);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function scan(
  _args: Record<string, never>,
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);

  const paths = await findHardcodedPaths(ctx);
  const extensions = await checkExtensions(ctx);
  const gitignore = await checkGitignore(ctx);

  const findings: Finding[] = [...paths.findings];

  for (const name of extensions.missing) {
    findings.push({
      check: "missing-extension-sources",
      severity: "error",
      file: `.swamp/pulled-extensions/${name}`,
      line: null,
      message: `Pulled extension "${name}" has no source files`,
      detail: "Run `swamp extension install` to restore it.",
    });
  }

  for (const entry of gitignore.uncovered) {
    findings.push({
      check: "gitignore-coverage",
      severity: "warning",
      file: ".gitignore",
      line: null,
      message: `"${entry}" is not covered by .gitignore`,
      detail: "Generated artifacts may be committed accidentally.",
    });
  }

  if (!gitignore.gitignorePresent) {
    findings.push({
      check: "gitignore-coverage",
      severity: "warning",
      file: ".gitignore",
      line: null,
      message: ".gitignore is missing",
      detail: null,
    });
  }

  const report: z.infer<typeof ScanReportSchema> = {
    projectDir: cfg.projectDir,
    healthy: findings.every((f) => f.severity !== "error"),
    errorCount: findings.filter((f) => f.severity === "error").length,
    warningCount: findings.filter((f) => f.severity === "warning").length,
    findings,
  };

  const handles = [
    await ctx.writeResource("scan", "scan-current", report),
    await ctx.writeResource("paths", "paths-current", paths),
    await ctx.writeResource("extensions", "extensions-current", extensions),
    await ctx.writeResource("gitignore", "gitignore-current", gitignore),
    await ctx.createFileWriter("report", "report-current").writeText(
      renderReport(report),
    ),
  ];

  ctx.logger.info("Scan complete: {e} error(s), {w} warning(s)", {
    e: report.errorCount,
    w: report.warningCount,
  });
  return { dataHandles: handles };
}

export const model = {
  type: "@maphew/repo-doctor",
  version: "2026.10.21.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.14.1",
      description:
        "Source moved to maphew/swamp-extensions (AGPL-3.0); no schema, method, or resource changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.14.2",
      description:
        "Fix checkExtensions crashing on a pulled extension with no files/ tree, and verify declared additionalFiles instead of a dead no-op loop",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.21.1",
      description:
        "Add checkScaffolding: deno check over generated agent scaffolding (.kilo/plugins, .opencode/plugins, .pi/extensions) with scaffoldingDirs and denoBin global args; no change to existing args or resources",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    scan: {
      description: "Combined repo health report from every doctor check",
      schema: ScanReportSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    paths: {
      description: "Hardcoded absolute-path findings",
      schema: PathsReportSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    extensions: {
      description: "Pulled extension source integrity",
      schema: ExtensionsReportSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    gitignore: {
      description: ".gitignore coverage of generated .swamp artifacts",
      schema: GitignoreReportSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    scaffolding: {
      description:
        "Typecheck findings for generated agent scaffolding, separate from project-owned code",
      schema: ScaffoldingReportSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
  },
  files: {
    report: {
      description: "Markdown repo doctor report",
      contentType: "text/markdown",
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    scan: {
      description: "Run every repo doctor check and write a combined report",
      arguments: z.object({}),
      execute: scan,
    },
    findPaths: {
      description:
        "Find hardcoded absolute home paths in model and workflow sources",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ModelContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const paths = await findHardcodedPaths(ctx);
        const handle = await ctx.writeResource("paths", "paths-current", paths);
        return { dataHandles: [handle] };
      },
    },
    checkExtensions: {
      description: "Check pulled extensions for missing source files",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ModelContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const report = await checkExtensions(ctx);
        const handle = await ctx.writeResource(
          "extensions",
          "extensions-current",
          report,
        );
        return { dataHandles: [handle] };
      },
    },
    checkGitignore: {
      description: "Check that generated .swamp artifacts are gitignored",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ModelContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const report = await checkGitignore(ctx);
        const handle = await ctx.writeResource(
          "gitignore",
          "gitignore-current",
          report,
        );
        return { dataHandles: [handle] };
      },
    },
    checkScaffolding: {
      description:
        "Typecheck generated agent scaffolding (.kilo/plugins, .opencode/plugins, .pi/extensions)",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ModelContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const report = await checkScaffolding(ctx);
        const handle = await ctx.writeResource(
          "scaffolding",
          "scaffolding-current",
          report,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
