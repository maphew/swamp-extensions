/**
 * BD (beads) issue tracking model.
 *
 * Wraps the `bd` CLI for task and issue tracking within a project.
 * Requires `bd` to be installed and a `.beads/` database to exist
 * in the project directory (or one discoverable from it).
 *
 * Methods:
 *   - `list`   list issues (with optional filters)
 *   - `show`   show details for one issue by ID
 *   - `ready`  list issues ready to work (no active blockers)
 *   - `create` create a new issue
 *   - `update` edit fields, claim, or relabel an issue
 *   - `close`  close an issue by ID (preserves the issue's real fields)
 *
 * Failures throw with the bd exit code, stderr, and stdout so failed
 * method runs are diagnosable from reports and workflow logs.
 *
 * @module
 */

import { z } from "npm:zod@4";

// ---------- schemas ---------------------------------------------------------

/** Schema for a normalized beads issue resource. */
const IssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  priority: z.number().int().min(0).max(4),
  issueType: z.string(),
  owner: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  updatedAt: z.string(),
  dependencyCount: z.number().int().default(0),
  dependentCount: z.number().int().default(0),
  commentCount: z.number().int().default(0),
  truncated: z.boolean().default(false),
});

/** Arguments for the `create` method. */
const CreateArgsSchema = z.object({
  title: z.string().describe("Issue title"),
  description: z.string().optional().describe("Issue description"),
  type: z.string().default("task").describe(
    "Issue type (bug|feature|task|epic|chore|decision)",
  ),
  priority: z.number().int().min(0).max(4).default(2).describe(
    "Priority (0-4, 0=highest)",
  ),
  labels: z.array(z.string()).optional().describe("Labels"),
  assignee: z.string().optional().describe("Assignee"),
  due: z.string().optional().describe("Due date"),
  externalRef: z.string().optional().describe("External reference"),
  parentId: z.string().optional().describe("Parent issue ID"),
});

/** Arguments for the `list` method. */
const ListArgsSchema = z.object({
  status: z.string().optional().describe("Filter by status"),
  type: z.string().optional().describe("Filter by type"),
  assignee: z.string().optional().describe("Filter by assignee"),
  limit: z.number().int().min(1).max(500).default(50).describe(
    "Maximum issues to return",
  ),
});

/** Arguments for the `show` method. */
const ShowArgsSchema = z.object({
  id: z.string().describe("Issue ID (e.g., bd-mhw-1)"),
});

/** Arguments for the `ready` method. */
const ReadyArgsSchema = z.object({
  assignee: z.string().optional().describe(
    "Filter to issues assigned to this actor",
  ),
  limit: z.number().int().min(1).max(500).default(50).describe(
    "Maximum issues to return",
  ),
});

/** Arguments for the `update` method. Requires at least one field change or `claim: true`. */
const UpdateArgsSchema = z.object({
  id: z.string().describe("Issue ID (e.g., bd-mhw-1)"),
  title: z.string().optional().describe("New title"),
  description: z.string().optional().describe("New description"),
  status: z.string().optional().describe(
    "New status (open|in_progress|blocked|closed|deferred)",
  ),
  priority: z.number().int().min(0).max(4).optional().describe(
    "New priority (0-4, 0=highest)",
  ),
  assignee: z.string().optional().describe("New assignee"),
  claim: z.boolean().optional().describe(
    "Atomically claim the issue (sets assignee to you, status to in_progress)",
  ),
  addLabels: z.array(z.string()).optional().describe("Labels to add"),
  removeLabels: z.array(z.string()).optional().describe("Labels to remove"),
}).refine(
  (args) =>
    args.claim === true || args.title !== undefined ||
    args.description !== undefined || args.status !== undefined ||
    args.priority !== undefined || args.assignee !== undefined ||
    (args.addLabels?.length ?? 0) > 0 || (args.removeLabels?.length ?? 0) > 0,
  { message: "Provide at least one field to update, or claim: true" },
);

/** Arguments for the `close` method. */
const CloseArgsSchema = z.object({
  id: z.string().describe("Issue ID (e.g., bd-mhw-1)"),
  reason: z.string().optional().describe("Closure reason"),
});

/** Global arguments configuring how the bd CLI is invoked. */
const GlobalArgsSchema = z.object({
  bdCommand: z.string().default("bd").describe(
    "Path to the beads CLI",
  ),
  bdDir: z.string().default(".").describe(
    "Project directory containing a .beads/ database (bd auto-discovers from here)",
  ),
  defaultPriority: z.number().int().min(0).max(4).default(2).describe(
    "Default priority for new issues",
  ),
  defaultType: z.string().default("task").describe(
    "Default type for new issues",
  ),
});

/** Validated global arguments. */
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
/** A normalized beads issue. */
type Issue = z.infer<typeof IssueSchema>;
/** Validated `create` arguments. */
type CreateArgs = z.infer<typeof CreateArgsSchema>;
/** Validated `list` arguments. */
type ListArgs = z.infer<typeof ListArgsSchema>;
/** Validated `close` arguments. */
type CloseArgs = z.infer<typeof CloseArgsSchema>;
/** Validated `update` arguments. */
type UpdateArgs = z.infer<typeof UpdateArgsSchema>;

// ---------- helpers ---------------------------------------------------------

interface BdResult {
  stdout: string;
  stderr: string;
  code: number;
  success: boolean;
}

async function runBd(
  command: string,
  args: string[],
  cwd: string,
): Promise<BdResult> {
  const proc = new Deno.Command(command, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await proc.output();
  return {
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
    code: out.code,
    success: out.success,
  };
}

/** Throw a diagnostic error for a failed bd invocation. */
function bdError(method: string, result: BdResult): Error {
  const detail = [result.stderr.trim(), result.stdout.trim()]
    .filter(Boolean)
    .join("\n") || "bd produced no output";
  return new Error(`bd ${method} failed (exit ${result.code}): ${detail}`);
}

/** Run a bd command, throwing a structured error when it exits nonzero. */
async function runBdStrict(
  method: string,
  command: string,
  args: string[],
  cwd: string,
  logger?: { error: (msg: string, props?: Record<string, unknown>) => void },
): Promise<{ stdout: string; stderr: string }> {
  const result = await runBd(command, args, cwd);
  if (!result.success) {
    logger?.error("bd {method} failed (exit {code}): {detail}", {
      method,
      code: result.code,
      detail: (result.stderr.trim() || result.stdout.trim()).slice(0, 2000),
    });
    throw bdError(method, result);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

/** Normalize a raw bd JSON record into the issue resource shape. */
function normalizeIssue(
  raw: Record<string, unknown>,
  cfg: GlobalArgs,
  fallbacks: { status: string; issueType: string },
): Issue {
  return {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? ""),
    description: (raw.description as string | null) ?? null,
    status: String(raw.status ?? fallbacks.status),
    priority: Number(raw.priority ?? cfg.defaultPriority),
    issueType: String(raw.issue_type ?? fallbacks.issueType),
    owner: (raw.owner as string | null) ?? null,
    createdAt: String(raw.created_at ?? new Date().toISOString()),
    createdBy: (raw.created_by as string | null) ?? null,
    updatedAt: String(raw.updated_at ?? new Date().toISOString()),
    dependencyCount: Number(raw.dependency_count ?? 0),
    dependentCount: Number(raw.dependent_count ?? 0),
    commentCount: Number(raw.comment_count ?? 0),
    truncated: false,
  };
}

/** Fetch one issue via `bd show` and return its normalized shape. */
async function fetchIssue(
  cfg: GlobalArgs,
  id: string,
  ctx: {
    logger: { error: (msg: string, props?: Record<string, unknown>) => void };
  },
): Promise<Issue> {
  const { stdout } = await runBdStrict(
    "show",
    cfg.bdCommand,
    ["show", id, "--json"],
    cfg.bdDir,
    ctx.logger,
  );
  const parsed = JSON.parse(stdout) as
    | Record<string, unknown>
    | Record<string, unknown>[];
  // bd show --json wraps the issue in a single-element array
  const raw = Array.isArray(parsed) ? parsed[0] ?? {} : parsed;
  return normalizeIssue(raw, cfg, {
    status: "open",
    issueType: cfg.defaultType,
  });
}

interface MethodCtx {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
}

// ---------- methods ---------------------------------------------------------

async function listIssues(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = ListArgsSchema.parse(args);

  // bd caps at 50 server-side by default, so probe one past the caller's limit:
  // that makes `truncated` accurate instead of silently under-reporting.
  const bdArgs = ["list", "--json", "--limit", String(parsed.limit + 1)];
  if (parsed.status) bdArgs.push("--status", parsed.status);
  if (parsed.type) bdArgs.push("--type", parsed.type);
  if (parsed.assignee) bdArgs.push("--assignee", parsed.assignee);

  const { stdout } = await runBdStrict(
    "list",
    cfg.bdCommand,
    bdArgs,
    cfg.bdDir,
    ctx.logger,
  );

  const all = (JSON.parse(stdout) as Record<string, unknown>[])
    .map((raw) =>
      normalizeIssue(raw, cfg, { status: "open", issueType: cfg.defaultType })
    );
  const issues = all.slice(0, parsed.limit);
  const truncated = all.length > issues.length;
  for (const issue of issues) issue.truncated = truncated;

  const handles: Array<{ name: string }> = [];
  for (const issue of issues) {
    handles.push(
      await ctx.writeResource("issue", `issue-${issue.id}`, issue),
    );
  }

  ctx.logger.info(
    "Listed {count} bd issues (limit {limit}{truncated})",
    {
      count: issues.length,
      limit: parsed.limit,
      truncated: truncated ? ", truncated" : "",
    },
  );
  return { dataHandles: handles };
}

async function readyIssues(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = ReadyArgsSchema.parse(args);

  // Probe one past the caller's limit so `truncated` reflects bd's real cap.
  const bdArgs = ["ready", "--json", "--limit", String(parsed.limit + 1)];
  if (parsed.assignee) bdArgs.push("--assignee", parsed.assignee);

  const { stdout } = await runBdStrict(
    "ready",
    cfg.bdCommand,
    bdArgs,
    cfg.bdDir,
    ctx.logger,
  );

  const all = (JSON.parse(stdout) as Record<string, unknown>[])
    .map((raw) =>
      normalizeIssue(raw, cfg, { status: "open", issueType: cfg.defaultType })
    );
  const issues = all.slice(0, parsed.limit);
  const truncated = all.length > issues.length;
  for (const issue of issues) issue.truncated = truncated;

  const handles: Array<{ name: string }> = [];
  for (const issue of issues) {
    handles.push(
      await ctx.writeResource("issue", `issue-${issue.id}`, issue),
    );
  }

  ctx.logger.info(
    "Found {count} ready bd issues (limit {limit}{truncated})",
    {
      count: issues.length,
      limit: parsed.limit,
      truncated: truncated ? ", truncated" : "",
    },
  );
  return { dataHandles: handles };
}

async function showIssue(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = ShowArgsSchema.parse(args);

  const issue = await fetchIssue(cfg, parsed.id, ctx);

  const handle = await ctx.writeResource("issue", `issue-${issue.id}`, issue);
  ctx.logger.info("Show bd issue {id}", { id: issue.id });
  return { dataHandles: [handle] };
}

async function createIssue(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = CreateArgsSchema.parse(args);

  const bdArgs = [
    "create",
    parsed.title,
    "-t",
    parsed.type,
    "-p",
    String(parsed.priority ?? cfg.defaultPriority),
    "--json",
  ];
  if (parsed.description) bdArgs.push("-d", parsed.description);
  if (parsed.labels && parsed.labels.length > 0) {
    bdArgs.push("-l", parsed.labels.join(","));
  }
  if (parsed.assignee) bdArgs.push("-a", parsed.assignee);
  if (parsed.due) bdArgs.push("--due", parsed.due);
  if (parsed.externalRef) bdArgs.push("--external-ref", parsed.externalRef);
  if (parsed.parentId) bdArgs.push("--parent", parsed.parentId);

  const { stdout } = await runBdStrict(
    "create",
    cfg.bdCommand,
    bdArgs,
    cfg.bdDir,
    ctx.logger,
  );

  const raw = JSON.parse(stdout) as Record<string, unknown>;
  const issue = normalizeIssue(raw, cfg, {
    status: "open",
    issueType: parsed.type,
  });

  const handle = await ctx.writeResource("issue", `issue-${issue.id}`, issue);
  ctx.logger.info("Created bd issue {id}", { id: issue.id });
  return { dataHandles: [handle] };
}

async function updateIssue(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = UpdateArgsSchema.parse(args);

  const bdArgs = ["update", parsed.id];
  if (parsed.claim) bdArgs.push("--claim");
  if (parsed.title !== undefined) bdArgs.push("--title", parsed.title);
  if (parsed.description !== undefined) bdArgs.push("-d", parsed.description);
  if (parsed.status !== undefined) bdArgs.push("-s", parsed.status);
  if (parsed.priority !== undefined) bdArgs.push("-p", String(parsed.priority));
  if (parsed.assignee !== undefined) bdArgs.push("-a", parsed.assignee);
  if (parsed.addLabels && parsed.addLabels.length > 0) {
    bdArgs.push("--add-label", parsed.addLabels.join(","));
  }
  if (parsed.removeLabels && parsed.removeLabels.length > 0) {
    bdArgs.push("--remove-label", parsed.removeLabels.join(","));
  }

  await runBdStrict("update", cfg.bdCommand, bdArgs, cfg.bdDir, ctx.logger);

  const issue = await fetchIssue(cfg, parsed.id, ctx);
  const handle = await ctx.writeResource("issue", `issue-${issue.id}`, issue);
  ctx.logger.info("Updated bd issue {id}", { id: issue.id });
  return { dataHandles: [handle] };
}

async function closeIssue(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = CloseArgsSchema.parse(args);

  const existing = await fetchIssue(cfg, parsed.id, ctx);

  const bdArgs = ["close", parsed.id];
  if (parsed.reason) bdArgs.push("--reason", parsed.reason);

  await runBdStrict("close", cfg.bdCommand, bdArgs, cfg.bdDir, ctx.logger);

  const handle = await ctx.writeResource("issue", `issue-${parsed.id}`, {
    ...existing,
    status: "closed",
    updatedAt: new Date().toISOString(),
  });

  ctx.logger.info("Closed bd issue {id}", { id: parsed.id });
  return { dataHandles: [handle] };
}

/** Swamp model definition for the beads issue tracker bridge. */
export const model = {
  type: "@maphew/bd",
  version: "2026.10.02.3",
  globalArguments: GlobalArgsSchema,
  checks: {
    "bd-usable": {
      description:
        "Verify the bd CLI resolves and runs before mutating methods",
      labels: ["dependency"],
      execute: async (
        context: {
          globalArgs: unknown;
        },
      ) => {
        const cfg = GlobalArgsSchema.parse(context.globalArgs);
        const result = await runBd(cfg.bdCommand, ["--version"], cfg.bdDir);
        if (!result.success) {
          return {
            pass: false,
            errors: [
              `\`${cfg.bdCommand}\` is not runnable from ${cfg.bdDir} (exit ${result.code}). Install bd or set the bdCommand global arg. ${result.stderr.trim()}`,
            ],
          };
        }
        return { pass: true };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.09.29.3",
      description:
        "Add ready/update methods and structured error diagnostics; no global argument schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.02.3",
      description:
        "Source moved to maphew/swamp-extensions (AGPL-3.0); no schema or method changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    issue: {
      description: "A BD (beads) issue/task",
      schema: IssueSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description: "List BD issues with optional filters",
      arguments: ListArgsSchema,
      execute: (
        args: Record<string, unknown>,
        ctx: Parameters<typeof listIssues>[1],
      ) => listIssues(args, ctx),
    },
    ready: {
      description: "List BD issues ready to work (no active blockers)",
      arguments: ReadyArgsSchema,
      execute: (
        args: Record<string, unknown>,
        ctx: Parameters<typeof readyIssues>[1],
      ) => readyIssues(args, ctx),
    },
    show: {
      description: "Show details for a BD issue by ID",
      arguments: ShowArgsSchema,
      execute: async (
        args: Record<string, unknown>,
        ctx: Parameters<typeof showIssue>[1],
      ) => await showIssue(args, ctx),
    },
    create: {
      description: "Create a new BD issue",
      arguments: CreateArgsSchema,
      execute: async (
        args: Record<string, unknown>,
        ctx: Parameters<typeof createIssue>[1],
      ) => await createIssue(args, ctx),
    },
    update: {
      description:
        "Update a BD issue (fields, labels, or atomic claim via claim: true)",
      arguments: UpdateArgsSchema,
      execute: async (
        args: Record<string, unknown>,
        ctx: Parameters<typeof updateIssue>[1],
      ) => await updateIssue(args, ctx),
    },
    close: {
      description: "Close a BD issue by ID, preserving its real fields",
      arguments: CloseArgsSchema,
      execute: async (
        args: Record<string, unknown>,
        ctx: Parameters<typeof closeIssue>[1],
      ) => await closeIssue(args, ctx),
    },
  },
};
