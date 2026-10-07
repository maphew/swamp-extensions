/**
 * BD (beads) issue tracking model.
 *
 * Wraps the `bd` CLI for task and issue tracking within a project.
 * Requires `bd` to be installed and a `.beads/` database to exist
 * in the project directory (or one discoverable from it).
 *
 * Methods:
 *   - `list`   list issues (with optional filters)
 *   - `query`  filter issues with bd's query language (e.g. "status=open AND type=bug")
 *   - `show`   show details for one issue by ID
 *   - `ready`  list issues ready to work (no active blockers)
 *   - `create` create a new issue
 *   - `update` edit fields, claim, or relabel an issue
 *   - `close`  close an issue by ID (preserves the issue's real fields)
 *   - `reopen` reopen one or more closed issues, optionally with a reason
 *   - `dep`    manage dependencies: add, remove, or list them
 *   - `reclaim` revert stale in_progress issues back to open (dead-worker recovery)
 *   - `graph`  return the dependency graph as structured nodes, typed edges,
 *              and layers (ready for rendering as a Mermaid graph)
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

/** Sort fields accepted by `bd query --sort`. */
const QuerySortFields = [
  "priority",
  "created",
  "updated",
  "closed",
  "status",
  "id",
  "title",
  "type",
  "assignee",
] as const;

/** Arguments for the `query` method. */
const QueryArgsSchema = z.object({
  q: z.string().min(1).describe(
    'bd query language expression, e.g. "status=open AND type=bug" or "priority<=1 AND label=swarm". Comparisons use =, !=, <, <=, >, >= with AND/OR/NOT and parentheses; bd\'s colon syntax (status:open) is not supported',
  ),
  limit: z.number().int().min(1).max(500).default(50).describe(
    "Maximum issues to return",
  ),
  includeClosed: z.boolean().default(false).describe(
    "Include closed issues (bd excludes them by default; needed for status=closed queries)",
  ),
  sort: z.enum(QuerySortFields).optional().describe(
    "Sort by field (bd's default order otherwise)",
  ),
  reverse: z.boolean().default(false).describe(
    "Reverse sort order (has no effect unless sort is set)",
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

/** Arguments for the `dep` method. */
const DepArgsSchema = z.object({
  action: z.enum(["add", "remove", "list"]).default("list").describe(
    "Dependency action: add makes issueId depend on dependsOnId, remove unlinks them, list returns the dependency issues",
  ),
  issueId: z.string().describe(
    "Issue ID (e.g., bd-mhw-1); for add/remove the side that depends on dependsOnId",
  ),
  dependsOnId: z.string().optional().describe(
    "The issue that issueId depends on (required for add/remove)",
  ),
  direction: z.enum(["down", "up"]).default("down").describe(
    "List direction: down = what issueId depends on, up = what depends on issueId (list only)",
  ),
}).refine(
  (args) => args.action === "list" || args.dependsOnId !== undefined,
  { message: "dependsOnId is required for add/remove" },
);

/** Arguments for the `reopen` method. */
const ReopenArgsSchema = z.object({
  ids: z.array(z.string()).min(1).describe("Issue IDs to reopen"),
  reason: z.string().optional().describe("Reason for reopening"),
});

/** Arguments for the `reclaim` method. */
const ReclaimArgsSchema = z.object({
  ids: z.array(z.string()).optional().describe(
    "Only reclaim these issue IDs",
  ),
  maxAge: z.string().optional().describe(
    "Grace window past lease expiry, e.g. 10m or 1h; defaults to bd's own (10m)",
  ),
});

/** Schema for a dependency-graph node. */
const GraphNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
});

/** Schema for a typed dependency edge: `from` depends on `to` via `type`. */
const GraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: z.string(),
});

/** Schema for the dependency graph resource. */
const DependencyGraphSchema = z.object({
  rootId: z.string().nullable().describe(
    "Issue the graph was anchored at, or null when all open issues were graphed",
  ),
  nodes: z.array(GraphNodeSchema).describe("Issues participating in the graph"),
  edges: z.array(GraphEdgeSchema).describe("Typed edges: from depends on to"),
  layers: z.array(z.array(z.string())).nullable().describe(
    "Dependency layers in execution order (layer 0 = can start immediately); null when the graph has no layering",
  ),
});

/** Arguments for the `graph` method. */
const GraphArgsSchema = z.object({
  rootId: z.string().optional().describe(
    "Anchor the graph at this issue; omit to graph all open issues",
  ),
  direction: z.enum(["downstream", "upstream", "both"]).default(
    "downstream",
  ).describe(
    "downstream = what the root depends on, upstream = what depends on the root (requires rootId), both = the union",
  ),
  depth: z.number().int().min(-1).default(-1).describe(
    "Maximum hops from rootId to include (-1 = unlimited; ignored when rootId is omitted)",
  ),
}).refine(
  (args) => args.direction === "downstream" || args.rootId !== undefined,
  { message: "direction upstream/both requires rootId" },
);

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
/** Validated `query` arguments. */
type QueryArgs = z.infer<typeof QueryArgsSchema>;
/** Validated `close` arguments. */
type CloseArgs = z.infer<typeof CloseArgsSchema>;
/** Validated `update` arguments. */
type UpdateArgs = z.infer<typeof UpdateArgsSchema>;
/** Validated `dep` arguments. */
type DepArgs = z.infer<typeof DepArgsSchema>;
/** Validated `reopen` arguments. */
type ReopenArgs = z.infer<typeof ReopenArgsSchema>;
/** Validated `reclaim` arguments. */
type ReclaimArgs = z.infer<typeof ReclaimArgsSchema>;
/** Validated `graph` arguments. */
type GraphArgs = z.infer<typeof GraphArgsSchema>;

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

/**
 * Run `bd dep list <id> --json` and return the dependency records. Each
 * record is a full issue plus a `dependency_type` naming the edge relation
 * (e.g. "blocks"), attributed to the side that was queried: for direction
 * "down" the records are what `id` depends on, for "up" they are the issues
 * that depend on `id`.
 */
async function fetchDepRecords(
  cfg: GlobalArgs,
  id: string,
  direction: "down" | "up",
  ctx: {
    logger: { error: (msg: string, props?: Record<string, unknown>) => void };
  },
): Promise<Record<string, unknown>[]> {
  const { stdout } = await runBdStrict(
    `dep list ${direction}`,
    cfg.bdCommand,
    ["dep", "list", id, "--json", "--direction", direction],
    cfg.bdDir,
    ctx.logger,
  );
  const parsed = JSON.parse(stdout) as unknown;
  return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : [];
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

async function queryIssues(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = QueryArgsSchema.parse(args);

  // Probe one past the caller's limit so `truncated` reflects bd's real cap.
  const bdArgs = [
    "query",
    parsed.q,
    "--json",
    "--limit",
    String(parsed.limit + 1),
  ];
  if (parsed.includeClosed) bdArgs.push("--all");
  if (parsed.sort) bdArgs.push("--sort", parsed.sort);
  if (parsed.reverse) bdArgs.push("--reverse");

  const { stdout } = await runBdStrict(
    "query",
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
    "Queried {count} bd issues (limit {limit}{truncated})",
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

async function depManage(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = DepArgsSchema.parse(args);

  if (parsed.action === "list") {
    const { stdout } = await runBdStrict(
      "dep list",
      cfg.bdCommand,
      [
        "dep",
        "list",
        parsed.issueId,
        "--json",
        "--direction",
        parsed.direction,
      ],
      cfg.bdDir,
      ctx.logger,
    );
    const records = JSON.parse(stdout) as Record<string, unknown>[];
    const handles: Array<{ name: string }> = [];
    const seen = new Set<string>();
    for (const raw of records) {
      const id = String(raw.id ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      handles.push(
        await ctx.writeResource(
          "issue",
          `issue-${id}`,
          normalizeIssue(raw, cfg, {
            status: "open",
            issueType: cfg.defaultType,
          }),
        ),
      );
    }
    ctx.logger.info(
      "Listed {count} dependencies ({direction}) of bd issue {id}",
      {
        count: handles.length,
        direction: parsed.direction,
        id: parsed.issueId,
      },
    );
    return { dataHandles: handles };
  }

  await runBdStrict(
    `dep ${parsed.action}`,
    cfg.bdCommand,
    [
      "dep",
      parsed.action,
      parsed.issueId,
      parsed.dependsOnId as string,
      "--json",
    ],
    cfg.bdDir,
    ctx.logger,
  );
  const issue = await fetchIssue(cfg, parsed.issueId, ctx);
  const dependsOn = await fetchIssue(cfg, parsed.dependsOnId as string, ctx);
  const handles = [
    await ctx.writeResource("issue", `issue-${issue.id}`, issue),
    await ctx.writeResource("issue", `issue-${dependsOn.id}`, dependsOn),
  ];
  ctx.logger.info(
    "{action} dependency: {issueId} on {dependsOnId}",
    {
      action: parsed.action,
      issueId: parsed.issueId,
      dependsOnId: parsed.dependsOnId,
    },
  );
  return { dataHandles: handles };
}

async function reopenIssues(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = ReopenArgsSchema.parse(args);

  // bd prints plain text (not JSON) for issues that are already open but
  // still exits 0, so results are read back via `bd show` rather than parsed.
  const bdArgs = ["reopen", ...parsed.ids, "--json"];
  if (parsed.reason) bdArgs.push("--reason", parsed.reason);

  await runBdStrict("reopen", cfg.bdCommand, bdArgs, cfg.bdDir, ctx.logger);

  const handles: Array<{ name: string }> = [];
  for (const id of parsed.ids) {
    const issue = await fetchIssue(cfg, id, ctx);
    handles.push(await ctx.writeResource("issue", `issue-${issue.id}`, issue));
  }

  ctx.logger.info("Reopened {count} bd issues", { count: handles.length });
  return { dataHandles: handles };
}

async function reclaimIssues(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = ReclaimArgsSchema.parse(args);

  const bdArgs = ["reclaim", "--json"];
  if (parsed.maxAge) bdArgs.push("--older-than", parsed.maxAge);
  for (const id of parsed.ids ?? []) bdArgs.push("--id", id);

  const { stdout } = await runBdStrict(
    "reclaim",
    cfg.bdCommand,
    bdArgs,
    cfg.bdDir,
    ctx.logger,
  );

  let reclaimed: string[] = [];
  try {
    const data = JSON.parse(stdout) as {
      reclaimed?: Array<{ id?: unknown }>;
    };
    reclaimed = (Array.isArray(data?.reclaimed) ? data.reclaimed : [])
      .map((entry) => String(entry.id ?? ""))
      .filter((id) => id !== "");
  } catch {
    // nothing stale was reclaimable; treat as empty
  }

  const handles: Array<{ name: string }> = [];
  for (const id of reclaimed) {
    try {
      const issue = await fetchIssue(cfg, id, ctx);
      handles.push(
        await ctx.writeResource("issue", `issue-${issue.id}`, issue),
      );
    } catch {
      // the reclaimed issue vanished since reclaim ran; skip it
    }
  }

  ctx.logger.info("Reclaimed {count} stale bd leases", {
    count: reclaimed.length,
  });
  return { dataHandles: handles };
}

async function showGraph(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = GraphArgsSchema.parse(args);

  // `bd graph <id> --json` returns {issues, layout} covering the root's whole
  // connected component, but its `DependsOn` adjacency only surfaces `blocks`
  // edges and its node set ignores direction, so typed edges and node
  // closure are rebuilt from per-node `bd dep list` records. The all-open
  // shape (`--all --json`) is an array of issues grouped into connected
  // components, each carrying `Issues` and a full typed `Dependencies` edge
  // list; when every component provides one it is used directly and no
  // per-node listing runs.
  const bdArgs = ["graph", "--json"];
  if (parsed.rootId) bdArgs.push(parsed.rootId);
  else bdArgs.push("--all");
  const { stdout } = await runBdStrict(
    "graph",
    cfg.bdCommand,
    bdArgs,
    cfg.bdDir,
    ctx.logger,
  );
  const raw = JSON.parse(stdout) as unknown;

  const issues = new Map<string, Record<string, unknown>>();
  let layers: string[][] | null = null;

  const edgeMap = new Map<string, { from: string; to: string; type: string }>();
  const addEdge = (from: string, to: string, type: unknown) => {
    if (!from || !to || from === to) return;
    const key = `${from}|${to}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, { from, to, type: String(type ?? "blocks") });
    }
  };

  let edgesKnown = false;
  if (Array.isArray(raw)) {
    const comps = raw as Array<
      Record<string, unknown> & {
        Issues?: Record<string, unknown>[];
        Dependencies?:
          | Array<{
            issue_id?: unknown;
            depends_on_id?: unknown;
            type?: unknown;
          }>
          | null;
      }
    >;
    edgesKnown = comps.every((comp) => comp?.Dependencies != null);
    for (const comp of comps) {
      for (const iss of (comp?.Issues ?? []) as Record<string, unknown>[]) {
        const id = String(iss.id ?? "");
        if (id && !issues.has(id)) issues.set(id, iss);
      }
      for (const dep of comp?.Dependencies ?? []) {
        addEdge(
          String(dep.issue_id ?? ""),
          String(dep.depends_on_id ?? ""),
          dep.type,
        );
      }
    }
  } else {
    const layout = ((raw as Record<string, unknown>)?.layout ?? {}) as {
      Layers?: unknown[][];
      Nodes?: Record<
        string,
        { DependsOn?: string[] | null; Issue?: Record<string, unknown> }
      >;
    };
    for (const [id, node] of Object.entries(layout.Nodes ?? {})) {
      if (id && !issues.has(id)) issues.set(id, node.Issue ?? { id });
    }
    if (Array.isArray(layout.Layers)) {
      layers = layout.Layers.map((
        l,
      ) => (Array.isArray(l) ? l.map(String) : []));
    }
  }

  // Expand typed edges from every queued node: downstream listings add what
  // a node depends on, upstream listings add what depends on it; records
  // seed further nodes so the walk reaches the full closure per direction.
  // The rooted layout cannot stand in for this (its DependsOn keys only
  // cover `blocks` relations), so every node is listed unless the all-open
  // components already carried a complete typed edge list.
  const queue = [...issues.keys()];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (parsed.direction !== "upstream" && !edgesKnown) {
      for (const rec of await fetchDepRecords(cfg, id, "down", ctx)) {
        addEdge(id, String(rec.id ?? ""), rec.dependency_type);
        const depId = String(rec.id ?? "");
        if (depId && !issues.has(depId)) {
          issues.set(depId, rec);
          queue.push(depId);
        }
      }
    }
    if (parsed.direction !== "downstream") {
      for (const rec of await fetchDepRecords(cfg, id, "up", ctx)) {
        addEdge(String(rec.id ?? ""), id, rec.dependency_type);
        const fromId = String(rec.id ?? "");
        if (fromId && !issues.has(fromId)) {
          issues.set(fromId, rec);
          queue.push(fromId);
        }
      }
    }
  }

  // Rooted graphs honor direction and depth: keep only what is reachable
  // from the root along the requested edge direction (downstream follows
  // what nodes depend on, upstream what depends on them). The rooted layout
  // node set necessarily over-shoots the direction, so extras are dropped
  // here; in all-open mode everything stays.
  if (parsed.rootId) {
    const adj = new Map<string, string[]>();
    for (const e of edgeMap.values()) {
      const pairs: Array<[string, string]> = [];
      if (parsed.direction !== "upstream") pairs.push([e.from, e.to]);
      if (parsed.direction !== "downstream") pairs.push([e.to, e.from]);
      for (const [a, b] of pairs) {
        const list = adj.get(a) ?? [];
        if (!list.includes(b)) list.push(b);
        adj.set(a, list);
      }
    }
    const keep = new Set<string>([parsed.rootId]);
    let frontier = [parsed.rootId];
    for (let hop = 0; parsed.depth < 0 || hop < parsed.depth; hop++) {
      const next: string[] = [];
      for (const a of frontier) {
        for (const b of adj.get(a) ?? []) {
          if (!keep.has(b)) {
            keep.add(b);
            next.push(b);
          }
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
    for (const id of [...issues.keys()]) {
      if (!keep.has(id)) issues.delete(id);
    }
    for (const [key, e] of [...edgeMap.entries()]) {
      if (!keep.has(e.from) || !keep.has(e.to)) edgeMap.delete(key);
    }
    if (layers) {
      layers = layers
        .map((l) => l.filter((id) => keep.has(id)))
        .filter((l) => l.length > 0);
    }
  }

  const nodes = [...issues.entries()].map(([id, iss]) => ({
    id,
    title: String(iss.title ?? ""),
    status: String(iss.status ?? ""),
  }));
  const graph = {
    rootId: parsed.rootId ?? null,
    nodes,
    edges: [...edgeMap.values()],
    layers,
  };
  const handle = await ctx.writeResource(
    "dependencyGraph",
    `dep-graph-${parsed.rootId ?? "all"}`,
    graph,
  );
  ctx.logger.info(
    "Collected bd dependency graph: {nodes} nodes, {edges} edges",
    { nodes: nodes.length, edges: graph.edges.length },
  );
  return { dataHandles: [handle] };
}

/** Swamp model definition for the beads issue tracker bridge. */
export const model = {
  type: "@maphew/bd",
  version: "2026.10.07.2",
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
    {
      toVersion: "2026.10.07.1",
      description:
        "Add query method (bd query language filtering); no changes to existing methods or resources",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.07.2",
      description:
        "Add dep, reopen, reclaim, and graph methods and the dependencyGraph resource; existing methods unchanged",
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
    dependencyGraph: {
      description:
        "A BD dependency graph: nodes (id, title, status), typed edges (from depends on to), and optional layers",
      schema: DependencyGraphSchema,
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
    query: {
      description:
        'Filter BD issues with bd\'s query language (e.g. "status=open AND type=bug")',
      arguments: QueryArgsSchema,
      execute: (
        args: Record<string, unknown>,
        ctx: Parameters<typeof queryIssues>[1],
      ) => queryIssues(args, ctx),
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
    reopen: {
      description:
        "Reopen one or more closed BD issues, optionally with a reason",
      arguments: ReopenArgsSchema,
      execute: async (
        args: Record<string, unknown>,
        ctx: Parameters<typeof reopenIssues>[1],
      ) => await reopenIssues(args, ctx),
    },
    dep: {
      description:
        "Manage BD dependencies: add, remove, or list them for an issue",
      arguments: DepArgsSchema,
      execute: (
        args: Record<string, unknown>,
        ctx: Parameters<typeof depManage>[1],
      ) => depManage(args, ctx),
    },
    reclaim: {
      description:
        "Revert stale in_progress BD issues (expired lease recovery) back to open",
      arguments: ReclaimArgsSchema,
      execute: (
        args: Record<string, unknown>,
        ctx: Parameters<typeof reclaimIssues>[1],
      ) => reclaimIssues(args, ctx),
    },
    graph: {
      description:
        "Return a BD dependency graph as structured nodes, typed edges, and layers (renderable as Mermaid)",
      arguments: GraphArgsSchema,
      execute: (
        args: Record<string, unknown>,
        ctx: Parameters<typeof showGraph>[1],
      ) => showGraph(args, ctx),
    },
  },
};
