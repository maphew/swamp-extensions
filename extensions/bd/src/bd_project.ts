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
 *   - `prime`  capture the bd prime workflow context and git-authority policy
 *   - `note`   append to an issue's notes (never replaces)
 *   - `comment` append a comment to an issue
 *   - `heartbeat` refresh the lease on a claim you hold
 *   - `unclaim` release a claim, optionally only if still held by an actor
 *   - `children` list every child of a parent (closed ones included)
 *   - `epicStatus` report epic completion and close eligibility
 *   - `count` count issues, optionally grouped by an attribute
 *   - `config` read bd configuration and its provenance
 *   - `doctor` capture bd doctor diagnostics (never repairs)
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
  assignee: z.string().nullable().default(null),
  parent: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().nullable().default(null),
  createdBy: z.string().nullable(),
  updatedAt: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  closedAt: z.string().nullable().default(null),
  closeReason: z.string().nullable().default(null),
  dueAt: z.string().nullable().default(null),
  externalRef: z.string().nullable().default(null),
  design: z.string().nullable().default(null),
  acceptanceCriteria: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  leaseExpiresAt: z.string().nullable().default(null),
  heartbeatAt: z.string().nullable().default(null),
  dependencyCount: z.number().int().default(0),
  dependentCount: z.number().int().default(0),
  commentCount: z.number().int().default(0),
  labels: z.array(z.string()).default([]),
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
  excludeLabels: z.array(z.string()).optional().describe(
    "Exclude issues carrying ANY of these labels",
  ),
  excludeTypes: z.array(z.string()).optional().describe(
    "Exclude issue types (comma-separated on the CLI; e.g. epic, convoy)",
  ),
  labels: z.array(z.string()).optional().describe(
    "Require ALL of these labels",
  ),
  labelsAny: z.array(z.string()).optional().describe(
    "Require at least one of these labels",
  ),
  labelPattern: z.string().optional().describe(
    "Label glob pattern, e.g. 'tech-*'",
  ),
  parent: z.string().optional().describe(
    "Only descendants of this bead/epic",
  ),
  priority: z.number().int().min(0).max(4).optional().describe(
    "Only issues at this priority",
  ),
  unassigned: z.boolean().default(false).describe(
    "Only unassigned issues",
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
  ifAssignee: z.string().optional().describe(
    "Apply only when the current assignee equals this value ('' means unassigned); a mismatch writes nothing and returns a precondition_failed outcome instead of throwing",
  ),
  ifStatus: z.string().optional().describe(
    "Apply only when the current status equals this value; a mismatch writes nothing and returns a precondition_failed outcome instead of throwing",
  ),
}).refine(
  (args) =>
    args.claim === true || args.title !== undefined ||
    args.description !== undefined || args.status !== undefined ||
    args.priority !== undefined || args.assignee !== undefined ||
    (args.addLabels?.length ?? 0) > 0 || (args.removeLabels?.length ?? 0) > 0,
  { message: "Provide at least one field to update, or claim: true" },
).refine(
  (args) =>
    !(args.claim === true) ||
    (args.ifAssignee === undefined && args.ifStatus === undefined),
  { message: "claim cannot be combined with ifAssignee/ifStatus" },
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

/** Arguments for the `prime` method. */
const PrimeArgsSchema = z.object({
  memories: z.enum(["include", "only", "exclude"]).default("include").describe(
    "Persistent-memory section: include (default), only (that section alone), or exclude (omit it)",
  ),
  maxMemories: z.number().int().min(0).optional().describe(
    "Cap the number of injected memories (0 = unlimited); whole memories only",
  ),
  maxMemoryChars: z.number().int().min(0).optional().describe(
    "Cap the total bytes of injected memories (0 = unlimited); whole memories only",
  ),
});

/** Arguments for the `note` method. */
const NoteArgsSchema = z.object({
  id: z.string().describe("Issue ID (e.g., bd-mhw-1)"),
  text: z.string().optional().describe(
    "Note text to append (a newline separator is added)",
  ),
  file: z.string().optional().describe(
    "Path to a file whose contents become the note (use for long evidence)",
  ),
}).refine(
  (args) => (args.text !== undefined) !== (args.file !== undefined),
  { message: "Provide exactly one of text or file" },
);

/** Arguments for the `comment` method. */
const CommentArgsSchema = z.object({
  id: z.string().describe("Issue ID (e.g., bd-mhw-1)"),
  text: z.string().optional().describe("Comment text to append"),
  file: z.string().optional().describe(
    "Path to a file whose contents become the comment",
  ),
}).refine(
  (args) => (args.text !== undefined) !== (args.file !== undefined),
  { message: "Provide exactly one of text or file" },
);

/** Arguments for the `heartbeat` method. */
const HeartbeatArgsSchema = z.object({
  ids: z.array(z.string()).min(1).describe(
    "Issue IDs whose leases to refresh (only the current holder can heartbeat)",
  ),
});

/** Arguments for the `unclaim` method. */
const UnclaimArgsSchema = z.object({
  id: z.string().optional().describe("Issue ID to release"),
  ids: z.array(z.string()).optional().describe(
    "Issue IDs to release (alternative to id)",
  ),
  ifAssignee: z.string().optional().describe(
    "Release only while still assigned to this assignee (atomic compare-and-swap); a mismatch writes nothing and returns a precondition_failed outcome",
  ),
  reason: z.string().optional().describe("Reason for releasing the claim"),
}).refine(
  (args) => {
    const single = args.id !== undefined && args.id !== "";
    const many = (args.ids?.length ?? 0) > 0;
    return single !== many;
  },
  { message: "Provide exactly one of id or ids" },
).refine(
  (args) => args.ifAssignee === undefined || args.ifAssignee !== "",
  { message: "ifAssignee must be non-empty (bd has no 'unassigned' guard)" },
);

/** Arguments for the `children` method. */
const ChildrenArgsSchema = z.object({
  parentId: z.string().describe(
    "Parent issue ID; closed children are included",
  ),
});

/** Arguments for the `epicStatus` method. */
const EpicStatusArgsSchema = z.object({
  epicId: z.string().optional().describe("Only report this epic"),
  eligibleOnly: z.boolean().default(false).describe(
    "Only epics eligible for closure",
  ),
});

/** Attributes `bd count --by-*` can group by. */
const CountGroupBy = [
  "status",
  "priority",
  "type",
  "assignee",
  "label",
] as const;

/** Arguments for the `count` method. */
const CountArgsSchema = z.object({
  status: z.string().optional().describe("Filter by stored status"),
  type: z.string().optional().describe("Filter by issue type"),
  priority: z.number().int().min(0).max(4).optional().describe(
    "Filter by exact priority",
  ),
  priorityMin: z.number().int().min(0).max(4).optional().describe(
    "Filter by minimum priority (inclusive)",
  ),
  priorityMax: z.number().int().min(0).max(4).optional().describe(
    "Filter by maximum priority (inclusive)",
  ),
  assignee: z.string().optional().describe("Filter by assignee"),
  noAssignee: z.boolean().default(false).describe(
    "Only issues with no assignee",
  ),
  labels: z.array(z.string()).optional().describe(
    "Require ALL of these labels",
  ),
  labelsAny: z.array(z.string()).optional().describe(
    "Require at least one of these labels",
  ),
  titleContains: z.string().optional().describe(
    "Case-insensitive title substring",
  ),
  notesContains: z.string().optional().describe("Notes substring"),
  descContains: z.string().optional().describe("Description substring"),
  includeInfra: z.boolean().default(false).describe(
    "Include infrastructure beads and the wisps tier",
  ),
  groupBy: z.enum(CountGroupBy).optional().describe(
    "Group the count by one attribute",
  ),
});

/** Arguments for the `config` method. */
const ConfigArgsSchema = z.object({
  key: z.string().optional().describe(
    "One config key to read (e.g. agent.profile); omit for every effective key with its source",
  ),
  revealSecrets: z.boolean().default(false).describe(
    "Return credential-looking values in full. Off by default: keys such as github.token, linear.api_key, jira.api_token, ado.pat, and ai.api_key are stored and logged as [redacted]",
  ),
});

/** Arguments for the `doctor` method. */
const DoctorArgsSchema = z.object({
  check: z.string().optional().describe(
    "Run one specific check in detail (e.g. artifacts, conventions, pollution, validate)",
  ),
});

/** Schema for a non-throwing guard failure (bd exit 13 or an unclaim CAS mismatch). */
const MutationOutcomeSchema = z.object({
  outcome: z.literal("precondition_failed").describe(
    "The guard did not hold, so nothing was written",
  ),
  method: z.string().describe("Method that was guarded"),
  issueId: z.string(),
  guard: z.string().nullable().describe(
    "Guard that failed, e.g. if-assignee or if-status",
  ),
  expected: z.string().nullable().describe("Value the caller required"),
  currentAssignee: z.string().nullable(),
  currentStatus: z.string().nullable(),
  message: z.string().describe("bd's first line describing the mismatch"),
  at: z.string(),
});

/** Schema for an epic's completion status. */
const EpicStatusSchema = z.object({
  epicId: z.string(),
  title: z.string(),
  status: z.string(),
  totalChildren: z.number().int(),
  closedChildren: z.number().int(),
  eligibleForClose: z.boolean(),
});

/** Schema for a filtered issue count. */
const IssueCountSchema = z.object({
  count: z.number().int(),
  groupBy: z.string().nullable(),
  groups: z.array(z.object({
    key: z.string(),
    count: z.number().int(),
  })).nullable().describe("Per-group counts, or null when not grouped"),
  filters: z.record(z.string(), z.unknown()).describe(
    "Filters applied, echoed for the report",
  ),
  generatedAt: z.string(),
});

/** Schema for bd configuration read-back. */
const BdConfigSchema = z.object({
  key: z.string().nullable().describe(
    "The single key requested, or null for the full effective configuration",
  ),
  entries: z.array(z.object({
    key: z.string(),
    value: z.unknown().describe(
      "The value, or [redacted] for a credential-looking key unless revealSecrets was set",
    ),
    source: z.string().nullable().describe(
      "Where the value comes from (default, database, git, file, ...)",
    ),
    redacted: z.boolean().describe(
      "True when a credential-looking value was withheld",
    ),
  })),
  generatedAt: z.string(),
});

/** Schema for a bd doctor report. */
const DoctorReportSchema = z.object({
  supported: z.boolean().describe(
    "False when bd reports doctor is unsupported for this storage mode",
  ),
  mode: z.string().nullable(),
  error: z.string().nullable(),
  raw: z.record(z.string(), z.unknown()).describe(
    "The doctor JSON verbatim; never inferred from the exit code",
  ),
  generatedAt: z.string(),
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

/** Schema for the bd prime workflow-context resource. */
const PrimeContextSchema = z.object({
  content: z.string().describe(
    "The bd prime workflow context and git-authority policy text",
  ),
  profile: z.string().nullable().describe(
    "The explicit agent.profile bd prints (e.g. team-maintainer), or null when the profile is implicit/default",
  ),
  generatedAt: z.string().describe("When the context was captured"),
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
  actor: z.string().optional().describe(
    "Actor passed as --actor on every mutating command. Defaults to $BEADS_ACTOR when set; otherwise bd resolves git user.name / $USER. Set this in workflows so concurrent runs claim as distinct actors",
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
/** Validated `prime` arguments. */
type PrimeArgs = z.infer<typeof PrimeArgsSchema>;
/** Validated `note` arguments. */
type NoteArgs = z.infer<typeof NoteArgsSchema>;
/** Validated `comment` arguments. */
type CommentArgs = z.infer<typeof CommentArgsSchema>;
/** Validated `heartbeat` arguments. */
type HeartbeatArgs = z.infer<typeof HeartbeatArgsSchema>;
/** Validated `unclaim` arguments. */
type UnclaimArgs = z.infer<typeof UnclaimArgsSchema>;
/** Validated `children` arguments. */
type ChildrenArgs = z.infer<typeof ChildrenArgsSchema>;
/** Validated `epicStatus` arguments. */
type EpicStatusArgs = z.infer<typeof EpicStatusArgsSchema>;
/** Validated `count` arguments. */
type CountArgs = z.infer<typeof CountArgsSchema>;
/** Validated `config` arguments. */
type ConfigArgs = z.infer<typeof ConfigArgsSchema>;
/** Validated `doctor` arguments. */
type DoctorArgs = z.infer<typeof DoctorArgsSchema>;

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
  // swamp-quality-ignore deno-command: the bd CLI is the contract this extension wraps; args are a validated argv array (no shell).
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

/** Coerce a bd JSON value to a string, preserving genuine absence. */
function asStringOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

/** bd emits metadata as an object in issue records and as a JSON string in dep edges. */
function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim() !== "") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not JSON; treat as absent rather than inventing a shape
    }
  }
  return {};
}

/**
 * Normalize a raw bd JSON record into the issue resource shape.
 *
 * Fields bd did not send stay null. Substituting the wall clock for a missing
 * `created_at`/`updated_at` would forge history (bd's `--brief` omits some
 * fields), so absence is preserved explicitly.
 */
export function normalizeIssue(
  raw: Record<string, unknown>,
  cfg: GlobalArgs,
  fallbacks: { status: string; issueType: string },
): Issue {
  return {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? ""),
    description: asStringOrNull(raw.description),
    status: String(raw.status ?? fallbacks.status),
    priority: Number(raw.priority ?? cfg.defaultPriority),
    issueType: String(raw.issue_type ?? fallbacks.issueType),
    owner: asStringOrNull(raw.owner),
    assignee: asStringOrNull(raw.assignee),
    parent: asStringOrNull(raw.parent),
    metadata: parseMetadata(raw.metadata),
    createdAt: asStringOrNull(raw.created_at),
    createdBy: asStringOrNull(raw.created_by),
    updatedAt: asStringOrNull(raw.updated_at),
    startedAt: asStringOrNull(raw.started_at),
    closedAt: asStringOrNull(raw.closed_at),
    closeReason: asStringOrNull(raw.close_reason),
    dueAt: asStringOrNull(raw.due_at),
    externalRef: asStringOrNull(raw.external_ref),
    design: asStringOrNull(raw.design),
    acceptanceCriteria: asStringOrNull(raw.acceptance_criteria),
    notes: asStringOrNull(raw.notes),
    leaseExpiresAt: asStringOrNull(raw.lease_expires_at),
    heartbeatAt: asStringOrNull(raw.heartbeat_at),
    dependencyCount: Number(raw.dependency_count ?? 0),
    dependentCount: Number(raw.dependent_count ?? 0),
    commentCount: Number(raw.comment_count ?? 0),
    labels: Array.isArray(raw.labels)
      ? (raw.labels as unknown[]).map(String)
      : [],
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
 * The actor to pass to bd for mutating commands, or undefined to let bd
 * resolve one (git user.name, then $USER).
 */
function effectiveActor(cfg: GlobalArgs): string | undefined {
  const configured = cfg.actor?.trim();
  if (configured) return configured;
  const fromEnv = Deno.env.get("BEADS_ACTOR")?.trim();
  return fromEnv || undefined;
}

/** Append the effective --actor to a mutating bd invocation. */
function withActor(cfg: GlobalArgs, args: string[]): string[] {
  const actor = effectiveActor(cfg);
  return actor ? [...args, "--actor", actor] : args;
}

/** How the actor is reported in logs. */
function actorLabel(cfg: GlobalArgs): string {
  return effectiveActor(cfg) ?? "(bd default)";
}

/**
 * Which CAS guard bd says failed, from its documented mismatch text.
 *
 * The text is needed because bd only tells the exit code (13 for update) and
 * because `update` may carry both guards: the assignee guard is checked
 * first, so attributing by argument presence would blame the wrong guard.
 */
function guardMismatchKind(
  result: BdResult,
): "assignee" | "status" | null {
  const text = `${result.stderr}\n${result.stdout}`;
  if (/assignee mismatch/i.test(text)) return "assignee";
  if (/status mismatch/i.test(text)) return "status";
  return null;
}

/** bd's documented CAS mismatch text for --if-assignee / --if-status. */
function isGuardMismatch(result: BdResult): boolean {
  return guardMismatchKind(result) !== null;
}

/**
 * Turn a failed guard into a resource instead of a throw, so a workflow can
 * branch on `outcome: precondition_failed` rather than retrying.
 */
async function writePreconditionOutcome(
  method: string,
  cfg: GlobalArgs,
  id: string,
  guard: string,
  expected: string,
  result: BdResult,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  let currentAssignee: string | null = null;
  let currentStatus: string | null = null;
  try {
    const issue = await fetchIssue(cfg, id, ctx);
    currentAssignee = issue.assignee;
    currentStatus = issue.status;
  } catch {
    // The issue may be gone; the guard failure is still reportable.
  }
  const message = (result.stderr.trim() || result.stdout.trim() ||
    "precondition failed").split("\n")[0];
  const handle = await ctx.writeResource(
    "outcome",
    `outcome-${method}-${id}`,
    {
      outcome: "precondition_failed",
      method,
      issueId: id,
      guard,
      expected,
      currentAssignee,
      currentStatus,
      message,
      at: new Date().toISOString(),
    },
  );
  ctx.logger.info(
    "{method} skipped bd issue {id}: {guard} guard failed ({message})",
    { method, id, guard, message },
  );
  return { dataHandles: [handle] };
}

/**
 * Run `bd dep list <id> --json`/**
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
  if (parsed.parent) bdArgs.push("--parent", parsed.parent);
  if (parsed.priority !== undefined) {
    bdArgs.push("--priority", String(parsed.priority));
  }
  if (parsed.labelPattern) bdArgs.push("--label-pattern", parsed.labelPattern);
  if (parsed.unassigned) bdArgs.push("--unassigned");
  for (const label of parsed.labels ?? []) bdArgs.push("--label", label);
  for (const label of parsed.labelsAny ?? []) {
    bdArgs.push("--label-any", label);
  }
  for (const label of parsed.excludeLabels ?? []) {
    bdArgs.push("--exclude-label", label);
  }
  for (const type of parsed.excludeTypes ?? []) {
    bdArgs.push("--exclude-type", type);
  }

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

/**
 * Find an existing open issue carrying all of `labels` and matching `title`.
 *
 * Used by `create` as its idempotency guard: bd has no durable action-marker
 * resource like swamp's `writeResource`, so the dedup key is the caller's own
 * (label, title, status=open) tuple. Returns the normalized issue or null.
 */
async function findIssueByLabelAndTitle(
  cfg: GlobalArgs,
  labels: string[],
  title: string,
  ctx: {
    logger: {
      error: (msg: string, props?: Record<string, unknown>) => void;
    };
  },
): Promise<Issue | null> {
  const { stdout } = await runBdStrict(
    "create-dedup-list",
    cfg.bdCommand,
    ["list", "--json", "--limit", "500", "--label", labels.join(",")],
    cfg.bdDir,
    ctx.logger,
  );

  const all = (JSON.parse(stdout) as Record<string, unknown>[])
    .map((raw) =>
      normalizeIssue(raw, cfg, { status: "open", issueType: cfg.defaultType })
    );
  return (
    all.find(
      (i) =>
        i.status === "open" && i.title === title &&
        labels.every((l) => i.labels.includes(l)),
    ) ?? null
  );
}

async function createIssue(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = CreateArgsSchema.parse(args);

  // Idempotency guard: if a label set was provided, look for an existing open
  // issue with the same title under that label and skip creation. bd has no
  // durable action-marker resource like swamp's writeResource, so the dedup
  // key is (label, title, status=open) — the same shape the caller controls.
  // Callers that want per-fire uniqueness should vary the title.
  if (parsed.labels && parsed.labels.length > 0) {
    const existing = await findIssueByLabelAndTitle(
      cfg,
      parsed.labels,
      parsed.title,
      ctx,
    );
    if (existing) {
      ctx.logger.info(
        "Skipped bd create: existing open issue {id} matches label+title",
        { id: existing.id },
      );
      const handle = await ctx.writeResource(
        "issue",
        `issue-${existing.id}`,
        existing,
      );
      return { dataHandles: [handle] };
    }
  }

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
    withActor(cfg, bdArgs),
    cfg.bdDir,
    ctx.logger,
  );

  const raw = JSON.parse(stdout) as Record<string, unknown>;
  const issue = normalizeIssue(raw, cfg, {
    status: "open",
    issueType: parsed.type,
  });

  const handle = await ctx.writeResource("issue", `issue-${issue.id}`, issue);
  ctx.logger.info("Created bd issue {id} as {actor}", {
    id: issue.id,
    actor: actorLabel(cfg),
  });
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
  if (parsed.ifAssignee !== undefined) {
    bdArgs.push("--if-assignee", parsed.ifAssignee);
  }
  if (parsed.ifStatus !== undefined) {
    bdArgs.push("--if-status", parsed.ifStatus);
  }

  const result = await runBd(cfg.bdCommand, withActor(cfg, bdArgs), cfg.bdDir);
  if (!result.success) {
    // bd exits 13 when every failure was a guard mismatch and nothing was
    // written. Surface that as a branchable outcome instead of a throw.
    const guarded = parsed.ifAssignee !== undefined ||
      parsed.ifStatus !== undefined;
    const kind = guardMismatchKind(result);
    if (guarded && (result.code === 13 || kind !== null)) {
      // Prefer bd's own mismatch text: with both guards supplied, checking
      // argument presence would report if-assignee for a status failure.
      const failed = kind ??
        (parsed.ifAssignee !== undefined ? "assignee" : "status");
      const guard = failed === "assignee" ? "if-assignee" : "if-status";
      const expected = failed === "assignee"
        ? (parsed.ifAssignee ?? "")
        : (parsed.ifStatus ?? "");
      return await writePreconditionOutcome(
        "update",
        cfg,
        parsed.id,
        guard,
        expected,
        result,
        ctx,
      );
    }
    ctx.logger.error("bd update failed (exit {code}): {detail}", {
      code: result.code,
      detail: (result.stderr.trim() || result.stdout.trim()).slice(0, 2000),
    });
    throw bdError("update", result);
  }

  const issue = await fetchIssue(cfg, parsed.id, ctx);
  const handle = await ctx.writeResource("issue", `issue-${issue.id}`, issue);
  ctx.logger.info("Updated bd issue {id} as {actor}", {
    id: issue.id,
    actor: actorLabel(cfg),
  });
  return { dataHandles: [handle] };
}

async function closeIssue(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = CloseArgsSchema.parse(args);

  const bdArgs = ["close", parsed.id];
  if (parsed.reason) bdArgs.push("--reason", parsed.reason);

  await runBdStrict(
    "close",
    cfg.bdCommand,
    withActor(cfg, bdArgs),
    cfg.bdDir,
    ctx.logger,
  );

  // Read the issue back rather than merging a local timestamp into a stale
  // copy: bd's own closed_at/updated_at/close_reason are the evidence.
  const issue = await fetchIssue(cfg, parsed.id, ctx);
  const handle = await ctx.writeResource(
    "issue",
    `issue-${issue.id}`,
    issue,
  );

  ctx.logger.info("Closed bd issue {id} as {actor}", {
    id: parsed.id,
    actor: actorLabel(cfg),
  });
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
    withActor(cfg, [
      "dep",
      parsed.action,
      parsed.issueId,
      parsed.dependsOnId as string,
      "--json",
    ]),
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

  await runBdStrict(
    "reopen",
    cfg.bdCommand,
    withActor(cfg, bdArgs),
    cfg.bdDir,
    ctx.logger,
  );

  const handles: Array<{ name: string }> = [];
  for (const id of parsed.ids) {
    const issue = await fetchIssue(cfg, id, ctx);
    handles.push(await ctx.writeResource("issue", `issue-${issue.id}`, issue));
  }

  ctx.logger.info("Reopened {count} bd issues as {actor}", {
    count: handles.length,
    actor: actorLabel(cfg),
  });
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
    withActor(cfg, bdArgs),
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

async function primeContext(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = PrimeArgsSchema.parse(args);

  const bdArgs = ["prime"];
  if (parsed.memories === "only") bdArgs.push("--memories-only");
  if (parsed.memories === "exclude") bdArgs.push("--no-memories");
  if (parsed.maxMemories !== undefined) {
    bdArgs.push("--max-memories", String(parsed.maxMemories));
  }
  if (parsed.maxMemoryChars !== undefined) {
    bdArgs.push("--max-memory-chars", String(parsed.maxMemoryChars));
  }

  const { stdout } = await runBdStrict(
    "prime",
    cfg.bdCommand,
    bdArgs,
    cfg.bdDir,
    ctx.logger,
  );

  const content = stdout.trim();
  // bd prints an explicit agent.profile= only for a non-default profile. Search
  // the policy text before the appended memories so a memory that happens to
  // mention agent.profile= cannot be mistaken for the active profile.
  const policyText = content.split(/\n#{1,6}\s+.*Persistent Memories/i)[0];
  const profile = /agent\.profile=([A-Za-z-]+)/.exec(policyText)?.[1] ?? null;
  const handle = await ctx.writeResource("primeContext", "prime-current", {
    content,
    profile,
    generatedAt: new Date().toISOString(),
  });

  ctx.logger.info(
    "Captured bd prime context ({chars} chars, profile {profile})",
    { chars: content.length, profile: profile ?? "unknown" },
  );
  return { dataHandles: [handle] };
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

// ---------- append-only evidence ------------------------------------------

async function noteIssue(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = NoteArgsSchema.parse(args);

  const bdArgs = ["note", parsed.id];
  if (parsed.text !== undefined) bdArgs.push(parsed.text);
  else bdArgs.push("--file", parsed.file as string);

  await runBdStrict(
    "note",
    cfg.bdCommand,
    withActor(cfg, bdArgs),
    cfg.bdDir,
    ctx.logger,
  );

  const issue = await fetchIssue(cfg, parsed.id, ctx);
  const handle = await ctx.writeResource("issue", `issue-${issue.id}`, issue);
  ctx.logger.info("Appended a note to bd issue {id} as {actor}", {
    id: issue.id,
    actor: actorLabel(cfg),
  });
  return { dataHandles: [handle] };
}

async function commentIssue(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = CommentArgsSchema.parse(args);

  const bdArgs = ["comment", parsed.id];
  if (parsed.text !== undefined) bdArgs.push(parsed.text);
  else bdArgs.push("--file", parsed.file as string);

  await runBdStrict(
    "comment",
    cfg.bdCommand,
    withActor(cfg, bdArgs),
    cfg.bdDir,
    ctx.logger,
  );

  const issue = await fetchIssue(cfg, parsed.id, ctx);
  const handle = await ctx.writeResource("issue", `issue-${issue.id}`, issue);
  ctx.logger.info("Appended a comment to bd issue {id} as {actor}", {
    id: issue.id,
    actor: actorLabel(cfg),
  });
  return { dataHandles: [handle] };
}

// ---------- claim lifecycle ----------------------------------------------

async function heartbeatIssues(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = HeartbeatArgsSchema.parse(args);

  const handles: Array<{ name: string }> = [];
  for (const id of parsed.ids) {
    // Only the current holder can heartbeat; a failure is loud by design so a
    // worker whose lease was reclaimed learns to stop.
    await runBdStrict(
      `heartbeat ${id}`,
      cfg.bdCommand,
      withActor(cfg, ["heartbeat", id]),
      cfg.bdDir,
      ctx.logger,
    );
    const issue = await fetchIssue(cfg, id, ctx);
    handles.push(
      await ctx.writeResource("issue", `issue-${issue.id}`, issue),
    );
  }

  ctx.logger.info("Refreshed {count} bd lease(s) as {actor}", {
    count: handles.length,
    actor: actorLabel(cfg),
  });
  return { dataHandles: handles };
}

async function unclaimIssues(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = UnclaimArgsSchema.parse(args);
  const ids = parsed.ids ?? [parsed.id as string];

  const handles: Array<{ name: string }> = [];
  for (const id of ids) {
    const bdArgs = ["unclaim", id];
    if (parsed.ifAssignee !== undefined) {
      bdArgs.push("--if-assignee", parsed.ifAssignee);
    }
    if (parsed.reason) bdArgs.push("--reason", parsed.reason);

    const result = await runBd(
      cfg.bdCommand,
      withActor(cfg, bdArgs),
      cfg.bdDir,
    );
    if (!result.success) {
      // bd 1.3.2 exits 1 (not 13) for an unclaim --if-assignee mismatch, so
      // match the documented CAS error text rather than the exit code alone.
      if (
        parsed.ifAssignee !== undefined &&
        (result.code === 13 || isGuardMismatch(result))
      ) {
        const outcome = await writePreconditionOutcome(
          "unclaim",
          cfg,
          id,
          "if-assignee",
          parsed.ifAssignee,
          result,
          ctx,
        );
        handles.push(...outcome.dataHandles);
        continue;
      }
      ctx.logger.error("bd unclaim failed (exit {code}): {detail}", {
        code: result.code,
        detail: (result.stderr.trim() || result.stdout.trim()).slice(0, 2000),
      });
      throw bdError("unclaim", result);
    }

    const issue = await fetchIssue(cfg, id, ctx);
    handles.push(
      await ctx.writeResource("issue", `issue-${issue.id}`, issue),
    );
  }

  ctx.logger.info("Released {count} bd claim(s) as {actor}", {
    count: handles.length,
    actor: actorLabel(cfg),
  });
  return { dataHandles: handles };
}

// ---------- structure and reporting --------------------------------------

async function childrenIssues(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = ChildrenArgsSchema.parse(args);

  const { stdout } = await runBdStrict(
    "children",
    cfg.bdCommand,
    ["children", parsed.parentId, "--json"],
    cfg.bdDir,
    ctx.logger,
  );

  const records = JSON.parse(stdout) as Record<string, unknown>[];
  const handles: Array<{ name: string }> = [];
  for (const raw of records) {
    const issue = normalizeIssue(raw, cfg, {
      status: "open",
      issueType: cfg.defaultType,
    });
    if (!issue.id) continue;
    handles.push(
      await ctx.writeResource("issue", `issue-${issue.id}`, issue),
    );
  }

  ctx.logger.info("Listed {count} children of bd issue {id}", {
    count: handles.length,
    id: parsed.parentId,
  });
  return { dataHandles: handles };
}

async function epicStatuses(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = EpicStatusArgsSchema.parse(args);

  const bdArgs = ["epic", "status", "--json"];
  if (parsed.eligibleOnly) bdArgs.push("--eligible-only");

  const { stdout } = await runBdStrict(
    "epic status",
    cfg.bdCommand,
    bdArgs,
    cfg.bdDir,
    ctx.logger,
  );

  const entries = JSON.parse(stdout) as Array<{
    epic?: Record<string, unknown>;
    total_children?: unknown;
    closed_children?: unknown;
    eligible_for_close?: unknown;
  }>;

  const handles: Array<{ name: string }> = [];
  for (const entry of entries) {
    const epic = entry.epic ?? {};
    const id = String(epic.id ?? "");
    if (!id) continue;
    if (parsed.epicId !== undefined && id !== parsed.epicId) continue;
    handles.push(
      await ctx.writeResource("epicStatus", `epic-${id}`, {
        epicId: id,
        title: String(epic.title ?? ""),
        status: String(epic.status ?? ""),
        totalChildren: Number(entry.total_children ?? 0),
        closedChildren: Number(entry.closed_children ?? 0),
        eligibleForClose: entry.eligible_for_close === true,
      }),
    );
  }

  ctx.logger.info("Reported status for {count} bd epic(s)", {
    count: handles.length,
  });
  return { dataHandles: handles };
}

async function countIssues(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = CountArgsSchema.parse(args);

  const bdArgs = ["count", "--json"];
  if (parsed.status) bdArgs.push("--status", parsed.status);
  if (parsed.type) bdArgs.push("--type", parsed.type);
  if (parsed.priority !== undefined) {
    bdArgs.push("--priority", String(parsed.priority));
  }
  if (parsed.priorityMin !== undefined) {
    bdArgs.push("--priority-min", String(parsed.priorityMin));
  }
  if (parsed.priorityMax !== undefined) {
    bdArgs.push("--priority-max", String(parsed.priorityMax));
  }
  if (parsed.assignee) bdArgs.push("--assignee", parsed.assignee);
  if (parsed.noAssignee) bdArgs.push("--no-assignee");
  if (parsed.titleContains) {
    bdArgs.push("--title-contains", parsed.titleContains);
  }
  if (parsed.notesContains) {
    bdArgs.push("--notes-contains", parsed.notesContains);
  }
  if (parsed.descContains) {
    bdArgs.push("--desc-contains", parsed.descContains);
  }
  if (parsed.includeInfra) bdArgs.push("--include-infra");
  for (const label of parsed.labels ?? []) bdArgs.push("--label", label);
  for (const label of parsed.labelsAny ?? []) {
    bdArgs.push("--label-any", label);
  }
  if (parsed.groupBy) bdArgs.push(`--by-${parsed.groupBy}`);

  const { stdout } = await runBdStrict(
    "count",
    cfg.bdCommand,
    bdArgs,
    cfg.bdDir,
    ctx.logger,
  );

  const raw = JSON.parse(stdout) as {
    count?: unknown;
    total?: unknown;
    groups?: Array<{ group?: unknown; count?: unknown }>;
  };
  const groups = Array.isArray(raw.groups)
    ? raw.groups.map((group) => ({
      key: String(group.group ?? ""),
      count: Number(group.count ?? 0),
    }))
    : null;
  const count = Number(
    raw.count ??
      raw.total ??
      (groups ?? []).reduce((sum, group) => sum + group.count, 0),
  );

  const handle = await ctx.writeResource("issueCount", "count-current", {
    count,
    groupBy: parsed.groupBy ?? null,
    groups,
    filters: { ...parsed },
    generatedAt: new Date().toISOString(),
  });

  ctx.logger.info(
    "Counted {count} bd issue(s){grouped}",
    {
      count,
      grouped: parsed.groupBy ? ` grouped by ${parsed.groupBy}` : "",
    },
  );
  return { dataHandles: [handle] };
}

/**
 * bd config keys that carry integration credentials. `bd config show` prints
 * their values in full, so the extension must not persist or log them by
 * default.
 */
const SECRET_KEY_PATTERN =
  /(?:^|[._-])(?:token|secret|api[_-]?key|api[_-]?token|password|passwd|pat|credential|private[_-]?key)(?:[._-]|$)/i;

/** The placeholder stored in place of a withheld credential value. */
const REDACTED_VALUE = "[redacted]";

/** Whether a bd config key names a credential-bearing setting. */
export function isSecretConfigKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

async function readConfig(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = ConfigArgsSchema.parse(args);

  const entries: Array<{
    key: string;
    value: unknown;
    source: string | null;
    redacted: boolean;
  }> = [];
  const visibleValue = (key: string, value: unknown) => {
    const hide = isSecretConfigKey(key) && !parsed.revealSecrets;
    return { value: hide ? REDACTED_VALUE : (value ?? null), redacted: hide };
  };

  if (parsed.key !== undefined) {
    const { stdout } = await runBdStrict(
      "config get",
      cfg.bdCommand,
      ["config", "get", parsed.key, "--json"],
      cfg.bdDir,
      ctx.logger,
    );
    const raw = JSON.parse(stdout) as Record<string, unknown>;
    const key = String(raw.key ?? parsed.key);
    entries.push({
      key,
      ...visibleValue(key, raw.value),
      source: asStringOrNull(raw.source ?? raw.location),
    });
  } else {
    const { stdout } = await runBdStrict(
      "config show",
      cfg.bdCommand,
      ["config", "show", "--json"],
      cfg.bdDir,
      ctx.logger,
    );
    const raws = JSON.parse(stdout) as Array<Record<string, unknown>>;
    for (const raw of raws) {
      const key = String(raw.key ?? "");
      entries.push({
        key,
        ...visibleValue(key, raw.value),
        source: asStringOrNull(raw.source),
      });
    }
  }

  const handle = await ctx.writeResource(
    "bdConfig",
    `config-${parsed.key ?? "effective"}`,
    {
      key: parsed.key ?? null,
      entries,
      generatedAt: new Date().toISOString(),
    },
  );

  if (parsed.key !== undefined) {
    const entry = entries[0];
    // Never log a config value: bd config holds integration credentials.
    ctx.logger.info("Read bd config {key} (source {source}{redacted})", {
      key: entry.key,
      source: entry.source ?? "unknown",
      redacted: entry.redacted ? ", value redacted" : "",
    });
  } else {
    const redacted = entries.filter((entry) => entry.redacted).length;
    ctx.logger.info(
      "Read {count} effective bd config keys ({redacted} redacted)",
      { count: entries.length, redacted },
    );
  }
  return { dataHandles: [handle] };
}

async function doctorReport(
  args: Record<string, unknown>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = DoctorArgsSchema.parse(args);

  const bdArgs = ["doctor", "--json"];
  if (parsed.check) bdArgs.push("--check", parsed.check);

  // bd doctor's exit code is not a verdict (embedded mode reports
  // "unsupported" with exit 0; some checks warn without failing). Parse the
  // JSON and record what it says.
  const result = await runBd(cfg.bdCommand, bdArgs, cfg.bdDir);

  let raw: Record<string, unknown> | null = null;
  // bd 1.3.2 writes doctor's JSON to stderr, not stdout; accept either.
  for (const stream of [result.stdout, result.stderr]) {
    if (!stream.trim()) continue;
    try {
      const parsedJson = JSON.parse(stream) as unknown;
      if (
        parsedJson && typeof parsedJson === "object" &&
        !Array.isArray(parsedJson)
      ) {
        raw = parsedJson as Record<string, unknown>;
        break;
      }
    } catch {
      // try the next stream, then fall through to the diagnostic error
    }
  }
  if (!raw) {
    ctx.logger.error("bd doctor failed (exit {code}): {detail}", {
      code: result.code,
      detail: (result.stderr.trim() || result.stdout.trim()).slice(0, 2000),
    });
    throw bdError("doctor", result);
  }

  const supported = raw.unsupported !== true;
  const handle = await ctx.writeResource("doctorReport", "doctor-current", {
    supported,
    mode: asStringOrNull(raw.mode),
    error: asStringOrNull(raw.error),
    raw,
    generatedAt: new Date().toISOString(),
  });

  ctx.logger.info("Captured bd doctor report (supported {supported}{error})", {
    supported,
    error: supported ? "" : `: ${String(raw.error ?? "")}`,
  });
  return { dataHandles: [handle] };
}

/** Swamp model definition for the beads issue tracker bridge. */
export const model = {
  type: "@maphew/bd",
  version: "2026.11.05.1",
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
    {
      toVersion: "2026.10.16.1",
      description:
        "Add prime method and primeContext resource; existing methods and resources unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.21.1",
      description:
        "Make create idempotent on label+title: IssueSchema now carries labels and create returns the existing open issue instead of duplicating; existing resources and methods otherwise unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.05.1",
      description:
        "Concurrency-safe claims: actor global arg (default $BEADS_ACTOR) passed as --actor on every mutation; " +
        "update ifAssignee/ifStatus and unclaim ifAssignee are CAS guards that return a precondition_failed outcome instead of throwing; " +
        "heartbeat/unclaim methods; IssueSchema now carries assignee, parent, metadata, notes, design, acceptance_criteria, " +
        "due_at, external_ref, started_at/closed_at/close_reason, lease timestamps, and no longer forges createdAt/updatedAt; " +
        "ready gained exclude/label/parent/priority/unassigned filters; new note, comment, children, epicStatus, count, config, and doctor methods",
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
    primeContext: {
      description:
        "The bd prime workflow context and git-authority policy text, with its parsed agent.profile",
      schema: PrimeContextSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    outcome: {
      description:
        "A guard failure that wrote nothing (bd exit 13 or an unclaim CAS mismatch), branchable as precondition_failed",
      schema: MutationOutcomeSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    epicStatus: {
      description:
        "An epic's completion status: total/closed children and close eligibility",
      schema: EpicStatusSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    issueCount: {
      description: "A filtered bd issue count, optionally grouped",
      schema: IssueCountSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    bdConfig: {
      description:
        "bd configuration read-back: keys, values, and where each value comes from",
      schema: BdConfigSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    doctorReport: {
      description:
        "A bd doctor diagnostic report, verbatim, including when the storage mode does not support it",
      schema: DoctorReportSchema,
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
        "Update a BD issue (fields, labels, atomic claim via claim: true, or a CAS guard via ifAssignee/ifStatus)",
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
    prime: {
      description:
        "Capture the bd prime workflow context and git-authority policy as a resource",
      arguments: PrimeArgsSchema,
      execute: (
        args: Record<string, unknown>,
        ctx: Parameters<typeof primeContext>[1],
      ) => primeContext(args, ctx),
    },
    note: {
      description:
        "Append a note to a BD issue (append-only; earlier notes survive)",
      arguments: NoteArgsSchema,
      execute: (
        args: Record<string, unknown>,
        ctx: Parameters<typeof noteIssue>[1],
      ) => noteIssue(args, ctx),
    },
    comment: {
      description: "Append a comment to a BD issue",
      arguments: CommentArgsSchema,
      execute: (
        args: Record<string, unknown>,
        ctx: Parameters<typeof commentIssue>[1],
      ) => commentIssue(args, ctx),
    },
    heartbeat: {
      description:
        "Refresh the lease on BD issues you hold in_progress (owner only)",
      arguments: HeartbeatArgsSchema,
      execute: (
        args: Record<string, unknown>,
        ctx: Parameters<typeof heartbeatIssues>[1],
      ) => heartbeatIssues(args, ctx),
    },
    unclaim: {
      description:
        "Release BD claims, optionally only while still held by a given assignee (compare-and-swap; never --force)",
      arguments: UnclaimArgsSchema,
      execute: (
        args: Record<string, unknown>,
        ctx: Parameters<typeof unclaimIssues>[1],
      ) => unclaimIssues(args, ctx),
    },
    children: {
      description:
        "List every child of a BD parent issue, including closed children",
      arguments: ChildrenArgsSchema,
      execute: (
        args: Record<string, unknown>,
        ctx: Parameters<typeof childrenIssues>[1],
      ) => childrenIssues(args, ctx),
    },
    epicStatus: {
      description:
        "Report BD epic completion: total/closed children and close eligibility",
      arguments: EpicStatusArgsSchema,
      execute: (
        args: Record<string, unknown>,
        ctx: Parameters<typeof epicStatuses>[1],
      ) => epicStatuses(args, ctx),
    },
    count: {
      description: "Count BD issues matching filters, optionally grouped",
      arguments: CountArgsSchema,
      execute: (
        args: Record<string, unknown>,
        ctx: Parameters<typeof countIssues>[1],
      ) => countIssues(args, ctx),
    },
    config: {
      description:
        "Read bd configuration: one key, or every effective key with its source",
      arguments: ConfigArgsSchema,
      execute: (
        args: Record<string, unknown>,
        ctx: Parameters<typeof readConfig>[1],
      ) => readConfig(args, ctx),
    },
    doctor: {
      description:
        "Capture bd doctor diagnostics (read-only; never repairs or runs setup)",
      arguments: DoctorArgsSchema,
      execute: (
        args: Record<string, unknown>,
        ctx: Parameters<typeof doctorReport>[1],
      ) => doctorReport(args, ctx),
    },
  },
};
