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
 *   - workflow-invoked scripts that are missing an exec bit or shebang,
 *     workflow schedules that do not match live scheduler registrations, and
 *     step dependencies that can silently skip their dependent or dereference
 *     the outputs of a failed step
 *
 * Methods:
 *   - `scan`       run every check and write a combined report
 *   - `findPaths`  hardcoded absolute-path findings only
 *   - `checkExtensions`  pulled-extension integrity only
 *   - `checkGitignore`   .swamp/ gitignore coverage only
 *   - `checkWorkflowWiring`  script exec/shebang, schedule registration drift,
 *                            and dead step dependencies
 *
 * @module
 */

import { z } from "npm:zod@4";
import { parse as parseYaml } from "jsr:@std/yaml@1.3.0";

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

const WorkflowScriptSchema = z.object({
  workflow: z.string(),
  file: z.string().describe("Repo-relative workflow YAML path"),
  step: z.string(),
  path: z.string().describe("Script path as written in the workflow"),
  absolutePath: z.string().describe("Resolved path that was stat'ed"),
  exists: z.boolean(),
  executable: z.boolean(),
  shebang: z.string().nullable().describe(
    "First line when it starts with #!, otherwise null",
  ),
});

const WorkflowScheduleSchema = z.object({
  workflow: z.string(),
  file: z.string().nullable().describe(
    "Repo-relative workflow YAML path; null for live registrations",
  ),
  cron: z.string(),
});

const WorkflowWiringReportSchema = z.object({
  workflowDirs: z.array(z.string()),
  workflowFiles: z.array(z.string()),
  scripts: z.array(WorkflowScriptSchema),
  declaredSchedules: z.array(WorkflowScheduleSchema),
  liveSchedules: z.array(WorkflowScheduleSchema),
  liveSource: z.enum(["serve", "cli", "none"]).describe(
    "Where live registrations came from; none means both were unavailable",
  ),
  liveDetail: z.string().nullable(),
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
  excludeSourceSuffixes: z.array(z.string()).default([
    "_test.ts",
    "_test.tsx",
  ]).describe(
    "Path suffixes skipped by the hardcoded-home-path check; test fixtures embed synthetic absolute paths on purpose",
  ),
  allowedHomeRoots: z.array(z.string()).default([
    "/home/linuxbrew",
  ]).describe(
    "Home roots that are standard tool locations rather than a person (the Linuxbrew prefix); matches under them are not reported",
  ),
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
  workflowDirs: z.array(z.string()).default(["workflows"]).describe(
    "Repo-relative directories scanned for workflow YAML",
  ),
  swampBin: z.string().default("swamp").describe(
    "swamp executable used to read live workflow registrations; falls back to SWAMP_BIN",
  ),
  serveUrl: z.string().default("http://127.0.0.1:9090").describe(
    "swamp serve base URL probed for live schedules at /api/v1/health, then the unauthenticated /health; unreachable is not an error",
  ),
});

// ---------- helpers ---------------------------------------------------------

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type Finding = z.infer<typeof FindingSchema>;
type WorkflowScript = z.infer<typeof WorkflowScriptSchema>;
type WorkflowSchedule = z.infer<typeof WorkflowScheduleSchema>;
type LiveSource = z.infer<typeof WorkflowWiringReportSchema>["liveSource"];
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
 * `allowedHomeRoots` exempts home roots that are standard tool locations rather
 * than a person, so the Linuxbrew prefix does not read as a portability bug.
 */
export function offendingLines(
  text: string,
  options: { allowedHomeRoots?: string[] } = {},
): Array<{ line: number; match: string; text: string }> {
  const allowed = new Set(options.allowedHomeRoots ?? []);
  const out: Array<{ line: number; match: string; text: string }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i];
    for (const match of current.matchAll(HOME_PATH_RE)) {
      if (allowed.has(match[0])) continue;
      out.push({ line: i + 1, match: match[0], text: current.trim() });
    }
  }
  return out;
}

/** True when a source path is excluded by a configured suffix. */
export function isExcludedSource(
  path: string,
  suffixes: string[],
): boolean {
  return suffixes.some((suffix) => suffix !== "" && path.endsWith(suffix));
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
      if (isExcludedSource(abs, cfg.excludeSourceSuffixes)) continue;
      scannedFiles++;
      let text: string;
      try {
        text = new TextDecoder().decode(await Deno.readFile(abs));
      } catch {
        continue;
      }
      for (
        const hit of offendingLines(text, {
          allowedHomeRoots: cfg.allowedHomeRoots,
        })
      ) {
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

// ---------- workflow wiring --------------------------------------------------

// Shell scripts, plus the interpreted languages commonly used for workflow
// helper scripts. A no-extension path is still a candidate when it lives under
// an explicit path prefix (./, ../, ~/, /); it is only treated as a script
// after its shebang is read.
const SCRIPT_EXTENSION_RE =
  /\.(?:sh|bash|zsh|ksh|fish|py|rb|pl|php|js|mjs|cjs|ts|tsx)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Split a shell command into words, honouring single/double quotes and
 * backslash escapes. Shell concatenation such as `'/repo'/.kilo/a.sh` becomes
 * a single word, which is how workflows reference scripts with quoted roots.
 */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const push = () => {
    if (started) {
      words.push(current);
      current = "";
      started = false;
    }
  };

  for (const ch of command) {
    if (escaped) {
      escaped = false;
      if (ch === "\n") continue;
      current += ch;
      started = true;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\") escaped = true;
      else current += ch;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    current += ch;
    started = true;
  }
  push();
  return words;
}

/**
 * Extract script-looking paths from a shell command. Variables and URLs are
 * skipped because they cannot be resolved statically. Tokens with a
 * non-script extension (for example an output `.json` path) are ignored.
 */
export function extractScriptPaths(command: string): string[] {
  const paths: string[] = [];
  for (const word of shellWords(command)) {
    if (!word || word.startsWith("-")) continue;
    if (/^(?:https?|ftp|file):\/\//i.test(word)) continue;
    if (word.includes("$") || word.includes("{{")) continue;
    if (/^\d*[<>]/.test(word)) continue;

    const base = word.slice(word.lastIndexOf("/") + 1);
    const hasExtension = base.includes(".");
    if (hasExtension && !SCRIPT_EXTENSION_RE.test(base)) continue;
    if (!word.includes("/") && !SCRIPT_EXTENSION_RE.test(base)) continue;
    if (
      !SCRIPT_EXTENSION_RE.test(base) &&
      !/^(?:\.{1,2}\/|\/|~\/)/.test(word)
    ) continue;

    if (!paths.includes(word)) paths.push(word);
  }
  return paths;
}

export interface ScriptInspection {
  exists: boolean;
  executable: boolean;
  shebang: string | null;
}

/** Stat a referenced script and read just enough of it to find a shebang. */
export async function inspectScript(path: string): Promise<ScriptInspection> {
  const missing = { exists: false, executable: false, shebang: null };
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch {
    return missing;
  }
  if (!info.isFile) return missing;

  let shebang: string | null = null;
  let file: Deno.FsFile | null = null;
  try {
    file = await Deno.open(path, { read: true });
    const buffer = new Uint8Array(256);
    const read = await file.read(buffer);
    if (read) {
      const firstLine = new TextDecoder().decode(buffer.subarray(0, read))
        .split("\n")[0].trim();
      if (firstLine.startsWith("#!")) shebang = firstLine;
    }
  } catch {
    // Unreadable but stat'able: report exec-bit state without a shebang.
  } finally {
    try {
      file?.close();
    } catch {
      // already closed
    }
  }

  return {
    exists: true,
    executable: ((info.mode ?? 0) & 0o111) !== 0,
    shebang,
  };
}

/** Normalise `.` and `..` without importing a node:path dependency. */
export function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!absolute) {
        parts.push("..");
      }
      continue;
    }
    parts.push(segment);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

/** Resolve a script token against a working directory, expanding a leading ~. */
export function resolveScriptPath(
  raw: string,
  baseDir: string,
  home = "",
): string {
  let path = raw;
  if (home && (path === "~" || path.startsWith("~/"))) {
    path = `${home}${path.slice(1)}`;
  }
  if (path.startsWith("/")) return normalizePath(path);
  if (baseDir === "" || baseDir === ".") return normalizePath(path);
  return normalizePath(`${baseDir}/${path}`);
}

export interface ShellInvocation {
  step: string;
  command: string;
  workingDir: string | null;
}

function isShellTask(task: Record<string, unknown>): boolean {
  const type = task.type;
  const modelType = task.modelType;
  const behavior = task.behavior;
  return (
    type === "shell" ||
    type === "command" ||
    modelType === "command/shell" ||
    modelType === "shell" ||
    modelType === "command" ||
    behavior === "command/shell"
  );
}

/**
 * Find command/shell invocations in a parsed workflow. Supports the current
 * `model_method` + `modelType: command/shell` shape and the older task-level
 * `command`/`shell`/`run` variants.
 */
export function extractShellInvocations(
  workflow: unknown,
): ShellInvocation[] {
  const invocations: ShellInvocation[] = [];
  if (!isRecord(workflow) || !Array.isArray(workflow.jobs)) return invocations;

  for (const job of workflow.jobs) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (!isRecord(step)) continue;
      const task = isRecord(step.task) ? step.task : null;
      const inputs = task && isRecord(task.inputs) ? task.inputs : null;
      const commands: string[] = [];
      const add = (value: unknown) => {
        if (typeof value === "string" && value.trim()) commands.push(value);
      };

      const isShell = (task !== null && isShellTask(task)) ||
        step.command !== undefined || step.shell !== undefined;

      if (isShell) {
        add(inputs?.run);
        add(inputs?.command);
        add(inputs?.shell);
        add(task?.run);
        add(task?.command);
        add(task?.shell);
        add(step.run);
        add(step.command);
        add(step.shell);
      }

      const workingDir = typeof inputs?.workingDir === "string"
        ? inputs.workingDir
        : typeof task?.workingDir === "string"
        ? task.workingDir
        : null;
      const stepName = typeof step.name === "string"
        ? step.name
        : typeof job.name === "string"
        ? job.name
        : "step";

      for (const command of commands) {
        invocations.push({ step: stepName, command, workingDir });
      }
    }
  }
  return invocations;
}

export function workflowNameOf(workflow: unknown): string | null {
  return isRecord(workflow) && typeof workflow.name === "string"
    ? workflow.name
    : null;
}

export function declaredScheduleOf(workflow: unknown): string | null {
  if (!isRecord(workflow) || !isRecord(workflow.trigger)) return null;
  const schedule = workflow.trigger.schedule;
  return typeof schedule === "string" && schedule.trim()
    ? schedule.trim()
    : null;
}

/**
 * A `dependsOn` condition, mirroring the executor's matcher: `always`,
 * `succeeded` (the default when omitted), `failed`, `completed` (succeeded or
 * failed), `skipped`, `and`, `or`, and `not`.
 */
export interface DependencyCondition {
  type: string;
  conditions?: DependencyCondition[];
  condition?: DependencyCondition;
}

function parseCondition(raw: unknown): DependencyCondition | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  const condition: DependencyCondition = { type: raw.type };
  if (Array.isArray(raw.conditions)) {
    condition.conditions = raw.conditions
      .map((entry) => parseCondition(entry))
      .filter((entry): entry is DependencyCondition => entry !== null);
  }
  if (isRecord(raw.condition)) {
    const nested = parseCondition(raw.condition);
    if (nested) condition.condition = nested;
  }
  return condition;
}

export type StepStatus = "succeeded" | "failed" | "skipped";

/**
 * Evaluate a dependency condition against a step status. A missing condition
 * behaves as `succeeded`, matching the executor.
 */
export function conditionMatches(
  condition: DependencyCondition | null,
  status: StepStatus,
): boolean {
  if (condition === null) return status === "succeeded";
  switch (condition.type) {
    case "always":
      return true;
    case "succeeded":
      return status === "succeeded";
    case "failed":
      return status === "failed";
    case "completed":
      return status === "succeeded" || status === "failed";
    case "skipped":
      return status === "skipped";
    case "and":
      return (condition.conditions ?? []).every((entry) =>
        conditionMatches(entry, status)
      );
    case "or":
      return (condition.conditions ?? []).some((entry) =>
        conditionMatches(entry, status)
      );
    case "not":
      return condition.condition === undefined
        ? true
        : !conditionMatches(condition.condition, status);
    default:
      return false;
  }
}

/** Render a condition for a finding message. */
export function describeCondition(
  condition: DependencyCondition | null,
): string {
  if (condition === null) return "succeeded";
  switch (condition.type) {
    case "and":
      return (condition.conditions ?? []).map(describeCondition).join(" and ");
    case "or":
      return (condition.conditions ?? []).map(describeCondition).join(" or ");
    case "not":
      return `not ${
        condition.condition ? describeCondition(condition.condition) : "?"
      }`;
    default:
      return condition.type;
  }
}

/** One step's dependency shape, as needed by the dead-dependency lint. */
export interface WorkflowStepInfo {
  job: string;
  name: string;
  guarded: boolean;
  guardText: string | null;
  dependsOn: Array<{ step: string; condition: DependencyCondition | null }>;
  expressions: string[];
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out);
    return;
  }
  if (!isRecord(value)) return;
  for (const entry of Object.values(value)) collectStrings(entry, out);
}

/**
 * Whether a guard can skip the step. `guard: true` always skips; a literal
 * false expression never does, so it is not a source of skippability.
 */
function isGuardSkippable(guard: unknown): boolean {
  if (guard === undefined || guard === null || guard === false) return false;
  if (typeof guard === "string") {
    const compact = guard.replace(/\s+/g, "");
    return compact !== "" && compact !== "false" && compact !== "${{false}}";
  }
  return true;
}

/** Extract every step and the expressions that can dereference `steps.*`. */
export function extractWorkflowSteps(workflow: unknown): WorkflowStepInfo[] {
  const steps: WorkflowStepInfo[] = [];
  if (!isRecord(workflow) || !Array.isArray(workflow.jobs)) return steps;

  for (const job of workflow.jobs) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    const jobName = typeof job.name === "string" ? job.name : "job";
    for (const step of job.steps) {
      if (!isRecord(step) || typeof step.name !== "string") continue;

      const dependsOn: WorkflowStepInfo["dependsOn"] = [];
      if (Array.isArray(step.dependsOn)) {
        for (const dep of step.dependsOn) {
          if (!isRecord(dep) || typeof dep.step !== "string") continue;
          dependsOn.push({
            step: dep.step,
            condition: parseCondition(dep.condition),
          });
        }
      }

      const expressions: string[] = [];
      if (typeof step.guard === "string") expressions.push(step.guard);
      if (typeof step.in === "string") expressions.push(step.in);
      if (typeof step.description === "string") {
        expressions.push(step.description);
      }
      collectStrings(step.task, expressions);

      steps.push({
        job: jobName,
        name: step.name,
        guarded: isGuardSkippable(step.guard),
        guardText: typeof step.guard === "string" ? step.guard : null,
        dependsOn,
        expressions,
      });
    }
  }
  return steps;
}

/** True when an expression references `steps.<step>` directly (not optional). */
export function referencesStep(
  expressions: string[],
  step: string,
): boolean {
  const escaped = escapeRegExp(step);
  return expressions.some((expression) =>
    new RegExp(`steps\\.${escaped}\\.`).test(expression)
  );
}

/** True when an expression dereferences `steps.<step>.outputs` directly. */
export function referencesStepOutputs(
  expressions: string[],
  step: string,
): boolean {
  const escaped = escapeRegExp(step);
  const re = new RegExp(`steps\\.${escaped}\\.outputs\\b`);
  return expressions.some((expression) => re.test(expression));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whitespace-insensitive guard text, so mirrored guards compare equal. */
function guardKey(guard: string | null): string | null {
  return guard === null ? null : guard.replace(/\s+/g, "");
}

export interface DependencyFinding {
  check: "workflow-dead-dependency" | "workflow-failure-dereference";
  severity: "warning" | "error";
  step: string;
  dependency: string;
  message: string;
  detail: string;
}

/**
 * Static lint for the two silent dependency failure modes:
 *
 * 1. a dependency condition that a skipped dependency does not satisfy, so the
 *    dependent is skipped too while the run still reports success;
 * 2. a condition that runs the dependent after a FAILED dependency, where the
 *    dependent dereferences `steps.<dep>.outputs` and dies with
 *    `No such key: outputs`, burying the real error.
 *
 * Rule 1 deliberately ignores the common intentional shape: a dependent with
 * its own guard that mirrors the dependency's guard ("skip everything in
 * diagnosis mode") and that never reads the dependency cannot distinguish an
 * intended skip from a dead dependency, so it stays quiet. A guarded dependent
 * that DOES read the dependency is reported, because the read proves it expects
 * the dependency to have run.
 *
 * Optional chaining (`steps.?x.?outputs`) is treated as safe. Rule 2 in
 * myswamp-lc6x (unguarded reads of a possibly absent step) is deliberately left
 * to documentation: it needs dataflow the YAML does not carry.
 */
export function findDeadDependencies(workflow: unknown): DependencyFinding[] {
  const steps = extractWorkflowSteps(workflow);
  const byName = new Map(steps.map((step) => [step.name, step]));

  // Fixpoint: a step may skip if it has a guard, or if it depends on a step
  // that may skip under a condition that a skipped dependency does not meet.
  const maySkip = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (maySkip.has(step.name)) continue;
      const viaGuard = step.guarded;
      const viaDependency = step.dependsOn.some((dep) =>
        !conditionMatches(dep.condition, "skipped") && maySkip.has(dep.step)
      );
      if (viaGuard || viaDependency) {
        maySkip.add(step.name);
        changed = true;
      }
    }
  }

  const findings: DependencyFinding[] = [];
  for (const step of steps) {
    const deadDependencies = step.dependsOn.filter((dep) => {
      if (!byName.has(dep.step)) return false;
      if (!maySkip.has(dep.step)) return false;
      if (conditionMatches(dep.condition, "skipped")) return false;
      if (!step.guarded) return true;
      // A guard of its own that mirrors the dependency's guard means the skip
      // is the intent ("skip everything in diagnosis mode"). A guard that
      // never reads the dependency is equally uninformative, so it stays
      // quiet too. A *different* guard that does read the dependency is the
      // 2026-10-26 session-retro shape: the read proves the dependent expects
      // the dependency to have run.
      const dependency = byName.get(dep.step);
      const mirrored = guardKey(step.guardText) !== null &&
        guardKey(step.guardText) === guardKey(dependency?.guardText ?? null);
      if (mirrored) return false;
      return referencesStep(step.expressions, dep.step);
    });

    if (deadDependencies.length > 0) {
      const names = deadDependencies.map((dep) =>
        `"${dep.step}" (${describeCondition(dep.condition)})`
      ).join(", ");
      findings.push({
        check: "workflow-dead-dependency",
        severity: "warning",
        step: step.name,
        dependency: deadDependencies.map((dep) => dep.step).join(", "),
        message: `Step "${step.name}" requires ${names} but ${
          deadDependencies.length === 1
            ? "that step can be skipped"
            : "those steps can be skipped"
        }; the dependent is skipped too and the run still reports success`,
        detail:
          `Use condition "always" (or an "or" that includes "skipped") when running after a skip is intended, or remove the guard that makes the dependency skippable.`,
      });
    }

    for (const dep of step.dependsOn) {
      if (!byName.has(dep.step)) continue;
      if (
        conditionMatches(dep.condition, "failed") &&
        referencesStepOutputs(step.expressions, dep.step)
      ) {
        findings.push({
          check: "workflow-failure-dereference",
          severity: "error",
          step: step.name,
          dependency: dep.step,
          message: `Step "${step.name}" runs after "${dep.step}" fails (${
            describeCondition(dep.condition)
          }) and dereferences steps.${dep.step}.outputs; a failed step has no outputs, so it dies with "No such key: outputs"`,
          detail:
            `Use condition "succeeded" for the dependency, or read outputs through the optional chain steps.?${dep.step}.?outputs.?attr.orValue(default).`,
        });
      }
    }
  }
  return findings;
}

export interface ScheduleDiffEntry {
  kind: "declared-unregistered" | "registered-undeclared" | "mismatch";
  workflow: string;
  declared: string | null;
  live: string | null;
  file: string | null;
}

/**
 * Diff declared workflow schedules against live registrations by workflow name.
 * A cron mismatch is reported once as `mismatch` rather than as both missing
 * directions.
 */
export function diffSchedules(
  declared: WorkflowSchedule[],
  live: WorkflowSchedule[],
): ScheduleDiffEntry[] {
  const declaredByName = new Map(declared.map((s) => [s.workflow, s]));
  const liveByName = new Map(live.map((s) => [s.workflow, s]));
  const diffs: ScheduleDiffEntry[] = [];

  for (const [name, entry] of declaredByName) {
    const actual = liveByName.get(name);
    if (!actual) {
      diffs.push({
        kind: "declared-unregistered",
        workflow: name,
        declared: entry.cron,
        live: null,
        file: entry.file,
      });
    } else if (actual.cron !== entry.cron) {
      diffs.push({
        kind: "mismatch",
        workflow: name,
        declared: entry.cron,
        live: actual.cron,
        file: entry.file,
      });
    }
  }

  for (const [name, entry] of liveByName) {
    if (declaredByName.has(name)) continue;
    diffs.push({
      kind: "registered-undeclared",
      workflow: name,
      declared: null,
      live: entry.cron,
      file: entry.file,
    });
  }

  return diffs;
}

/** Parse `swamp workflow search --json`; malformed input yields no schedules. */
export function parseWorkflowSearchJson(raw: string): WorkflowSchedule[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(data) || !Array.isArray(data.results)) return [];
  const schedules: WorkflowSchedule[] = [];
  for (const result of data.results) {
    if (!isRecord(result) || typeof result.name !== "string") continue;
    const trigger = isRecord(result.trigger) ? result.trigger : null;
    if (typeof trigger?.schedule !== "string" || !trigger.schedule.trim()) {
      continue;
    }
    schedules.push({
      workflow: result.name,
      file: null,
      cron: trigger.schedule.trim(),
    });
  }
  return schedules;
}

/** Parse the `scheduling.schedules` block of `/api/v1/health`. */
export function parseServeHealthJson(raw: string): WorkflowSchedule[] {
  const data: unknown = JSON.parse(raw);
  if (!isRecord(data) || !isRecord(data.scheduling)) {
    throw new Error("health response has no scheduling block");
  }
  const schedules = data.scheduling.schedules;
  if (!Array.isArray(schedules)) {
    throw new Error("health response has no scheduling.schedules array");
  }
  const out: WorkflowSchedule[] = [];
  for (const entry of schedules) {
    if (!isRecord(entry)) continue;
    if (typeof entry.workflowName !== "string" || !entry.workflowName.trim()) {
      continue;
    }
    if (
      typeof entry.cronExpression !== "string" || !entry.cronExpression.trim()
    ) {
      continue;
    }
    out.push({
      workflow: entry.workflowName,
      file: null,
      cron: entry.cronExpression.trim(),
    });
  }
  return out;
}

async function runSwampSearch(
  cfg: GlobalArgs,
): Promise<{
  schedules: WorkflowSchedule[];
  ok: boolean;
  detail: string | null;
}> {
  const bin = Deno.env.get("SWAMP_BIN") || cfg.swampBin;
  try {
    const output = await new Deno.Command(bin, {
      args: ["workflow", "search", "--json", "--repo-dir", cfg.projectDir],
      cwd: cfg.projectDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (output.code !== 0) {
      return {
        schedules: [],
        ok: false,
        detail: `swamp workflow search exited ${output.code}`,
      };
    }
    const text = new TextDecoder().decode(output.stdout);
    return {
      schedules: parseWorkflowSearchJson(text),
      ok: true,
      detail: `swamp workflow search --repo-dir ${cfg.projectDir}`,
    };
  } catch (error) {
    return {
      schedules: [],
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Health endpoints probed for live schedules, in order. `/api/v1/health` is
 * token-gated when serve runs with auth (oauth), while the liveness endpoint
 * `/health` is not and returns the same `scheduling` block.
 */
export function healthUrls(serveUrl: string): string[] {
  const base = serveUrl.replace(/\/+$/, "");
  return [`${base}/api/v1/health`, `${base}/health`];
}

async function readLiveSchedules(
  cfg: GlobalArgs,
): Promise<{
  schedules: WorkflowSchedule[];
  source: LiveSource;
  detail: string | null;
}> {
  let detail: string | null = null;
  for (const healthUrl of healthUrls(cfg.serveUrl)) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) {
        detail = `${healthUrl} returned ${response.status}`;
        continue;
      }
      const text = await response.text();
      return {
        schedules: parseServeHealthJson(text),
        source: "serve",
        detail: healthUrl,
      };
    } catch (error) {
      detail = `${healthUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  const cli = await runSwampSearch(cfg);
  if (cli.ok) {
    return { schedules: cli.schedules, source: "cli", detail: cli.detail };
  }
  return { schedules: [], source: "none", detail: cli.detail ?? detail };
}

async function checkWorkflowWiring(
  ctx: ModelContext,
): Promise<z.infer<typeof WorkflowWiringReportSchema>> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const findings: Finding[] = [];
  const scripts: WorkflowScript[] = [];
  const declaredSchedules: WorkflowSchedule[] = [];
  const workflowFiles: string[] = [];
  const home = Deno.env.get("HOME") ?? "";

  for (const dir of cfg.workflowDirs) {
    for await (const abs of walk(`${cfg.projectDir}/${dir}`)) {
      if (!/(^|\/)workflow-[^/]+\.(?:yaml|yml)$/i.test(abs)) continue;
      const file = relative(cfg.projectDir, abs);
      workflowFiles.push(file);
      let workflow: unknown;
      try {
        workflow = parseYaml(
          new TextDecoder().decode(await Deno.readFile(abs)),
        );
      } catch (error) {
        findings.push({
          check: "workflow-wiring",
          severity: "warning",
          file,
          line: null,
          message: "Workflow YAML could not be parsed",
          detail: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const name = workflowNameOf(workflow) ?? file;
      const schedule = declaredScheduleOf(workflow);
      if (schedule) {
        declaredSchedules.push({ workflow: name, file, cron: schedule });
      }

      for (const finding of findDeadDependencies(workflow)) {
        findings.push({
          check: finding.check,
          severity: finding.severity,
          file,
          line: null,
          message: finding.message,
          detail: finding.detail,
        });
      }

      for (const invocation of extractShellInvocations(workflow)) {
        const baseDir = invocation.workingDir
          ? resolveScriptPath(invocation.workingDir, cfg.projectDir, home)
          : cfg.projectDir;
        for (const raw of extractScriptPaths(invocation.command)) {
          const absolutePath = resolveScriptPath(raw, baseDir, home);
          const info = await inspectScript(absolutePath);
          const looksLikeScript = SCRIPT_EXTENSION_RE.test(raw) ||
            info.shebang !== null;
          if (!info.exists) {
            if (SCRIPT_EXTENSION_RE.test(raw)) {
              findings.push({
                check: "workflow-script-missing",
                severity: "warning",
                file,
                line: null,
                message:
                  `Step "${invocation.step}" references a missing script`,
                detail: `${raw} (resolved to ${absolutePath})`,
              });
            }
            continue;
          }
          if (!looksLikeScript) continue;

          scripts.push({
            workflow: name,
            file,
            step: invocation.step,
            path: raw,
            absolutePath,
            exists: true,
            executable: info.executable,
            shebang: info.shebang,
          });

          if (!info.executable) {
            findings.push({
              check: "workflow-script-not-executable",
              severity: "error",
              file,
              line: null,
              message:
                `Step "${invocation.step}" invokes a script without an executable bit`,
              detail: `${absolutePath} — chmod +x it`,
            });
          }
          if (!info.shebang) {
            findings.push({
              check: "workflow-script-missing-shebang",
              severity: "warning",
              file,
              line: null,
              message:
                `Step "${invocation.step}" invokes a script without a shebang`,
              detail:
                `${absolutePath} — add #!/usr/bin/env bash (or the right interpreter)`,
            });
          }
        }
      }
    }
  }

  const live = await readLiveSchedules(cfg);
  const declaredNames = new Set(declaredSchedules.map((s) => s.workflow));
  // Extension-owned schedules are declared in their own package, not this
  // repo's workflows/. Do not report those as undeclared unless this repo also
  // declares them.
  const liveForDiff = live.schedules.filter((s) =>
    declaredNames.has(s.workflow) || !s.workflow.startsWith("@")
  );

  for (const diff of diffSchedules(declaredSchedules, liveForDiff)) {
    if (diff.kind === "declared-unregistered") {
      findings.push({
        check: "workflow-schedule-unregistered",
        severity: "error",
        file: diff.file ?? "workflows",
        line: null,
        message:
          `Workflow "${diff.workflow}" declares schedule "${diff.declared}" but no live registration was found`,
        detail: live.detail,
      });
    } else if (diff.kind === "mismatch") {
      findings.push({
        check: "workflow-schedule-mismatch",
        severity: "error",
        file: diff.file ?? "workflows",
        line: null,
        message:
          `Workflow "${diff.workflow}" declares schedule "${diff.declared}" but is registered as "${diff.live}"`,
        detail: live.detail,
      });
    } else {
      findings.push({
        check: "workflow-schedule-undeclared",
        severity: "warning",
        file: diff.file ?? "serve",
        line: null,
        message:
          `Workflow "${diff.workflow}" is registered with schedule "${diff.live}" but no workflow YAML in this repo declares it`,
        detail: live.detail,
      });
    }
  }

  if (live.source === "none") {
    findings.push({
      check: "workflow-schedule-unverified",
      severity: "info",
      file: "workflows",
      line: null,
      message:
        "Live workflow schedules could not be read; schedule diff was skipped",
      detail: live.detail,
    });
  }

  const report: z.infer<typeof WorkflowWiringReportSchema> = {
    workflowDirs: cfg.workflowDirs,
    workflowFiles,
    scripts,
    declaredSchedules,
    liveSchedules: live.schedules,
    liveSource: live.source,
    liveDetail: live.detail,
    findings,
    errorCount: findings.filter((f) => f.severity === "error").length,
    warningCount: findings.filter((f) => f.severity === "warning").length,
  };

  ctx.logger.info(
    "Workflow wiring: {files} workflow(s), {scripts} script(s), {e} error(s)",
    {
      files: workflowFiles.length,
      scripts: scripts.length,
      e: report.errorCount,
    },
  );
  return report;
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
  const workflowWiring = await checkWorkflowWiring(ctx);

  const findings: Finding[] = [...paths.findings, ...workflowWiring.findings];

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
    await ctx.writeResource(
      "workflowWiring",
      "workflow-wiring-current",
      workflowWiring,
    ),
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
  version: "2026.10.23.1",
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
    {
      toVersion: "2026.10.23.1",
      description:
        "Add checkWorkflowWiring: executable-bit/shebang checks for workflow-invoked scripts and declared-vs-live cron diff; new workflowWiring resource, added to scan findings",
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
    workflowWiring: {
      description:
        "Workflow script exec/shebang checks and declared-vs-live schedule diff",
      schema: WorkflowWiringReportSchema,
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
    checkWorkflowWiring: {
      description:
        "Check workflow-invoked scripts for exec bit/shebang and diff declared schedules against live registrations",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ModelContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const report = await checkWorkflowWiring(ctx);
        const handle = await ctx.writeResource(
          "workflowWiring",
          "workflow-wiring-current",
          report,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
