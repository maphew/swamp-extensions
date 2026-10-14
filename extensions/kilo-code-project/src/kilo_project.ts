/**
 * Kilo Code project inventory model.
 *
 * Discovers Kilo Code CLI configuration, commands, agents, skills, instruction files,
 * MCPs, permissions, and Agent Manager script/state locations without running
 * Kilo or mutating project files.
 *
 * @module
 */

import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  projectDir: z.string().default(".").describe("Project directory to inspect"),
  includeGlobal: z.boolean().default(true).describe(
    "Include global Kilo Code config roots",
  ),
  includeLegacyPaths: z.boolean().default(true).describe(
    "Include legacy .kilocode/.opencode roots",
  ),
  includeAgentManager: z.boolean().default(true).describe(
    "Inspect .kilo/agent-manager.json metadata",
  ),
  redactSecrets: z.boolean().default(true).describe(
    "Redact likely secret values in parsed config",
  ),
  maxFileBytes: z.number().int().min(1024).max(2_000_000).default(200_000)
    .describe(
      "Maximum bytes to read from a discovered text/config file",
    ),
});

const DiscoveredFileSchema = z.object({
  path: z.string(),
  root: z.string(),
  scope: z.string(),
  kind: z.string(),
  name: z.string(),
  size: z.number(),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  parsed: z.record(z.string(), z.unknown()).optional(),
  parseError: z.string().nullable(),
});

const ConfigRootSchema = z.object({
  path: z.string(),
  scope: z.string(),
  exists: z.boolean(),
  legacy: z.boolean(),
});

const AgentManagerSchema = z.object({
  present: z.boolean(),
  path: z.string().nullable(),
  size: z.number().nullable(),
  worktreeCount: z.number().nullable(),
  sessionCount: z.number().nullable(),
  hasSetupScript: z.boolean(),
  hasRunScript: z.boolean(),
  setupScripts: z.array(z.string()),
  runScripts: z.array(z.string()),
});

const InventorySchema = z.object({
  projectDir: z.string(),
  discoveredAt: z.string(),
  configRoots: z.array(ConfigRootSchema),
  configFiles: z.array(DiscoveredFileSchema),
  commands: z.array(DiscoveredFileSchema),
  agents: z.array(DiscoveredFileSchema),
  skills: z.array(DiscoveredFileSchema),
  instructionFiles: z.array(DiscoveredFileSchema),
  agentManager: AgentManagerSchema,
  counts: z.object({
    configRoots: z.number(),
    configFiles: z.number(),
    commands: z.number(),
    agents: z.number(),
    skills: z.number(),
    instructionFiles: z.number(),
    warnings: z.number(),
  }),
});

const HealthSchema = z.object({
  projectDir: z.string(),
  checkedAt: z.string(),
  warnings: z.array(z.object({
    severity: z.enum(["info", "warning", "error"]),
    code: z.string(),
    message: z.string(),
    path: z.string().nullable(),
  })),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type DiscoveredFile = z.infer<typeof DiscoveredFileSchema>;
type ConfigRoot = z.infer<typeof ConfigRootSchema>;
type HealthWarning = z.infer<typeof HealthSchema>["warnings"][number];

type ModelContext = {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  createFileWriter: (
    spec: string,
    instance: string,
  ) => {
    writeText: (text: string) => Promise<{ name: string }>;
  };
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
};

const CONFIG_FILE_NAMES = [
  "kilo.json",
  "kilo.jsonc",
  "opencode.json",
  "opencode.jsonc",
  "config.json",
];
const MODERN_DIRS = [".kilo"];
const LEGACY_DIRS = [".kilocode", ".opencode"];
const GLOBAL_ROOTS = [".config/kilo", ".kilo", ".kilocode", ".opencode"];
const INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"];
const SECRET_KEY_RE =
  /(api[_-]?key|token|secret|password|authorization|credential|private[_-]?key|headers?)/i;

function pathJoin(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

function dirname(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return idx === 0 ? "/" : ".";
  return normalized.slice(0, idx);
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function safeStat(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(path);
  } catch {
    return null;
  }
}

async function realPathOrResolve(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    if (path.startsWith("/")) return path;
    return pathJoin(Deno.cwd(), path);
  }
}

async function findRepoRoot(start: string): Promise<string> {
  let current = await realPathOrResolve(start);
  const original = current;
  while (true) {
    if (
      await exists(pathJoin(current, ".git")) ||
      await exists(pathJoin(current, ".swamp.yaml"))
    ) return current;
    const parent = dirname(current);
    if (parent === current || parent === ".") return original;
    current = parent;
  }
}

function ancestry(start: string, stop: string): string[] {
  const roots: string[] = [];
  let current = start;
  while (true) {
    roots.push(current);
    if (current === stop) return roots;
    const parent = dirname(current);
    if (parent === current || parent === ".") return roots;
    current = parent;
  }
}

async function readLimited(path: string, maxBytes: number): Promise<string> {
  const file = await Deno.open(path, { read: true });
  try {
    const buf = new Uint8Array(maxBytes);
    const n = await file.read(buf) ?? 0;
    return new TextDecoder().decode(buf.slice(0, n));
  } finally {
    file.close();
  }
}

/**
 * Strip line and block comments from JSONC while leaving string literals
 * intact, so a commented config file can be parsed as JSON.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        out += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "\n" || char === "\r") out += char;
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
    } else if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
    } else {
      out += char;
    }
  }

  return out;
}

/**
 * Recursively replace values whose key looks secret (api key, token,
 * password, authorization, credential, private key, headers) with
 * `"[redacted]"`. Used to keep discovered config safe to store and render.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : redact(child);
  }
  return out;
}

function parseSimpleFrontmatter(
  text: string,
): Record<string, unknown> | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return undefined;
  const block = text.slice(4, end).trim();
  const parsed: Record<string, unknown> = {};
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const raw = trimmed.slice(idx + 1).trim();
    if (raw === "true") parsed[key] = true;
    else if (raw === "false") parsed[key] = false;
    else if (/^-?\d+$/.test(raw)) parsed[key] = Number(raw);
    else parsed[key] = raw.replace(/^['\"]|['\"]$/g, "");
  }
  return parsed;
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(path: string): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(path)) entries.push(entry);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = pathJoin(path, entry.name);
      if (entry.isDirectory) await visit(full);
      else if (entry.isFile) files.push(full);
    }
  }
  await visit(root);
  return files;
}

async function discoverMarkdownFiles(
  root: ConfigRoot,
  dirs: string[],
  kind: string,
  maxBytes: number,
): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  for (const dir of dirs) {
    const base = pathJoin(root.path, dir);
    if (!await exists(base)) continue;
    for (const file of await walkFiles(base)) {
      if (!file.endsWith(".md")) continue;
      const stat = await safeStat(file);
      if (!stat?.isFile) continue;
      const text = await readLimited(file, maxBytes);
      out.push({
        path: file,
        root: root.path,
        scope: root.scope,
        kind,
        name: basename(file).replace(/\.md$/, ""),
        size: stat.size,
        frontmatter: parseSimpleFrontmatter(text),
        parseError: null,
      });
    }
  }
  return out;
}

async function discoverSkills(
  root: ConfigRoot,
  maxBytes: number,
): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  for (const dir of ["skill", "skills"]) {
    const base = pathJoin(root.path, dir);
    if (!await exists(base)) continue;
    for (const file of await walkFiles(base)) {
      if (!file.endsWith("/SKILL.md")) continue;
      const stat = await safeStat(file);
      if (!stat?.isFile) continue;
      const text = await readLimited(file, maxBytes);
      out.push({
        path: file,
        root: root.path,
        scope: root.scope,
        kind: "skill",
        name: basename(dirname(file)),
        size: stat.size,
        frontmatter: parseSimpleFrontmatter(text),
        parseError: null,
      });
    }
  }
  return out;
}

async function discoverConfigFiles(
  root: ConfigRoot,
  maxBytes: number,
  redactSecrets: boolean,
): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  for (const name of CONFIG_FILE_NAMES) {
    const path = pathJoin(root.path, name);
    const stat = await safeStat(path);
    if (!stat?.isFile) continue;
    let parsed: Record<string, unknown> | undefined;
    let parseError: string | null = null;
    const text = await readLimited(path, maxBytes);
    try {
      parsed = JSON.parse(
        name.endsWith("jsonc") ? stripJsonComments(text) : text,
      ) as Record<string, unknown>;
      if (redactSecrets) parsed = redact(parsed) as Record<string, unknown>;
    } catch (e) {
      parseError = (e as Error).message;
    }
    out.push({
      path,
      root: root.path,
      scope: root.scope,
      kind: "config",
      name,
      size: stat.size,
      parsed,
      parseError,
    });
  }
  return out;
}

function discoverInlineAgents(configFiles: DiscoveredFile[]): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  for (const file of configFiles) {
    const agents = file.parsed?.agent;
    if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
      continue;
    }
    for (
      const [name, raw] of Object.entries(agents as Record<string, unknown>)
    ) {
      const agent = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {};
      out.push({
        path: file.path,
        root: file.root,
        scope: file.scope,
        kind: "agent-config",
        name,
        size: file.size,
        frontmatter: {
          description: agent.description,
          mode: agent.mode,
          model: agent.model,
        },
        parseError: null,
      });
    }
  }
  return out;
}

async function discoverInstructionFiles(
  paths: string[],
): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  for (const root of paths) {
    for (const name of INSTRUCTION_NAMES) {
      const path = pathJoin(root, name);
      const stat = await safeStat(path);
      if (!stat?.isFile) continue;
      out.push({
        path,
        root,
        scope: "project",
        kind: "instruction",
        name,
        size: stat.size,
        parseError: null,
      });
    }
  }
  return out;
}

async function discoverAgentManager(
  projectRoot: string,
  include: boolean,
): Promise<z.infer<typeof AgentManagerSchema>> {
  const setupScripts = ["setup-script", "setup-script.sh"].map((n) =>
    pathJoin(projectRoot, ".kilo", n)
  );
  const runScripts = ["run-script", "run-script.sh"].map((n) =>
    pathJoin(projectRoot, ".kilo", n)
  );
  const existingSetup = [];
  const existingRun = [];
  for (const path of setupScripts) {
    if (await exists(path)) existingSetup.push(path);
  }
  for (const path of runScripts) if (await exists(path)) existingRun.push(path);

  const statePath = pathJoin(projectRoot, ".kilo", "agent-manager.json");
  const stat = include ? await safeStat(statePath) : null;
  let worktreeCount: number | null = null;
  let sessionCount: number | null = null;
  if (stat?.isFile) {
    try {
      const parsed = JSON.parse(
        await readLimited(statePath, 500_000),
      ) as Record<string, unknown>;
      const values = Object.values(parsed);
      worktreeCount = values.filter((v) =>
        JSON.stringify(v).includes("worktree")
      ).length;
      sessionCount = values.filter((v) =>
        JSON.stringify(v).includes("session")
      ).length;
    } catch {
      worktreeCount = null;
      sessionCount = null;
    }
  }
  return {
    present: Boolean(stat?.isFile),
    path: stat?.isFile ? statePath : null,
    size: stat?.isFile ? stat.size : null,
    worktreeCount,
    sessionCount,
    hasSetupScript: existingSetup.length > 0,
    hasRunScript: existingRun.length > 0,
    setupScripts: existingSetup,
    runScripts: existingRun,
  };
}

function collectWarnings(
  configRoots: ConfigRoot[],
  configFiles: DiscoveredFile[],
  commands: DiscoveredFile[],
  agents: DiscoveredFile[],
  skills: DiscoveredFile[],
  agentManager: z.infer<typeof AgentManagerSchema>,
): HealthWarning[] {
  const warnings: HealthWarning[] = [];
  if (configFiles.length === 0) {
    warnings.push({
      severity: "info",
      code: "no-config-files",
      message: "No Kilo JSON/JSONC config files were discovered.",
      path: null,
    });
  }
  for (const root of configRoots) {
    if (root.exists && root.legacy) {
      warnings.push({
        severity: "info",
        code: "legacy-config-root",
        message: "Legacy Kilo-compatible config root is present.",
        path: root.path,
      });
    }
  }
  for (const file of configFiles) {
    if (file.parseError) {
      warnings.push({
        severity: "warning",
        code: "config-parse-error",
        message: file.parseError,
        path: file.path,
      });
    }
    const permission = file.parsed?.permission;
    if (permission && JSON.stringify(permission).includes('"allow"')) {
      warnings.push({
        severity: "info",
        code: "allow-permissions",
        message:
          "Config contains allow permissions; review whether broad auto-approval is intended.",
        path: file.path,
      });
    }
  }
  for (const command of commands) {
    if (!command.frontmatter?.description) {
      warnings.push({
        severity: "info",
        code: "command-missing-description",
        message: "Command has no frontmatter description.",
        path: command.path,
      });
    }
  }
  for (const agent of agents) {
    if (!agent.frontmatter?.description) {
      warnings.push({
        severity: "info",
        code: "agent-missing-description",
        message: "Agent has no frontmatter description.",
        path: agent.path,
      });
    }
  }
  for (const skill of skills) {
    if (!skill.frontmatter?.description) {
      warnings.push({
        severity: "info",
        code: "skill-missing-description",
        message: "Skill has no frontmatter description.",
        path: skill.path,
      });
    }
  }
  if (agentManager.present && !agentManager.hasSetupScript) {
    warnings.push({
      severity: "info",
      code: "agent-manager-no-setup-script",
      message:
        "Agent Manager state exists but no Linux setup script was found.",
      path: agentManager.path,
    });
  }
  if (agentManager.present && !agentManager.hasRunScript) {
    warnings.push({
      severity: "info",
      code: "agent-manager-no-run-script",
      message: "Agent Manager state exists but no Linux run script was found.",
      path: agentManager.path,
    });
  }
  return warnings;
}

function renderSummary(
  inventory: z.infer<typeof InventorySchema>,
  health: z.infer<typeof HealthSchema>,
): string {
  const lines: string[] = [];
  lines.push(`# Kilo Code Inventory`);
  lines.push("");
  lines.push(`Project: \`${inventory.projectDir}\``);
  lines.push(`Discovered: ${inventory.discoveredAt}`);
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push("| Item | Count |");
  lines.push("|---|---:|");
  lines.push(`| Config roots | ${inventory.counts.configRoots} |`);
  lines.push(`| Config files | ${inventory.counts.configFiles} |`);
  lines.push(`| Commands | ${inventory.counts.commands} |`);
  lines.push(`| Agents | ${inventory.counts.agents} |`);
  lines.push(`| Skills | ${inventory.counts.skills} |`);
  lines.push(`| Instruction files | ${inventory.counts.instructionFiles} |`);
  lines.push(`| Warnings | ${inventory.counts.warnings} |`);
  lines.push("");
  lines.push("## Commands");
  lines.push("");
  if (inventory.commands.length === 0) {
    lines.push("No Kilo commands discovered.");
  }
  for (const command of inventory.commands) {
    const desc = command.frontmatter?.description
      ? ` — ${String(command.frontmatter.description)}`
      : "";
    lines.push(`- \`/${command.name}\`${desc}`);
  }
  lines.push("");
  lines.push("## Agents");
  lines.push("");
  if (inventory.agents.length === 0) lines.push("No Kilo agents discovered.");
  for (const agent of inventory.agents) {
    const mode = agent.frontmatter?.mode
      ? ` (${String(agent.frontmatter.mode)})`
      : "";
    const desc = agent.frontmatter?.description
      ? ` — ${String(agent.frontmatter.description)}`
      : "";
    lines.push(`- \`${agent.name}\`${mode}${desc}`);
  }
  lines.push("");
  lines.push("## Skills");
  lines.push("");
  if (inventory.skills.length === 0) lines.push("No Kilo skills discovered.");
  for (const skill of inventory.skills) lines.push(`- \`${skill.name}\``);
  lines.push("");
  lines.push("## Agent Manager");
  lines.push("");
  lines.push(`- State present: ${inventory.agentManager.present}`);
  lines.push(
    `- Setup script present: ${inventory.agentManager.hasSetupScript}`,
  );
  lines.push(`- Run script present: ${inventory.agentManager.hasRunScript}`);
  lines.push("");
  lines.push("## Warnings");
  lines.push("");
  if (health.warnings.length === 0) lines.push("No warnings found.");
  for (const warning of health.warnings) {
    lines.push(
      `- ${warning.severity.toUpperCase()} ${warning.code}: ${warning.message}${
        warning.path ? ` (\`${warning.path}\`)` : ""
      }`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function discover(
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const projectDir = await realPathOrResolve(cfg.projectDir);
  ctx.logger.info("Discovering Kilo Code config from {dir}", {
    dir: projectDir,
  });
  const repoRoot = await findRepoRoot(projectDir);
  const dirs = cfg.includeLegacyPaths
    ? [...MODERN_DIRS, ...LEGACY_DIRS]
    : MODERN_DIRS;
  const roots: ConfigRoot[] = [];

  for (const base of ancestry(projectDir, repoRoot)) {
    for (const dir of dirs) {
      const path = pathJoin(base, dir);
      roots.push({
        path,
        scope: "project",
        exists: await exists(path),
        legacy: dir !== ".kilo",
      });
    }
  }

  if (cfg.includeGlobal) {
    const home = Deno.env.get("HOME");
    if (home) {
      for (const rel of GLOBAL_ROOTS) {
        if (
          !cfg.includeLegacyPaths &&
          (rel.includes("kilocode") || rel.includes("opencode"))
        ) continue;
        const path = pathJoin(home, rel);
        roots.push({
          path,
          scope: "global",
          exists: await exists(path),
          legacy: rel.includes("kilocode") || rel.includes("opencode"),
        });
      }
    }
  }

  const existingRoots = roots.filter((r) => r.exists);
  const configFiles = (await Promise.all(
    existingRoots.map((r) =>
      discoverConfigFiles(r, cfg.maxFileBytes, cfg.redactSecrets)
    ),
  )).flat();
  const commands = (await Promise.all(
    existingRoots.map((r) =>
      discoverMarkdownFiles(
        r,
        ["command", "commands"],
        "command",
        cfg.maxFileBytes,
      )
    ),
  )).flat();
  const fileAgents = (await Promise.all(
    existingRoots.map((r) =>
      discoverMarkdownFiles(r, ["agent", "agents"], "agent", cfg.maxFileBytes)
    ),
  )).flat();
  const agents = [...fileAgents, ...discoverInlineAgents(configFiles)];
  const skills = (await Promise.all(
    existingRoots.map((r) => discoverSkills(r, cfg.maxFileBytes)),
  )).flat();
  const instructionFiles = await discoverInstructionFiles(
    ancestry(projectDir, repoRoot),
  );
  const agentManager = await discoverAgentManager(
    repoRoot,
    cfg.includeAgentManager,
  );
  const warnings = collectWarnings(
    roots,
    configFiles,
    commands,
    agents,
    skills,
    agentManager,
  );
  const discoveredAt = new Date().toISOString();

  const inventory: z.infer<typeof InventorySchema> = {
    projectDir,
    discoveredAt,
    configRoots: roots,
    configFiles,
    commands,
    agents,
    skills,
    instructionFiles,
    agentManager,
    counts: {
      configRoots: existingRoots.length,
      configFiles: configFiles.length,
      commands: commands.length,
      agents: agents.length,
      skills: skills.length,
      instructionFiles: instructionFiles.length,
      warnings: warnings.length,
    },
  };
  const health: z.infer<typeof HealthSchema> = {
    projectDir,
    checkedAt: discoveredAt,
    warnings,
  };
  const summary = renderSummary(inventory, health);

  ctx.logger.info(
    "Discovered Kilo inventory: commands={commands} agents={agents} skills={skills} warnings={warnings}",
    {
      commands: commands.length,
      agents: agents.length,
      skills: skills.length,
      warnings: warnings.length,
    },
  );

  const handles = [
    await ctx.writeResource("inventory", "inventory-current", inventory),
    await ctx.writeResource("health", "health-current", health),
    await ctx.createFileWriter("summary", "summary-current").writeText(summary),
  ];
  return { dataHandles: handles };
}

/**
 * Kilo Code project inventory model: discover Kilo Code CLI configuration,
 * commands, agents, skills, instruction files, MCPs, permissions, and Agent
 * Manager state without running Kilo or mutating project files.
 */
export const model = {
  type: "@maphew/kilo-code-project",
  version: "2026.10.14.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.14.1",
      description:
        "Source moved to maphew/swamp-extensions (AGPL-3.0); no schema, method, or resource changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    inventory: {
      description:
        "Discovered Kilo Code CLI configuration, commands, agents, skills, instructions, and Agent Manager state",
      schema: InventorySchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    health: {
      description:
        "Kilo Code CLI configuration health warnings from the latest discovery run",
      schema: HealthSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },
  files: {
    summary: {
      description:
        "Markdown summary of the discovered Kilo Code project inventory",
      contentType: "text/markdown",
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    discover: {
      description:
        "Discover Kilo Code CLI config, commands, agents, skills, instructions, permissions, MCPs, and Agent Manager diagnostics",
      arguments: z.object({}),
      execute: (_args: Record<string, never>, ctx: ModelContext) =>
        discover(ctx),
    },
    summarise: {
      description:
        "Alias for discover; writes a fresh structured inventory and markdown summary",
      arguments: z.object({}),
      execute: (_args: Record<string, never>, ctx: ModelContext) =>
        discover(ctx),
    },
  },
};
