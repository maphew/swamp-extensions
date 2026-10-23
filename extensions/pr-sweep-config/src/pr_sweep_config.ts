/**
 * PR Sweep configuration model.
 *
 * Stores repository pairs (upstream + fork) with enabled/disabled flags for
 * the PR sweep workflow. Provides a TUI for managing the config.
 *
 * @module
 */

import { z } from "npm:zod@4";

const RepoPairSchema = z.object({
  id: z.string(),
  name: z.string().describe("Display name for this repo pair"),
  upstreamRepo: z.string().describe(
    "Upstream GitHub repo as owner/name (e.g. Kilo-Org/kilocode)",
  ),
  forkRepo: z.string().describe(
    "Fork GitHub repo as owner/name (e.g. maphew/kilocode)",
  ),
  workdir: z.string().describe(
    "Local checkout directory for the upstream repo",
  ),
  enabled: z.boolean().default(true).describe(
    "Whether to include this pair in sweeps",
  ),
  agent: z.enum(["claude", "codex", "opencode", "kilo"]).default("kilo")
    .describe("Headless agent to run the sweep"),
  model: z.string().default("").describe(
    "Model for the agent in provider/model form; empty uses the agent's default",
  ),
  mainBranch: z.string().default("main").describe(
    "Base branch to rebase and merge into",
  ),
  swampRepoDir: z.string().default(".").describe(
    "Path to the swamp repo that owns this workflow; defaults to the repo swamp runs from",
  ),
});

const ConfigSchema = z.object({
  repoPairs: z.array(RepoPairSchema).default([]),
});

type RepoPair = z.infer<typeof RepoPairSchema>;
type Config = z.infer<typeof ConfigSchema>;

type ModelContext = {
  globalArgs: Record<string, never>;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  createFileWriter: (
    spec: string,
    instance: string,
  ) => { writeText: (text: string) => Promise<{ name: string }> };
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
};

const CONFIG_FILE = ".swamp/pr-sweep-config.json";

async function readConfigFile(_ctx: ModelContext): Promise<Config> {
  let text: string;
  try {
    text = new TextDecoder().decode(await Deno.readFile(CONFIG_FILE));
  } catch {
    // File does not exist yet — start from an empty config.
    return { repoPairs: [] };
  }
  // A present-but-malformed file must fail loudly rather than be treated as
  // empty, which the next write would then overwrite.
  return ConfigSchema.parse(JSON.parse(text));
}

async function writeConfigFile(config: Config): Promise<void> {
  const encoder = new TextEncoder();
  await Deno.writeFile(
    CONFIG_FILE,
    encoder.encode(JSON.stringify(config, null, 2)),
  );
}

/**
 * Derive a stable, URL-safe id from a display name (lowercase, non-alphanumeric
 * runs collapsed to `-`, leading/trailing dashes trimmed).
 */
export function deriveId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/** Render a config as a markdown table, or a no-config notice. */
export function renderConfigSummary(config: Config): string {
  const lines: string[] = [];
  lines.push("# PR Sweep Configuration");
  lines.push("");
  if (config.repoPairs.length === 0) {
    lines.push("No repository pairs configured.");
    return lines.join("\n");
  }
  lines.push("| Enabled | Name | Upstream | Fork | Workdir | Agent | Model |");
  lines.push("|---------|------|----------|------|---------|-------|-------|");
  for (const pair of config.repoPairs) {
    lines.push(
      `| ${
        pair.enabled ? "✓" : "✗"
      } | ${pair.name} | ${pair.upstreamRepo} | ${pair.forkRepo} | ${pair.workdir} | ${pair.agent} | ${
        pair.model || "(default)"
      } |`,
    );
  }
  return lines.join("\n");
}

async function discoverConfig(
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const config = await readConfigFile(ctx);
  ctx.logger.info("Loaded PR sweep config: {n} repo pair(s)", {
    n: config.repoPairs.length,
  });
  const summary = renderConfigSummary(config);
  const handles = [
    await ctx.writeResource("config", "config-current", config),
    await ctx.createFileWriter("summary", "summary-current").writeText(summary),
  ];
  return { dataHandles: handles };
}

async function addRepoPair(
  _args: {
    name: string;
    upstreamRepo: string;
    forkRepo: string;
    workdir: string;
    agent?: string;
    model?: string;
    mainBranch?: string;
    swampRepoDir?: string;
    enabled?: boolean;
  },
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const config = await readConfigFile(ctx);
  const id = deriveId(_args.name);
  const newPair: RepoPair = {
    id,
    name: _args.name,
    upstreamRepo: _args.upstreamRepo,
    forkRepo: _args.forkRepo,
    workdir: _args.workdir,
    enabled: _args.enabled ?? true,
    agent: _args.agent as RepoPair["agent"] ?? "kilo",
    model: _args.model ?? "",
    mainBranch: _args.mainBranch ?? "main",
    swampRepoDir: _args.swampRepoDir ?? ".",
  };
  config.repoPairs.push(newPair);
  await writeConfigFile(config);
  ctx.logger.info("Added PR sweep pair {id}", { id });
  return discoverConfig(ctx);
}

async function removeRepoPair(
  _args: { id: string },
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const config = await readConfigFile(ctx);
  config.repoPairs = config.repoPairs.filter((p) => p.id !== _args.id);
  await writeConfigFile(config);
  return discoverConfig(ctx);
}

async function toggleRepoPair(
  _args: { id: string },
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const config = await readConfigFile(ctx);
  const pair = config.repoPairs.find((p) => p.id === _args.id);
  if (pair) {
    pair.enabled = !pair.enabled;
    await writeConfigFile(config);
  }
  return discoverConfig(ctx);
}

async function updateRepoPair(
  _args: {
    id: string;
    name?: string;
    upstreamRepo?: string;
    forkRepo?: string;
    workdir?: string;
    agent?: string;
    model?: string;
    mainBranch?: string;
    swampRepoDir?: string;
  },
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const config = await readConfigFile(ctx);
  const pair = config.repoPairs.find((p) => p.id === _args.id);
  if (pair) {
    if (_args.name) pair.name = _args.name;
    if (_args.upstreamRepo) pair.upstreamRepo = _args.upstreamRepo;
    if (_args.forkRepo) pair.forkRepo = _args.forkRepo;
    if (_args.workdir) pair.workdir = _args.workdir;
    if (_args.agent) pair.agent = _args.agent as RepoPair["agent"];
    if (_args.model !== undefined) pair.model = _args.model;
    if (_args.mainBranch) pair.mainBranch = _args.mainBranch;
    if (_args.swampRepoDir) pair.swampRepoDir = _args.swampRepoDir;
    await writeConfigFile(config);
  }
  return discoverConfig(ctx);
}

/**
 * PR Sweep configuration model: a checkbox list of repository pairs
 * (upstream + fork) for the PR sweep workflow, with a TUI and file-backed
 * store at .swamp/pr-sweep-config.json.
 */
export const model = {
  type: "@maphew/pr-sweep-config",
  version: "2026.10.23.1",
  globalArguments: z.object({}),
  upgrades: [
    {
      toVersion: "2026.10.14.1",
      description:
        "Source moved to maphew/swamp-extensions (AGPL-3.0); no schema or method changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.23.1",
      description:
        "Add an optional per-pair `model` (provider/model) surfaced by addRepoPair/updateRepoPair and the summary table; empty keeps the agent's default",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    config: {
      description: "PR sweep repository pair configuration",
      schema: ConfigSchema,
      lifetime: "365d" as const,
      garbageCollection: 10,
    },
  },
  files: {
    summary: {
      description: "Markdown summary of the PR sweep configuration",
      contentType: "text/markdown",
      lifetime: "365d" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    discover: {
      description: "Load the current PR sweep configuration",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: ModelContext) =>
        await discoverConfig(ctx),
    },
    addRepoPair: {
      description: "Add a new repository pair to the sweep configuration",
      arguments: z.object({
        name: z.string().describe("Display name for this repo pair"),
        upstreamRepo: z.string().describe("Upstream GitHub repo as owner/name"),
        forkRepo: z.string().describe("Fork GitHub repo as owner/name"),
        workdir: z.string().describe(
          "Local checkout directory for the upstream repo",
        ),
        agent: z.enum(["claude", "codex", "opencode", "kilo"]).default("kilo")
          .optional().describe("Headless agent"),
        model: z.string().optional().describe(
          "Model in provider/model form; empty uses the agent's default",
        ),
        mainBranch: z.string().default("main").optional().describe(
          "Base branch",
        ),
        swampRepoDir: z.string().default(".").optional().describe(
          "Swamp repo path; defaults to the repo swamp runs from",
        ),
        enabled: z.boolean().default(true).optional().describe(
          "Whether to include in sweeps",
        ),
      }),
      execute: addRepoPair,
    },
    removeRepoPair: {
      description: "Remove a repository pair from the sweep configuration",
      arguments: z.object({
        id: z.string().describe("ID of the repo pair to remove"),
      }),
      execute: removeRepoPair,
    },
    toggleRepoPair: {
      description: "Toggle enabled/disabled state of a repository pair",
      arguments: z.object({
        id: z.string().describe("ID of the repo pair to toggle"),
      }),
      execute: toggleRepoPair,
    },
    updateRepoPair: {
      description: "Update a repository pair's settings",
      arguments: z.object({
        id: z.string().describe("ID of the repo pair to update"),
        name: z.string().optional(),
        upstreamRepo: z.string().optional(),
        forkRepo: z.string().optional(),
        workdir: z.string().optional(),
        agent: z.enum(["claude", "codex", "opencode", "kilo"]).optional(),
        model: z.string().optional().describe(
          "Model in provider/model form; empty uses the agent's default",
        ),
        mainBranch: z.string().optional(),
        swampRepoDir: z.string().optional(),
      }),
      execute: updateRepoPair,
    },
  },
};
