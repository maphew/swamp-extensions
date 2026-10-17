/**
 * Agent tool config model.
 *
 * Swamp enrolls AI tools in two places, and they mean different things:
 *
 *   - `.swamp.yaml` `tools:` is the **enrollment list**. Every tool on it gets
 *     a config tree materialised and kept in sync by `swamp repo upgrade`,
 *     using swamp's built-in defaults for that tool.
 *   - `.swamp-custom-tools.yaml` holds **custom definitions** — the subset of
 *     enrolled tools whose skills dir, instructions file, or gitignore entries
 *     deviate from the built-in default. A tool absent from this file is
 *     still managed, just with stock settings.
 *
 * Conflating the two produces false alarms: a repo that enrolls
 * `claude, codex, opencode, kilo` but customises only `kilo` is healthy, not
 * drifting. This model reads both files, so the enrollment list drives
 * "enrolled?" and the custom manifest only supplies overrides.
 *
 * What actually drifts:
 *   - a tool is enrolled but its config tree never appeared
 *   - a custom definition names a tool that is no longer enrolled
 *   - a declared instructions file or skills dir does not exist
 *   - a custom gitignore entry is missing from `.gitignore`
 *   - a config tree exists for a tool nobody enrolled and nobody owns
 *
 * Methods:
 *   - `inventory`  per-tool on-disk state vs enrollment and customisation
 *   - `checkDrift` drift findings only
 *
 * @module
 */

import { z } from "npm:zod@4";

// ---------- schemas ---------------------------------------------------------

const ToolSchema = z.object({
  name: z.string().describe(
    "Tool name, from the enrollment list or a custom definition",
  ),
  enrolled: z.boolean().describe(
    "Listed in the enrollment manifest (.swamp.yaml)",
  ),
  customized: z.boolean().describe(
    "Has a custom definition (.swamp-custom-tools.yaml)",
  ),
  configDir: z.string().describe(
    "Repo-relative config directory for this tool",
  ),
  configDirExists: z.boolean(),
  instructionsFile: z.string().nullable().describe(
    "Custom instructions file, if declared",
  ),
  instructionsExists: z.boolean().nullable(),
  skillsDir: z.string().nullable().describe(
    "Custom skills directory, if declared",
  ),
  skillsDirExists: z.boolean().nullable(),
  files: z.array(z.string()).describe(
    "Repo-relative config files found on disk",
  ),
});

const DriftFindingSchema = z.object({
  kind: z.enum([
    "enrolled-but-absent",
    "stale-customization",
    "unmanaged-dir",
    "missing-instructions",
    "missing-skills-dir",
    "gitignore-entry-missing",
    "unreadable-manifest",
  ]),
  severity: z.enum(["error", "warning"]),
  tool: z.string(),
  file: z.string(),
  message: z.string(),
});

const InventorySchema = z.object({
  projectDir: z.string(),
  manifestPresent: z.boolean(),
  enrollmentManifestPresent: z.boolean(),
  enrolledTools: z.array(z.string()),
  customizedTools: z.array(z.string()),
  tools: z.array(ToolSchema),
  gitignoreEntries: z.array(z.string()),
  findings: z.array(DriftFindingSchema),
  healthy: z.boolean(),
});

const DriftReportSchema = z.object({
  projectDir: z.string(),
  findings: z.array(DriftFindingSchema),
  errorCount: z.number().int(),
  warningCount: z.number().int(),
});

const GlobalArgsSchema = z.object({
  projectDir: z.string().default(".").describe(
    "Swamp repo root to inspect. Defaults to the current directory so the model stays portable across machines.",
  ),
  enrollmentManifest: z.string().default(".swamp.yaml").describe(
    "Repo-relative enrollment manifest whose `tools:` list swamp manages",
  ),
  customToolsManifest: z.string().default(".swamp-custom-tools.yaml").describe(
    "Repo-relative manifest holding custom tool definitions (overrides of the built-in defaults)",
  ),
  gitignoreFile: z.string().default(".gitignore").describe(
    "Repo-relative gitignore to check custom gitignore entries against",
  ),
  configDirs: z.array(z.string()).default([
    ".claude",
    ".codex",
    ".cursor",
    ".kilo",
    ".kilocode",
    ".opencode",
  ]).describe("Repo-relative config directories that correspond to an AI tool"),
  projectOwnedDirs: z.array(z.string()).default([]).describe(
    "Config directories the project maintains by hand rather than delegating to swamp. Listed here so they are not reported as unmanaged.",
  ),
});

// ---------- helpers ---------------------------------------------------------

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type ToolEntry = z.infer<typeof ToolSchema>;
type DriftFinding = z.infer<typeof DriftFindingSchema>;
type CustomTool = {
  name: string;
  skillsDir: string | null;
  instructionsFile: string | null;
};
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

const SKIP_DIRS = new Set(["node_modules", ".git", ".swamp"]);

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await Deno.readFile(path));
  } catch {
    return null;
  }
}

async function listFiles(
  root: string,
  base: string,
  depth = 0,
): Promise<string[]> {
  if (depth > 3) return [];
  const out: string[] = [];
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(root);
  } catch {
    return out;
  }
  for await (const entry of entries) {
    const rel = `${base}/${entry.name}`;
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...await listFiles(`${root}/${entry.name}`, rel, depth + 1));
    } else if (entry.isFile) {
      out.push(rel);
    }
  }
  return out.sort();
}

/** Strip surrounding single or double quotes and whitespace from a scalar. */
export function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

/**
 * Parse the `tools:` block of the enrollment manifest. It is a flat list of
 * scalar items (`  - claude`), swamp-written and stable in shape, so targeted
 * patterns beat pulling in a YAML dependency.
 */
export function parseEnrollment(text: string): string[] {
  const block = /^tools:\s*\n((?:\s+-\s*\S+.*\n?)*)/m.exec(text)?.[1];
  if (!block) return [];
  return block
    .split("\n")
    .map((line) => /^\s+-\s*(\S+)/.exec(line)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(unquote);
}

/**
 * Parse the custom tools manifest. Each tool opens with a `- name: <tool>`
 * bullet; the `gitignoreEntries:` literal blocks are collected across all of
 * them, not just the first.
 */
/**
 * Parse the custom-tools manifest into per-tool definitions plus the
 * aggregated `gitignoreEntries:` literal blocks.
 */
export function parseCustomTools(
  text: string,
): { tools: CustomTool[]; gitignoreEntries: string[] } {
  const tools: CustomTool[] = [];

  const blocks = text.split(/\n\s*-\s+name:\s*/).slice(1);
  for (const block of blocks) {
    const name = unquote(block.split("\n")[0]);
    const skillsDir = /^\s*skillsDir:\s*(\S+)/m.exec(block)?.[1] ?? null;
    const instructionsFile =
      /^\s*instructionsFile:\s*(\S+)/m.exec(block)?.[1] ?? null;
    tools.push({
      name,
      skillsDir: skillsDir ? unquote(skillsDir) : null,
      instructionsFile: instructionsFile ? unquote(instructionsFile) : null,
    });
  }

  const gitignoreEntries: string[] = [];
  const literalBlock = /^\s*gitignoreEntries:\s*\|\s*\n((?:\s{4,}.*\n?)*)/gm;
  for (const match of text.matchAll(literalBlock)) {
    for (const line of match[1].split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      gitignoreEntries.push(trimmed);
    }
  }

  return { tools, gitignoreEntries };
}

async function buildInventory(
  ctx: ModelContext,
): Promise<
  {
    inventory: z.infer<typeof InventorySchema>;
    drift: z.infer<typeof DriftReportSchema>;
  }
> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const root = cfg.projectDir;
  const findings: DriftFinding[] = [];

  // ---- enrollment ----------------------------------------------------------

  const enrollmentText = await readTextIfPresent(
    `${root}/${cfg.enrollmentManifest}`,
  );
  const enrollmentPresent = enrollmentText !== null;
  const enrolledTools = enrollmentText ? parseEnrollment(enrollmentText) : [];

  if (!enrollmentPresent) {
    findings.push({
      kind: "unreadable-manifest",
      severity: "error",
      tool: "",
      file: cfg.enrollmentManifest,
      message:
        "Tool enrollment manifest is missing — no tool is known to be managed",
    });
  } else if (enrolledTools.length === 0) {
    findings.push({
      kind: "unreadable-manifest",
      severity: "warning",
      tool: "",
      file: cfg.enrollmentManifest,
      message:
        "No tools parsed from the `tools:` list of the enrollment manifest",
    });
  }

  // ---- custom definitions --------------------------------------------------

  const customText = await readTextIfPresent(
    `${root}/${cfg.customToolsManifest}`,
  );
  const customPresent = customText !== null;
  let custom: CustomTool[] = [];
  let gitignoreEntries: string[] = [];

  if (customPresent && customText) {
    const parsed = parseCustomTools(customText);
    custom = parsed.tools;
    gitignoreEntries = parsed.gitignoreEntries;
    if (custom.length === 0) {
      findings.push({
        kind: "unreadable-manifest",
        severity: "warning",
        tool: "",
        file: cfg.customToolsManifest,
        message:
          "No custom tool definitions parsed — the file may be empty or malformed",
      });
    }
  }

  const enrolledSet = new Set(enrolledTools);
  const customByName = new Map(custom.map((t) => [t.name, t]));

  // A custom definition for a tool that is no longer enrolled is dead config:
  // swamp will not regenerate it, and the operator almost certainly meant to
  // either re-enroll the tool or drop the override.
  for (const t of custom) {
    if (enrolledSet.has(t.name)) continue;
    findings.push({
      kind: "stale-customization",
      severity: "error",
      tool: t.name,
      file: cfg.customToolsManifest,
      message:
        `"${t.name}" has a custom definition but is not enrolled in ${cfg.enrollmentManifest}`,
    });
  }

  // ---- per-tool disk state -------------------------------------------------

  const toolNames = [
    ...new Set([...enrolledTools, ...custom.map((t) => t.name)]),
  ];
  const tools: ToolEntry[] = [];

  for (const name of toolNames) {
    const enrolled = enrolledSet.has(name);
    const customDef = customByName.get(name) ?? null;
    const configDir = `.${name}`;
    const configDirExists = await isDir(`${root}/${configDir}`);

    const instructionsFile = customDef?.instructionsFile ?? null;
    const skillsDir = customDef?.skillsDir ?? null;

    const instructionsExists = instructionsFile
      ? await exists(`${root}/${instructionsFile}`)
      : null;
    const skillsDirExists = skillsDir
      ? await isDir(`${root}/${skillsDir}`)
      : null;

    if (enrolled && !configDirExists) {
      findings.push({
        kind: "enrolled-but-absent",
        severity: "error",
        tool: name,
        file: configDir,
        message:
          `Tool "${name}" is enrolled but ${configDir}/ does not exist (run \`swamp repo upgrade\`)`,
      });
    }
    if (instructionsFile && instructionsExists === false) {
      findings.push({
        kind: "missing-instructions",
        severity: "error",
        tool: name,
        file: instructionsFile,
        message: `Instructions file declared for "${name}" does not exist`,
      });
    }
    if (skillsDir && skillsDirExists === false) {
      findings.push({
        kind: "missing-skills-dir",
        severity: "warning",
        tool: name,
        file: skillsDir,
        message:
          `Skills dir declared for "${name}" does not exist (regenerate with \`swamp repo upgrade\`)`,
      });
    }

    tools.push({
      name,
      enrolled,
      customized: customDef !== null,
      configDir,
      configDirExists,
      instructionsFile,
      instructionsExists,
      skillsDir,
      skillsDirExists,
      files: configDirExists
        ? await listFiles(`${root}/${configDir}`, configDir)
        : [],
    });
  }

  // ---- config dirs nobody enrolled or owns ---------------------------------

  const known = new Set([
    ...toolNames,
    ...cfg.projectOwnedDirs.map((d) => d.replace(/^\./, "")),
  ]);
  for (const dir of cfg.configDirs) {
    const name = dir.replace(/^\./, "");
    if (known.has(name)) continue;
    if (!(await isDir(`${root}/${dir}`))) continue;
    findings.push({
      kind: "unmanaged-dir",
      severity: "warning",
      tool: name,
      file: dir,
      message:
        `${dir}/ exists but "${name}" is neither enrolled nor listed in projectOwnedDirs — swamp will not keep it in sync`,
    });
  }

  // ---- custom gitignore entries must actually be ignored --------------------

  if (gitignoreEntries.length > 0) {
    const gitignoreText =
      (await readTextIfPresent(`${root}/${cfg.gitignoreFile}`)) ?? "";
    const gitignoreLines = new Set(
      gitignoreText.split("\n").map((l) => l.trim()).filter((l) =>
        l && !l.startsWith("#")
      ),
    );
    for (const entry of gitignoreEntries) {
      if (gitignoreLines.has(entry)) continue;
      findings.push({
        kind: "gitignore-entry-missing",
        severity: "warning",
        tool: "",
        file: cfg.gitignoreFile,
        message:
          `Custom tool declares gitignore entry "${entry}" but it is absent from ${cfg.gitignoreFile}`,
      });
    }
  }

  tools.sort((a, b) => a.name.localeCompare(b.name));
  findings.sort((a, b) =>
    a.file.localeCompare(b.file) || a.kind.localeCompare(b.kind)
  );

  const inventory: z.infer<typeof InventorySchema> = {
    projectDir: root,
    manifestPresent: customPresent,
    enrollmentManifestPresent: enrollmentPresent,
    enrolledTools: [...enrolledTools].sort(),
    customizedTools: [...customByName.keys()].sort(),
    tools,
    gitignoreEntries,
    findings,
    healthy: findings.every((f) => f.severity !== "error"),
  };

  const drift: z.infer<typeof DriftReportSchema> = {
    projectDir: root,
    findings,
    errorCount: findings.filter((f) => f.severity === "error").length,
    warningCount: findings.filter((f) => f.severity === "warning").length,
  };

  ctx.logger.info(
    "Inventoried {e} enrolled and {c} customized tool(s), {err} error(s), {w} warning(s)",
    {
      e: enrolledTools.length,
      c: custom.length,
      err: drift.errorCount,
      w: drift.warningCount,
    },
  );

  return { inventory, drift };
}

function renderReport(inventory: z.infer<typeof InventorySchema>): string {
  const lines: string[] = [];
  lines.push("# Agent Tool Config");
  lines.push("");
  lines.push(`- Repo: \`${inventory.projectDir}\``);
  lines.push(
    `- Enrollment manifest: ${
      inventory.enrollmentManifestPresent ? "found" : "**missing**"
    }`,
  );
  const customManifestState = inventory.manifestPresent
    ? "found"
    : "**missing** (stock defaults apply to every enrolled tool)";
  lines.push(`- Custom tools manifest: ${customManifestState}`);
  lines.push(
    `- Enrolled tools: ${inventory.enrolledTools.join(", ") || "none"}`,
  );
  lines.push(
    `- Customised tools: ${inventory.customizedTools.join(", ") || "none"}`,
  );
  lines.push(
    `- Verdict: **${inventory.healthy ? "in sync" : "drift detected"}**`,
  );
  lines.push("");

  lines.push("## Tools");
  lines.push("");
  lines.push(
    "| Tool | Enrolled | Customised | Config dir | On disk | Instructions | Skills | Files |",
  );
  lines.push(
    "|------|----------|------------|------------|---------|--------------|--------|-------|",
  );
  for (const t of inventory.tools) {
    lines.push(
      `| ${t.name} | ${t.enrolled ? "✓" : "—"} | ${
        t.customized ? "✓" : "—"
      } | \`${t.configDir}\` | ` +
        `${t.configDirExists ? "✓" : "✗"} | ` +
        `${t.instructionsFile ?? "—"} ${
          t.instructionsExists === false ? "✗" : ""
        } | ` +
        `${t.skillsDir ?? "—"} ${t.skillsDirExists === false ? "✗" : ""} | ` +
        `${t.files.length} |`,
    );
  }
  lines.push("");

  if (inventory.gitignoreEntries.length > 0) {
    lines.push("## Custom gitignore entries");
    lines.push("");
    for (const entry of inventory.gitignoreEntries) {
      lines.push(`- \`${entry}\``);
    }
    lines.push("");
  }

  lines.push(`## Findings (${inventory.findings.length})`);
  lines.push("");
  if (inventory.findings.length === 0) {
    lines.push("No drift.");
  } else {
    for (const f of inventory.findings) {
      lines.push(
        `- **${f.severity}** \`${f.kind}\` \`${f.file}\` — ${f.message}`,
      );
    }
  }
  return lines.join("\n");
}

// ---------- methods ---------------------------------------------------------

async function inventory(
  _args: Record<string, never>,
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const { inventory: inv, drift } = await buildInventory(ctx);
  const handles = [
    await ctx.writeResource("inventory", "inventory-current", inv),
    await ctx.writeResource("drift", "drift-current", drift),
    await ctx.createFileWriter("report", "report-current").writeText(
      renderReport(inv),
    ),
  ];
  return { dataHandles: handles };
}

async function checkDrift(
  _args: Record<string, never>,
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const { drift } = await buildInventory(ctx);
  const handle = await ctx.writeResource("drift", "drift-current", drift);
  return { dataHandles: [handle] };
}

// ---------- terminal-keymap-setup -----------------------------------------
//
// Ported from the @keeb/skill-converter scaffold (myswamp-75d). These methods
// implement the deterministic parts of the `terminal-keymap-setup` skill:
// probe the input chain (OS → outer terminal → multiplexer → agent), plan the
// effective submit/newline chords, idempotently apply pi/Ghostty/xdg config,
// and verify what Ghostty actually parsed. The physical keystroke test stays a
// manual gate in `workflow-terminal-keymap-setup.yaml`.

/** Data written by probeTerminalChain: the detected input chain. */
const TerminalProbeSchema = z.object({
  method: z.string().describe("Method that wrote this result"),
  timestamp: z.string().describe("ISO-8601 time the result was written"),
  term: z.string().nullable().describe("$TERM"),
  termProgram: z.string().nullable().describe("$TERM_PROGRAM"),
  wslDistroName: z.string().nullable().describe("$WSL_DISTRO_NAME"),
  tmuxActive: z.boolean().describe("True when $TMUX is set"),
  herdrPaneId: z.string().nullable().describe("$HERDR_PANE_ID"),
  ancestry: z.array(z.string()).describe(
    "Process names from innermost to outermost",
  ),
  ancestryUnavailable: z.string().nullable().describe(
    "Why /proc ancestry could not be read, or null when it was",
  ),
  outerTerminal: z.string().describe("Classified outer terminal id"),
  outerSupportsModifiedEnter: z.boolean().describe(
    "Whether the outer terminal can report modified Enter distinctly",
  ),
  vteTerminal: z.boolean().describe("Whether the outer terminal is VTE-based"),
  platform: z.string().describe("linux | wsl | windows | macos"),
  gnomeDetected: z.boolean().describe("Whether a GNOME session was detected"),
  reason: z.string().describe("Why the classification was chosen"),
});

/** Data written by readDefaultTerminal: the current XDG terminal state. */
const XdgDefaultTerminalCurrentSchema = z.object({
  method: z.string().describe("Method that wrote this result"),
  timestamp: z.string().describe("ISO-8601 time the result was written"),
  gsettingsExec: z.string().nullable().describe(
    "gsettings default-applications terminal exec value",
  ),
  isXdgIndirection: z.boolean().nullable().describe(
    "Whether gsettings points at xdg-terminal-exec",
  ),
  currentDesktopId: z.string().nullable().describe(
    "Desktop id xdg-terminal-exec would launch today",
  ),
  gsettingsAvailable: z.boolean(),
  xdgTerminalExecAvailable: z.boolean(),
  warning: z.string().nullable().describe("Non-fatal state warning"),
});

/** Data written by planKeymap: the computed chords and snippets. */
const KeymapPlanSchema = z.object({
  method: z.string().describe("Method that wrote this result"),
  timestamp: z.string().describe("ISO-8601 time the result was written"),
  submitChord: z.enum(["ctrl+enter", "alt+enter"]),
  newLineChord: z.literal("enter"),
  followUpChord: z.string().nullable(),
  piKeybindings: z.record(z.string(), z.string()),
  ghosttyKeybindLine: z.string(),
  ghosttyTextFallback: z.boolean(),
  strategy: z.enum(["kitty-protocol", "alt-enter-fallback"]),
  reason: z.string(),
  tmuxWarning: z.string().nullable(),
  herdrNote: z.string().nullable(),
});

/** Data written by applyPiKeybindings. */
const PiKeybindingsSchema = z.object({
  method: z.string().describe("Method that wrote this result"),
  timestamp: z.string().describe("ISO-8601 time the result was written"),
  resolvedAgentDir: z.string(),
  path: z.string(),
  existed: z.boolean(),
  changed: z.boolean(),
  submitChord: z.string(),
  newLineChord: z.string(),
  followUpChord: z.string().nullable(),
  finalContent: z.string(),
  contentHash: z.string().describe("SHA-256 of the written content"),
});

/** Data written by applyGhosttyConfig. */
const GhosttyConfigSchema = z.object({
  method: z.string().describe("Method that wrote this result"),
  timestamp: z.string().describe("ISO-8601 time the result was written"),
  resolvedPath: z.string(),
  configFileUsed: z.string().describe("config.ghostty or config"),
  existed: z.boolean(),
  changed: z.boolean(),
  fontFamilyLine: z.string(),
  keybindLine: z.string(),
  removedConflictingKeybinds: z.number().int(),
  ghosttyDetected: z.boolean(),
  contentHash: z.string().describe("SHA-256 of the written content"),
});

/** Data written by applyXdgDefaultTerminal. */
const XdgDefaultTerminalSchema = z.object({
  method: z.string().describe("Method that wrote this result"),
  timestamp: z.string().describe("ISO-8601 time the result was written"),
  listPath: z.string(),
  changed: z.boolean(),
  desiredDesktopId: z.string(),
  desktopEntryFound: z.boolean(),
  printIdBefore: z.string().nullable(),
  printIdAfter: z.string().nullable(),
  noop: z.boolean(),
  noopReason: z.string().nullable(),
  gsettingsWarning: z.string().nullable(),
});

/** Data written by verifyGhosttyConfig. */
const GhosttyVerifySchema = z.object({
  method: z.string().describe("Method that wrote this result"),
  timestamp: z.string().describe("ISO-8601 time the result was written"),
  ghosttyInstalled: z.boolean(),
  ctrlEnterPresent: z.boolean(),
  fontFamilyResolved: z.string().nullable(),
  fontFamilyMatches: z.boolean().nullable(),
  configValid: z.boolean(),
  rawOutput: z.string().describe("Bounded show-config grep output"),
  rawOutputTruncated: z.boolean().describe("Whether rawOutput was capped"),
});

const PlanKeymapArgsSchema = z.object({
  outerTerminal: z.string().describe("outerTerminal id from terminal-probe"),
  outerSupportsModifiedEnter: z
    .boolean()
    .describe("outerSupportsModifiedEnter from terminal-probe"),
  platform: z.string().describe("platform from terminal-probe"),
  multiplexer: z.string().describe("multiplexer from terminal-probe"),
  preferredSubmitChord: z
    .string()
    .describe("The user's preferred submit chord"),
});

const ApplyPiKeybindingsArgsSchema = z.object({
  submitChord: z.string().describe("Desired tui.input.submit value"),
  newLineChord: z.string().describe("Desired tui.input.newLine value"),
  followUpChord: z
    .string()
    .nullish()
    .describe("Desired app.message.followUp value, or null to leave default"),
  agentDir: z
    .string()
    .nullish()
    .describe("Explicit pi agent dir override"),
});

const ApplyGhosttyConfigArgsSchema = z.object({
  keybindLine: z.string().describe("Ghostty keybind line to merge"),
  fontFamily: z.string().describe("Desired Ghostty font-family"),
  configPath: z
    .string()
    .nullish()
    .describe("Explicit Ghostty config path override"),
});

const ApplyXdgDefaultTerminalArgsSchema = z.object({
  desktopId: z.string().describe("Desktop entry id to prefer"),
});

const VerifyGhosttyConfigArgsSchema = z.object({
  fontFamily: z
    .string()
    .nullish()
    .describe("Expected font family to compare against"),
});

/** Environment variable map; injectable so the pure helpers are testable. */
export type TerminalEnv = Record<string, string | undefined>;

function envObject(): TerminalEnv {
  try {
    return Deno.env.toObject();
  } catch {
    return {};
  }
}

/** Platform label used by the modified-Enter capability table. */
export function detectPlatform(
  env: TerminalEnv,
  os: string,
): "linux" | "wsl" | "windows" | "macos" {
  if (env.WSL_DISTRO_NAME) return "wsl";
  if (os === "windows") return "windows";
  if (os === "darwin") return "macos";
  return "linux";
}

/** True when the desktop session is GNOME, where xdg-terminal-exec matters. */
export function detectGnome(env: TerminalEnv): boolean {
  const indicators = [
    env.XDG_CURRENT_DESKTOP,
    env.XDG_SESSION_DESKTOP,
    env.GDMSESSION,
  ];
  return indicators.some((v) => (v ?? "").toLowerCase().includes("gnome"));
}

const VTE_TERMINALS = new Set([
  "vte-ptyxis",
  "ptyxis",
  "gnome-terminal",
  "xfce4-terminal",
  "terminator",
]);

const MODIFIED_ENTER_TERMINALS = new Set([
  "ghostty",
  "kitty",
  "foot",
  "wezterm",
  "iterm2",
  "alacritty",
  "windows-terminal",
]);

/** Identify the outer terminal from env hints first, then process ancestry. */
export function detectOuterTerminal(
  env: TerminalEnv,
  ancestry: string[],
): string {
  const term = (env.TERM ?? "").toLowerCase();
  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
  const proc = ancestry.join(" ").toLowerCase();

  if (
    env.GHOSTTY_RESOURCES_DIR || termProgram.includes("ghostty") ||
    proc.includes("ghostty")
  ) return "ghostty";
  if (
    env.KITTY_WINDOW_ID || term.includes("kitty") || proc.includes("kitty")
  ) return "kitty";
  if (
    env.WEZTERM_PANE || termProgram.includes("wezterm") ||
    proc.includes("wezterm")
  ) return "wezterm";
  if (
    env.ALACRITTY_WINDOW_ID || term.includes("alacritty") ||
    proc.includes("alacritty")
  ) return "alacritty";
  if (term.includes("foot") || proc.includes("foot")) return "foot";
  if (termProgram.includes("iterm") || proc.includes("iterm")) {
    return "iterm2";
  }
  if (
    env.WT_SESSION || proc.includes("windowsterminal") ||
    proc.includes("windows-terminal")
  ) return "windows-terminal";

  // VTE family — Ctrl+Enter collapses to a bare CR and cannot be recovered.
  if (termProgram.includes("ptyxis") || proc.includes("ptyxis")) {
    return "vte-ptyxis";
  }
  if (proc.includes("gnome-terminal")) return "gnome-terminal";
  if (proc.includes("xfce4-terminal")) return "xfce4-terminal";
  if (proc.includes("terminator")) return "terminator";
  if (termProgram.includes("vte")) return "vte-ptyxis";
  return "unknown";
}

/**
 * Apply the skill's capability table to the detected environment. The table
 * is a planning hint, never a substitute for the Step 5 press test.
 */
export function classifyTerminal(
  env: TerminalEnv,
  ancestry: string[],
  os: string,
): {
  outerTerminal: string;
  outerSupportsModifiedEnter: boolean;
  vteTerminal: boolean;
  platform: string;
  gnomeDetected: boolean;
  reason: string;
} {
  const outerTerminal = detectOuterTerminal(env, ancestry);
  const platform = detectPlatform(env, os);
  const gnomeDetected = detectGnome(env);
  const vteTerminal = VTE_TERMINALS.has(outerTerminal);
  const outerSupportsModifiedEnter = MODIFIED_ENTER_TERMINALS.has(
    outerTerminal,
  );
  let reason: string;
  if (outerTerminal === "unknown") {
    reason =
      "Could not classify the outer terminal from TERM/TERM_PROGRAM/ancestry; walk the skill's Step 0 probes by hand.";
  } else if (outerSupportsModifiedEnter) {
    reason =
      `"${outerTerminal}" reports modified Enter distinctly (Kitty keyboard protocol).`;
  } else if (vteTerminal) {
    reason =
      `"${outerTerminal}" is VTE-based: Ctrl+Enter arrives as a bare CR; only Alt+Enter (ESC CR) is distinct.`;
  } else {
    reason =
      `"${outerTerminal}" has no known distinct modified-Enter reporting; treat it as unable until the Step 5 press test proves otherwise.`;
  }
  return {
    outerTerminal,
    outerSupportsModifiedEnter,
    vteTerminal,
    platform,
    gnomeDetected,
    reason,
  };
}

/** Process names walked from /proc plus any reason the walk was unavailable. */
export type ProcAncestry = { names: string[]; error: string | null };

/**
 * Walk /proc parent links, returning process names innermost to outermost.
 *
 * Deno only permits reading `/proc/<pid>` under `--allow-all`, so a swamp-run
 * extension normally cannot read it. The failure is returned as `error` rather
 * than swallowed, so the probe can tell "no ancestors" from "cannot look" and
 * tell the operator to run the shell ancestry probe by hand.
 */
export async function readProcAncestry(
  pid: number,
  max = 8,
): Promise<ProcAncestry> {
  const names: string[] = [];
  let error: string | null = null;
  let current: number | null = pid;
  for (let i = 0; i < max && current && current > 0; i++) {
    let comm: string;
    try {
      comm = (await Deno.readTextFile(`/proc/${current}/comm`)).trim();
    } catch (e) {
      if (names.length === 0) {
        error = e instanceof Error ? e.message : String(e);
      }
      break;
    }
    names.push(comm);
    let stat: string;
    try {
      stat = await Deno.readTextFile(`/proc/${current}/stat`);
    } catch {
      break;
    }
    const close = stat.lastIndexOf(")");
    if (close < 0) break;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const ppid = Number.parseInt(fields[1] ?? "", 10);
    if (!Number.isFinite(ppid) || ppid <= 0) break;
    current = ppid;
  }
  return { names, error };
}

/** Result of running a subprocess, or null when the binary is missing. */
export type CmdResult = { stdout: string; stderr: string; code: number };

/** Run a command, returning null instead of throwing when it cannot start. */
export async function run(
  cmd: string[],
  cwd?: string,
): Promise<CmdResult | null> {
  try {
    // swamp-quality-ignore deno-command
    const output = await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "piped",
      cwd,
    }).output();
    return {
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
      code: output.code,
    };
  } catch {
    return null;
  }
}

/** True when a binary resolves on PATH. */
export async function commandAvailable(bin: string): Promise<boolean> {
  if (Deno.build.os === "windows") {
    const result = await run(["where", bin]);
    return result !== null && result.code === 0;
  }
  const result = await run(["sh", "-c", `command -v ${bin} >/dev/null 2>&1`]);
  return result !== null && result.code === 0;
}

/** Lowercase hex SHA-256 of a UTF-8 string, for drift-watching hashes. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Minimal path join for the POSIX and Windows paths these methods resolve. */
export function joinPath(...parts: string[]): string {
  const sep = Deno.build.os === "windows" ? "\\" : "/";
  return parts.filter((p) => p.length > 0).join(sep);
}

/** Final path component (POSIX or Windows separators). */
export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** Parent path (POSIX or Windows separators); "." when there is none. */
export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : ".";
}

/** A computed keymap plan: the pure output of the capability table. */
export type KeymapPlan = {
  submitChord: "ctrl+enter" | "alt+enter";
  newLineChord: "enter";
  followUpChord: string | null;
  piKeybindings: Record<string, string>;
  ghosttyKeybindLine: string;
  ghosttyTextFallback: boolean;
  strategy: "kitty-protocol" | "alt-enter-fallback";
  reason: string;
  tmuxWarning: string | null;
  herdrNote: string | null;
};

/** Apply the skill's strategy table to a probe classification. */
export function planKeymapFromProbe(input: {
  outerTerminal: string;
  outerSupportsModifiedEnter: boolean;
  platform: string;
  multiplexer: string;
  preferredSubmitChord: string;
}): KeymapPlan {
  const capable = input.outerSupportsModifiedEnter &&
    input.preferredSubmitChord === "ctrl+enter";
  const strategy = capable ? "kitty-protocol" : "alt-enter-fallback";
  const submitChord = capable ? "ctrl+enter" : "alt+enter";
  const followUpChord = (!capable || input.platform === "windows" ||
      input.platform === "wsl")
    ? "ctrl+q"
    : null;
  const piKeybindings: Record<string, string> = {
    "tui.input.submit": submitChord,
    "tui.input.newLine": "enter",
  };
  if (followUpChord) piKeybindings["app.message.followUp"] = followUpChord;

  let reason: string;
  if (capable) {
    reason =
      `"${input.outerTerminal}" reports modified Enter distinctly; binding Ctrl+Enter to submit.`;
  } else if (input.preferredSubmitChord !== "ctrl+enter") {
    reason =
      `Preferred submit chord "${input.preferredSubmitChord}" is not the distinct-Enter chord; using Alt+Enter and moving the follow-up queue to Ctrl+Q.`;
  } else {
    reason =
      `"${input.outerTerminal}" cannot report Ctrl+Enter distinctly, so nothing downstream can recover it; using Alt+Enter and moving the follow-up queue to Ctrl+Q.`;
  }

  return {
    submitChord,
    newLineChord: "enter",
    followUpChord,
    piKeybindings,
    ghosttyKeybindLine: "keybind = ctrl+enter=unbind",
    ghosttyTextFallback: false,
    strategy,
    reason,
    tmuxWarning: input.multiplexer === "tmux"
      ? "tmux collapses modified Enter by default: `set -g extended-keys on` plus `set -g extended-keys-format csi-u` on tmux >= 3.5, then restart the tmux server (see pi docs/tmux.md)."
      : null,
    herdrNote: input.multiplexer === "herdr"
      ? "herdr supports Kitty keyboard input to panes by default (no config); pi also parses the xterm modifyOtherKeys form (CSI 27;5;13~)."
      : null,
  };
}

/** Resolve the per-user pi agent dir: explicit > env > platform default. */
export function resolvePiAgentDir(
  agentDir: string | null | undefined,
  env: TerminalEnv,
  os: string,
): string {
  if (agentDir) return agentDir;
  if (env.PI_CODING_AGENT_DIR) return env.PI_CODING_AGENT_DIR;
  if (os === "windows") {
    const home = env.USERPROFILE ?? env.HOME ?? "";
    return joinPath(home, ".pi", "agent");
  }
  return joinPath(env.HOME ?? "", ".pi", "agent");
}

/**
 * Merge desired bindings onto an existing keybindings object. Other keys are
 * preserved, so a user's custom bindings and `tui.select.confirm` survive.
 */
export function mergePiKeybindings(
  existing: unknown,
  desired: Record<string, string>,
): { final: Record<string, unknown>; changed: boolean } {
  const isObject = existing !== null && typeof existing === "object" &&
    !Array.isArray(existing);
  const final: Record<string, unknown> = isObject
    ? { ...(existing as Record<string, unknown>) }
    : {};
  let changed = !isObject;
  for (const [key, value] of Object.entries(desired)) {
    if (final[key] !== value) {
      final[key] = value;
      changed = true;
    }
  }
  return { final, changed };
}

/** Resolve the Ghostty config path for the current platform. */
export function resolveGhosttyConfigPath(
  configPath: string | null | undefined,
  env: TerminalEnv,
  os: string,
): string {
  if (configPath) return configPath;
  if (os === "windows") {
    const base = env.LOCALAPPDATA ??
      joinPath(env.USERPROFILE ?? "", "AppData", "Local");
    return joinPath(base, "ghostty", "config.ghostty");
  }
  if (os === "darwin") {
    return joinPath(
      env.HOME ?? "",
      "Library",
      "Application Support",
      "com.mitchellh.ghostty",
      "config.ghostty",
    );
  }
  const base = env.XDG_CONFIG_HOME ?? joinPath(env.HOME ?? "", ".config");
  return joinPath(base, "ghostty", "config.ghostty");
}

/**
 * Merge one `font-family` line and the ctrl+enter keybind into an existing
 * Ghostty config, removing every conflicting ctrl+enter binding. Idempotent:
 * re-running produces byte-identical output.
 */
export function mergeGhosttyConfig(
  existing: string | null,
  fontFamily: string,
  keybindLine: string,
): {
  content: string;
  changed: boolean;
  removedConflictingKeybinds: number;
  removedFontFamily: number;
} {
  const original = existing ?? "";
  const fontLine = `font-family = ${fontFamily}`;
  const fontRe = /^\s*font-family\s*=/i;
  const keybindRe = /^\s*keybind\s*=\s*ctrl\+enter\s*=/i;
  let removedConflictingKeybinds = 0;
  let removedFontFamily = 0;
  const kept: string[] = [];
  for (const line of original.length > 0 ? original.split("\n") : []) {
    if (fontRe.test(line)) {
      removedFontFamily++;
      continue;
    }
    if (keybindRe.test(line)) {
      removedConflictingKeybinds++;
      continue;
    }
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  const content = [...kept, fontLine, keybindLine].join("\n") + "\n";
  return {
    content,
    changed: content !== original,
    removedConflictingKeybinds,
    removedFontFamily,
  };
}

/** Candidate XDG application directories, most specific first. */
export function desktopEntryDirs(env: TerminalEnv): string[] {
  const dirs: string[] = [];
  const dataHome = env.XDG_DATA_HOME ??
    joinPath(env.HOME ?? "", ".local", "share");
  dirs.push(dataHome);
  const system = (env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share")
    .split(":");
  dirs.push(...system);
  return dirs.filter((d) => d.length > 0);
}

async function probeTerminalChain(
  _args: Record<string, never>,
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const env = envObject();
  const os = Deno.build.os;
  const ancestryResult = os === "windows"
    ? { names: [] as string[], error: null }
    : await readProcAncestry(Deno.pid);
  const classification = classifyTerminal(env, ancestryResult.names, os);
  if (ancestryResult.error) {
    classification.reason +=
      " /proc ancestry could not be read (Deno needs --allow-all for /proc/<pid>); run the skill's shell ancestry probe by hand.";
  }
  ctx.logger.info(
    "Probed terminal chain: outer={outerTerminal}, platform={platform}, canReportModifiedEnter={supported}",
    {
      outerTerminal: classification.outerTerminal,
      platform: classification.platform,
      supported: classification.outerSupportsModifiedEnter,
    },
  );
  const handle = await ctx.writeResource("terminalProbe", "terminal-probe", {
    method: "probeTerminalChain",
    timestamp: new Date().toISOString(),
    term: env.TERM ?? null,
    termProgram: env.TERM_PROGRAM ?? null,
    wslDistroName: env.WSL_DISTRO_NAME ?? null,
    tmuxActive: (env.TMUX ?? "").length > 0,
    herdrPaneId: env.HERDR_PANE_ID ?? null,
    ancestry: ancestryResult.names,
    ancestryUnavailable: ancestryResult.error,
    ...classification,
  });
  return { dataHandles: [handle] };
}

async function readDefaultTerminal(
  _args: Record<string, never>,
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const gsettings = await run([
    "gsettings",
    "get",
    "org.gnome.desktop.default-applications.terminal",
    "exec",
  ]);
  const gsettingsAvailable = gsettings !== null;
  const gsettingsExec = gsettings !== null && gsettings.code === 0
    ? gsettings.stdout.trim()
    : null;
  const xdg = await run(["xdg-terminal-exec", "--print-id"]);
  const xdgTerminalExecAvailable = xdg !== null;
  const currentDesktopId = xdg !== null && xdg.code === 0
    ? xdg.stdout.trim()
    : null;
  const isXdgIndirection = gsettingsExec === null
    ? null
    : unquote(gsettingsExec) === "xdg-terminal-exec";
  const warning = isXdgIndirection === false
    ? `gsettings default terminal is ${gsettingsExec}, not 'xdg-terminal-exec'; the XDG indirection is not in place.`
    : null;
  ctx.logger.info(
    "Read default terminal: gsettings={gsettingsExec}, xdg-terminal-exec id={currentDesktopId}",
    { gsettingsExec, currentDesktopId },
  );
  const handle = await ctx.writeResource(
    "xdgDefaultTerminalCurrent",
    "xdg-default-terminal-current",
    {
      method: "readDefaultTerminal",
      timestamp: new Date().toISOString(),
      gsettingsExec,
      isXdgIndirection,
      currentDesktopId,
      gsettingsAvailable,
      xdgTerminalExecAvailable,
      warning,
    },
  );
  return { dataHandles: [handle] };
}

async function planKeymap(
  args: Record<string, unknown>,
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const a = PlanKeymapArgsSchema.parse(args);
  const plan = planKeymapFromProbe(a);
  ctx.logger.info(
    "Planned keymap: strategy={strategy}, submit={submitChord}, newLine={newLineChord}",
    {
      strategy: plan.strategy,
      submitChord: plan.submitChord,
      newLineChord: plan.newLineChord,
    },
  );
  const handle = await ctx.writeResource("keymapPlan", "keymap-plan", {
    method: "planKeymap",
    timestamp: new Date().toISOString(),
    ...plan,
  });
  return { dataHandles: [handle] };
}

async function applyPiKeybindings(
  args: Record<string, unknown>,
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const a = ApplyPiKeybindingsArgsSchema.parse(args);
  const env = envObject();
  const agentDir = resolvePiAgentDir(a.agentDir, env, Deno.build.os);
  const path = joinPath(agentDir, "keybindings.json");
  const existingText = await readTextIfPresent(path);
  let parsed: unknown = null;
  if (existingText !== null) {
    try {
      parsed = JSON.parse(existingText);
    } catch {
      parsed = null;
    }
  }
  const desired: Record<string, string> = {
    "tui.input.submit": a.submitChord,
    "tui.input.newLine": a.newLineChord,
  };
  if (a.followUpChord) desired["app.message.followUp"] = a.followUpChord;
  const { final, changed } = mergePiKeybindings(parsed, desired);
  const finalContent = JSON.stringify(final, null, 2) + "\n";
  if (changed) {
    await Deno.mkdir(agentDir, { recursive: true });
    await Deno.writeTextFile(path, finalContent);
  }
  const contentHash = await sha256Hex(finalContent);
  ctx.logger.info("pi keybindings {action} at {path}", {
    action: changed ? "written" : "unchanged",
    path,
  });
  const handle = await ctx.writeResource("piKeybindings", "pi-keybindings", {
    method: "applyPiKeybindings",
    timestamp: new Date().toISOString(),
    resolvedAgentDir: agentDir,
    path,
    existed: existingText !== null,
    changed,
    submitChord: a.submitChord,
    newLineChord: a.newLineChord,
    followUpChord: a.followUpChord ?? null,
    finalContent,
    contentHash,
  });
  return { dataHandles: [handle] };
}

async function applyGhosttyConfig(
  args: Record<string, unknown>,
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const a = ApplyGhosttyConfigArgsSchema.parse(args);
  const env = envObject();
  let path = resolveGhosttyConfigPath(a.configPath, env, Deno.build.os);
  let configFileUsed = basename(path);
  if (!a.configPath && !(await exists(path))) {
    const legacy = path.replace(/config\.ghostty$/, "config");
    if (legacy !== path && await exists(legacy)) {
      path = legacy;
      configFileUsed = "config";
    }
  }
  const existing = await readTextIfPresent(path);
  const merged = mergeGhosttyConfig(existing, a.fontFamily, a.keybindLine);
  if (merged.changed) {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, merged.content);
  }
  const contentHash = await sha256Hex(merged.content);
  const ghosttyDetected = await commandAvailable("ghostty");
  ctx.logger.info(
    "Ghostty config {action} at {path} ({removed} conflicting keybind(s) removed)",
    {
      action: merged.changed ? "written" : "unchanged",
      path,
      removed: merged.removedConflictingKeybinds,
    },
  );
  const handle = await ctx.writeResource("ghosttyConfig", "ghostty-config", {
    method: "applyGhosttyConfig",
    timestamp: new Date().toISOString(),
    resolvedPath: path,
    configFileUsed,
    existed: existing !== null,
    changed: merged.changed,
    fontFamilyLine: `font-family = ${a.fontFamily}`,
    keybindLine: a.keybindLine,
    removedConflictingKeybinds: merged.removedConflictingKeybinds,
    ghosttyDetected,
    contentHash,
  });
  return { dataHandles: [handle] };
}

async function applyXdgDefaultTerminal(
  args: Record<string, unknown>,
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const a = ApplyXdgDefaultTerminalArgsSchema.parse(args);
  const env = envObject();
  const platform = detectPlatform(env, Deno.build.os);
  const gnomeDetected = detectGnome(env);
  const configHome = env.XDG_CONFIG_HOME ?? joinPath(env.HOME ?? "", ".config");
  const listPath = joinPath(configHome, "xdg-terminals.list");
  const desired = `${a.desktopId}\n`;

  const gsettings = await run([
    "gsettings",
    "get",
    "org.gnome.desktop.default-applications.terminal",
    "exec",
  ]);
  const gsettingsExec = gsettings !== null && gsettings.code === 0
    ? gsettings.stdout.trim()
    : null;
  const gsettingsWarning = gsettingsExec !== null &&
      unquote(gsettingsExec) !== "xdg-terminal-exec"
    ? `gsettings default terminal is ${gsettingsExec}, not 'xdg-terminal-exec'; xdg-terminal-exec may not be consulted.`
    : null;

  const noop = !(platform === "linux" && gnomeDetected);
  const noopReason = noop
    ? `No-op: platform is "${platform}" (or GNOME not detected); the default terminal is not controlled by xdg-terminal-exec here.`
    : null;

  if (noop) {
    ctx.logger.info("xdg default terminal no-op: {reason}", {
      reason: noopReason,
    });
    const handle = await ctx.writeResource(
      "xdgDefaultTerminal",
      "xdg-default-terminal",
      {
        method: "applyXdgDefaultTerminal",
        timestamp: new Date().toISOString(),
        listPath,
        changed: false,
        desiredDesktopId: a.desktopId,
        desktopEntryFound: false,
        printIdBefore: null,
        printIdAfter: null,
        noop: true,
        noopReason,
        gsettingsWarning,
      },
    );
    return { dataHandles: [handle] };
  }

  const before = await run(["xdg-terminal-exec", "--print-id"]);
  const printIdBefore = before !== null && before.code === 0
    ? before.stdout.trim()
    : null;

  let desktopEntryFound = false;
  for (const dir of desktopEntryDirs(env)) {
    const entryPath = joinPath(dir, "applications", a.desktopId);
    const text = await readTextIfPresent(entryPath);
    if (text !== null && /X-TerminalArg/i.test(text)) {
      desktopEntryFound = true;
      break;
    }
  }

  const existing = await readTextIfPresent(listPath);
  const changed = existing !== desired;
  if (changed) {
    await Deno.mkdir(dirname(listPath), { recursive: true });
    await Deno.writeTextFile(listPath, desired);
  }

  const after = await run(["xdg-terminal-exec", "--print-id"]);
  const printIdAfter = after !== null && after.code === 0
    ? after.stdout.trim()
    : null;

  ctx.logger.info(
    "xdg default terminal {action}: {before} -> {after}",
    {
      action: changed ? "written" : "unchanged",
      before: printIdBefore,
      after: printIdAfter,
    },
  );
  const handle = await ctx.writeResource(
    "xdgDefaultTerminal",
    "xdg-default-terminal",
    {
      method: "applyXdgDefaultTerminal",
      timestamp: new Date().toISOString(),
      listPath,
      changed,
      desiredDesktopId: a.desktopId,
      desktopEntryFound,
      printIdBefore,
      printIdAfter,
      noop: false,
      noopReason: null,
      gsettingsWarning,
    },
  );
  return { dataHandles: [handle] };
}

async function verifyGhosttyConfig(
  args: Record<string, unknown>,
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const a = VerifyGhosttyConfigArgsSchema.parse(args);
  const ghosttyInstalled = await commandAvailable("ghostty");
  let ctrlEnterPresent = false;
  let fontFamilyResolved: string | null = null;
  let fontFamilyMatches: boolean | null = null;
  let configValid = false;
  let rawOutput = "";
  let rawOutputTruncated = false;

  if (ghosttyInstalled) {
    const result = await run(["ghostty", "+show-config"]);
    configValid = result !== null && result.code === 0;
    const lines = (result?.stdout ?? "")
      .split("\n")
      .filter((line) => /font-family|ctrl\+enter/i.test(line));
    const joined = lines.join("\n");
    rawOutputTruncated = joined.length > 20000;
    rawOutput = joined.slice(0, 20000);
    ctrlEnterPresent = lines.some((line) => /ctrl\+enter/i.test(line));
    const fontLine = [...lines].reverse().find((line) =>
      /^\s*font-family\s*=/i.test(line)
    );
    if (fontLine) {
      fontFamilyResolved = fontLine.split("=").slice(1).join("=").trim();
    }
    fontFamilyMatches = a.fontFamily
      ? fontFamilyResolved === a.fontFamily
      : null;
  }

  ctx.logger.info(
    "Verified Ghostty config: installed={installed}, ctrlEnterPresent={present}, fontMatches={matches}",
    {
      installed: ghosttyInstalled,
      present: ctrlEnterPresent,
      matches: fontFamilyMatches,
    },
  );
  const handle = await ctx.writeResource("ghosttyVerify", "ghostty-verify", {
    method: "verifyGhosttyConfig",
    timestamp: new Date().toISOString(),
    ghosttyInstalled,
    ctrlEnterPresent,
    fontFamilyResolved,
    fontFamilyMatches,
    configValid,
    rawOutput,
    rawOutputTruncated,
  });
  return { dataHandles: [handle] };
}

/**
 * Agent-config model: inventory enrolled AI-tool configs and report drift
 * between the enrollment manifest, custom definitions, and on-disk state.
 */
export const model = {
  type: "@maphew/agent-config",
  version: "2026.10.16.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.14.1",
      description:
        "Source moved to maphew/swamp-extensions (AGPL-3.0); no schema, method, or resource changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.3",
      description:
        "Add terminal-keymap-setup methods (probe/plan/apply/verify) and the terminalKeymap resource; no globalArguments change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.16.1",
      description:
        "Surface unreadable /proc ancestry in terminal-probe instead of reporting an empty chain; no globalArguments change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    inventory: {
      description: "Per-tool on-disk state versus enrollment and customisation",
      schema: InventorySchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    drift: {
      description:
        "Drift findings between enrollment, custom definitions, and disk",
      schema: DriftReportSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    terminalProbe: {
      description: "Detected terminal input chain",
      schema: TerminalProbeSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    xdgDefaultTerminalCurrent: {
      description:
        "Current gsettings + xdg-terminal-exec default terminal state",
      schema: XdgDefaultTerminalCurrentSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    keymapPlan: {
      description: "Effective keymap chords and config snippets",
      schema: KeymapPlanSchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
    piKeybindings: {
      description: "pi keybindings.json apply result",
      schema: PiKeybindingsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    ghosttyConfig: {
      description: "Ghostty config apply result",
      schema: GhosttyConfigSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    xdgDefaultTerminal: {
      description: "xdg-terms.list apply result",
      schema: XdgDefaultTerminalSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    ghosttyVerify: {
      description: "Parsed Ghostty config verification",
      schema: GhosttyVerifySchema,
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
  },
  files: {
    report: {
      description: "Markdown agent tool config report",
      contentType: "text/markdown",
      lifetime: "7d" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    inventory: {
      description:
        "Inventory enrolled AI tool configs and write a markdown report",
      arguments: z.object({}),
      execute: inventory,
    },
    checkDrift: {
      description:
        "Report only the drift findings between enrollment, custom definitions, and disk",
      arguments: z.object({}),
      execute: checkDrift,
    },
    probeTerminalChain: {
      description:
        "Probe the terminal input chain: outer terminal, multiplexer, platform and modified-Enter capability",
      arguments: z.object({}),
      execute: probeTerminalChain,
    },
    readDefaultTerminal: {
      description:
        "Read the gsettings indirection and what xdg-terminal-exec would launch today (read-only)",
      arguments: z.object({}),
      execute: readDefaultTerminal,
    },
    planKeymap: {
      description:
        "Turn a probe classification into the effective submit/newline chords and exact config snippets",
      arguments: PlanKeymapArgsSchema,
      execute: planKeymap,
    },
    applyPiKeybindings: {
      description:
        "Idempotently merge the planned bindings into the pi keybindings.json",
      arguments: ApplyPiKeybindingsArgsSchema,
      execute: applyPiKeybindings,
    },
    applyGhosttyConfig: {
      description:
        "Idempotently merge font-family and the ctrl+enter unbind into the Ghostty config",
      arguments: ApplyGhosttyConfigArgsSchema,
      execute: applyGhosttyConfig,
    },
    applyXdgDefaultTerminal: {
      description:
        "Point xdg-terminal-exec at the desired desktop entry on Linux/GNOME; a recorded no-op elsewhere",
      arguments: ApplyXdgDefaultTerminalArgsSchema,
      execute: applyXdgDefaultTerminal,
    },
    verifyGhosttyConfig: {
      description:
        "Run ghostty +show-config and check the ctrl+enter line disappeared and the font resolved",
      arguments: VerifyGhosttyConfigArgsSchema,
      execute: verifyGhosttyConfig,
    },
  },
};
