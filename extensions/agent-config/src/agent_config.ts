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

/**
 * Agent-config model: inventory enrolled AI-tool configs and report drift
 * between the enrollment manifest, custom definitions, and on-disk state.
 */
export const model = {
  type: "@maphew/agent-config",
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
  },
};
