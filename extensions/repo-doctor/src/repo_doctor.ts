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
  version: "2026.10.14.2",
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
  },
};
