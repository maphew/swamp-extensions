/**
 * @maphew/retro — Agent Session Retrospective.
 *
 * Mines past coding-agent sessions (Claude Code, Codex CLI, Amp) for evidence
 * about how a human and their agents work together, and maintains a
 * cumulative, evidence-backed findings register across rounds. This is the
 * swamp port of the "Agent Session Retrospective Playbook": the mechanical
 * phases (inventory, strip, ledger, register) live here as data; the two
 * judgment steps (per-session digest, batch synthesis) call a language model.
 *
 * Methods:
 *   - `inventory`   scan session stores into a ledger; select the next batch
 *   - `strip`       mechanically condense the batch's transcripts (no LLM)
 *   - `digest`      one rubric-driven LLM call per stripped session
 *   - `synthesize`  merge batch digests into the findings register (LLM)
 *   - `promote`     route actionable findings to their durable homes (no LLM)
 *   - `status`      summarize ledger and register coverage
 *
 * The register and ledger are written both as swamp resources (queryable,
 * CEL-referenceable) and as markdown/TSV mirror files under `retroDir`.
 * Transcript digests are privacy-sensitive: keep `retroDir/digests/` untracked.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------- taxonomy --------------------------------------------------------

/** Improvement dimensions; every finding is tagged with exactly one. */
export const TAXONOMY = [
  "prompting-pattern",
  "under-specified",
  "over-specified",
  "missing-skill",
  "detrimental-skill",
  "missing-tool",
  "bad-tool",
  "mishandled-tool",
  "tokenomics",
  "model-task-mismatch",
  "process",
  "environment",
  "win",
] as const;

/** Where an actionable finding's durable change belongs (playbook Phase 4). */
export const TAG_HOME: Record<(typeof TAXONOMY)[number], string> = {
  "prompting-pattern": "Prompt cookbook (top of findings.md)",
  "under-specified": "Prompt cookbook (top of findings.md)",
  "over-specified": "Prompt cookbook (top of findings.md)",
  "missing-skill": "Skill repository (create the skill; note trigger phrase)",
  "detrimental-skill": "Skill repository (fix or retire the skill)",
  "missing-tool": "Script it, adopt it, or file it in the issue tracker",
  "bad-tool": "Upstream issue + local workaround",
  "mishandled-tool": "AGENTS.md / CLAUDE.md behavior rule",
  "tokenomics": "AGENTS.md / CLAUDE.md behavior rule",
  "model-task-mismatch": "Delegation-tier table",
  "process": "AGENTS.md / CLAUDE.md + issue tracker",
  "environment": "Runtime settings (allowlists, hooks, wrappers)",
  "win": "Prompt cookbook / standardize the pattern",
};

/** Runtimes this model can inventory. */
export const RUNTIMES = ["claude-code", "codex", "amp"] as const;
export type Runtime = (typeof RUNTIMES)[number];

/** Ledger status vocabulary (playbook Phase 1). */
export const LEDGER_STATUS = [
  "pending",
  "skipped-trivial",
  "skipped-subagent",
  "skipped-inflight",
  "lost",
  "digested",
  "synthesized",
] as const;
export type LedgerStatus = (typeof LEDGER_STATUS)[number];

/** Finding lifecycle (playbook Phase 3). */
export const FINDING_STATUS = [
  "candidate",
  "recurring",
  "promoted",
  "verified-fixed",
  "retired",
] as const;

// ---------- schemas ---------------------------------------------------------

/** Global arguments configuring stores, batching, and the analysis model. */
export const GlobalArgsSchema = z.object({
  scope: z.string().default("all").describe(
    "Campaign scope label written to ledger rows",
  ),
  runtimes: z.string().default("claude-code").describe(
    "Comma-separated runtimes to inventory: claude-code, codex, amp",
  ),
  retroDir: z.string().default("retro").describe(
    "Directory for mirror state files (ledger.tsv, findings.md, batches/, digests/)",
  ),
  home: z.string().default("").describe("Home directory; defaults to $HOME"),
  projectsDir: z.string().default("").describe(
    "Claude Code projects dir; defaults to <home>/.claude/projects",
  ),
  codexSessionsDir: z.string().default("").describe(
    "Codex sessions dir; defaults to <home>/.codex/sessions",
  ),
  ampThreadsDir: z.string().default("").describe(
    "Amp threads dir; defaults to <home>/.local/share/amp/threads",
  ),
  sinceDays: z.number().int().nonnegative().default(0).describe(
    "Only consider sessions started within N days (0 = all history)",
  ),
  minSizeKb: z.number().int().positive().default(100).describe(
    "Claude/Codex transcripts below this size are skipped-trivial",
  ),
  minMessages: z.number().int().positive().default(8).describe(
    "Amp threads below this many messages are skipped-trivial",
  ),
  inflightMinutes: z.number().int().positive().default(10).describe(
    "Transcripts modified within this window are treated as the in-flight session",
  ),
  batchSize: z.number().int().positive().default(5).describe(
    "Sessions assessed together per round",
  ),
  includeScopes: z.string().default("").describe(
    "Comma-separated glob patterns; when set only matching scopes are inventoried",
  ),
  excludeScopes: z.string().default("").describe(
    "Comma-separated glob patterns; matching scopes are skipped",
  ),
  maxCharsPerSession: z.number().int().positive().default(120000).describe(
    "Per-session character cap on condensed transcript text",
  ),
  provider: z.enum(["anthropic", "command"]).default("anthropic").describe(
    "How to reach the analysis model: 'anthropic' Messages API or a shell 'command'",
  ),
  apiKey: z.string().meta({ sensitive: true }).default("").describe(
    "Anthropic API key (provider=anthropic)",
  ),
  apiUrl: z.string().default("https://api.anthropic.com/v1/messages").describe(
    "Anthropic Messages endpoint",
  ),
  model: z.string().default("claude-sonnet-4-5").describe(
    "Model for batch synthesis. Pin explicitly — model IDs retire over time.",
  ),
  digestModel: z.string().default("").describe(
    "Model for per-session digests; defaults to `model`. Use a cheap tier here.",
  ),
  maxTokens: z.number().int().positive().default(4096).describe(
    "Max tokens per model response",
  ),
  command: z.string().default("").describe(
    "provider=command: shell command that reads the prompt on stdin and writes the reply to stdout",
  ),
  seedRegisterFile: z.string().default("").describe(
    "Optional JSON file seeding the findings register on first run",
  ),
});

export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** One ledger row: a single known session. */
export const LedgerRowSchema = z.object({
  scope: z.string(),
  runtime: z.string(),
  sessionId: z.string(),
  started: z.string(),
  sizeKb: z.number(),
  status: z.string(),
  batch: z.number().int().nonnegative().default(0),
  note: z.string().default(""),
});

export type LedgerRow = z.infer<typeof LedgerRowSchema>;

const LedgerSchema = z.object({
  generatedAt: z.string(),
  rows: z.array(LedgerRowSchema),
});

const BatchSchema = z.object({
  round: z.number().int().positive(),
  size: z.number().int().nonnegative(),
  createdAt: z.string(),
  sessions: z.array(LedgerRowSchema),
});

const StateSchema = z.object({
  currentRound: z.number().int().nonnegative(),
  updatedAt: z.string(),
});

/** A mechanically condensed transcript turn. */
export type Turn = {
  role: "user" | "assistant";
  ts?: string;
  text: string;
  tools?: string[];
  errors?: string[];
};

const StrippedSchema = z.object({
  runtime: z.string(),
  sessionId: z.string(),
  scope: z.string(),
  started: z.string(),
  turns: z.number(),
  chars: z.number(),
  truncated: z.boolean(),
  content: z.string(),
});

const FrictionSchema = z.object({
  tag: z.string(),
  severity: z.enum(["H", "M", "L"]).default("M"),
  quote: z.string().default(""),
  cost: z.string().default(""),
});

/** A per-session digest (playbook Phase 2b). */
const DigestSchema = z.object({
  runtime: z.string(),
  sessionId: z.string(),
  scope: z.string(),
  date: z.string().default(""),
  models: z.string().default(""),
  outcome: z.enum([
    "done-verified",
    "done",
    "partial",
    "abandoned",
    "unclear",
  ]).default("unclear"),
  effectiveness: z.number().int().min(1).max(5).default(3),
  task: z.string().default(""),
  friction: z.array(FrictionSchema).default([]),
  wins: z.array(z.string()).default([]),
  delegation: z.string().default(""),
  userStyle: z.array(z.string()).default([]),
  recs: z.array(z.object({ tag: z.string(), text: z.string() })).default([]),
});

/** A cumulative finding (playbook Phase 3). */
export const FindingSchema = z.object({
  id: z.string(),
  tag: z.string(),
  title: z.string(),
  status: z.enum([
    "candidate",
    "recurring",
    "promoted",
    "verified-fixed",
    "retired",
  ]).default("candidate"),
  sightings: z.number().int().nonnegative().default(1),
  evidence: z.array(z.string()).default([]),
  cost: z.string().default(""),
  recommendation: z.string().default(""),
  promotedTo: z.string().default(""),
  verifyBy: z.string().default(""),
});

export type Finding = z.infer<typeof FindingSchema>;

const RegisterSchema = z.object({
  updatedAt: z.string(),
  findings: z.array(FindingSchema),
});

const RoundSchema = z.object({
  round: z.number().int().positive(),
  createdAt: z.string(),
  sessions: z.array(z.string()),
  effectiveness: z.array(z.object({ session: z.string(), score: z.number() })),
  newFindings: z.array(z.string()),
  recurrences: z.array(z.string()),
  promotions: z.array(z.string()),
  processNotes: z.string().default(""),
});

const RecommendationSchema = z.object({
  findingId: z.string(),
  tag: z.string(),
  title: z.string(),
  route: z.string(),
  recommendation: z.string(),
  verifyBy: z.string(),
});

// ---------- pure helpers ----------------------------------------------------

/** Split a comma-separated list, trimming blanks. */
export function parseCsv(csv: string): string[] {
  return csv.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Whether any glob pattern (`*` = any run) matches any candidate value. */
export function globMatch(patterns: string[], values: string[]): boolean {
  return patterns.some((pattern) => {
    const re = new RegExp(
      "^" +
        pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*") +
        "$",
      "i",
    );
    return values.some((v) => re.test(v));
  });
}

/** Turn a Claude Code project slug into a friendly scope label. */
export function scopeFromSlug(slug: string): string {
  const parts = slug.replace(/^-/, "").split("-").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : slug;
}

/** Kebab-case slug, capped to a safe length. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    .slice(0, 64) || "x";
}

/** Stable per-session name used for stripped/digest resources. */
export function sessionName(runtime: string, id: string): string {
  return `${runtime}-${id.replace(/-/g, "").slice(0, 8)}`;
}

/** Short 8-char session id used in human-facing labels. */
export function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}

/** Zero-padded round label, e.g. 3 -> "round-03". */
export function roundLabel(round: number): string {
  return `round-${String(round).padStart(2, "0")}`;
}

// Resource instance names are unique per model, so each spec gets its own
// prefix; stripping the spec into the name avoids cross-spec collisions that
// would otherwise make a later read parse the wrong schema.
/** Resource instance name for a stripped transcript. */
export function strippedResName(runtime: string, id: string): string {
  return `stripped-${sessionName(runtime, id)}`;
}

/** Resource instance name for a session digest. */
export function digestResName(runtime: string, id: string): string {
  return `digest-${sessionName(runtime, id)}`;
}

/** Resource instance name for a round's batch selection. */
export function batchResName(round: number): string {
  return `batch-${String(round).padStart(2, "0")}`;
}

/** Resource instance name for a round's synthesis summary. */
export function roundResName(round: number): string {
  return `round-${String(round).padStart(2, "0")}`;
}

/** Collect text/tool/error signal from a content block array (Claude, Amp). */
export function blocksToParts(
  blocks: unknown,
  textCap: number,
  toolCap = 120,
): { text: string; tools: string[]; errors: string[] } {
  let text = "";
  const tools: string[] = [];
  const errors: string[] = [];
  if (typeof blocks === "string") {
    return { text: blocks.slice(0, textCap), tools, errors };
  }
  if (!Array.isArray(blocks)) return { text, tools, errors };
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const type = b.type;
    if (type === "text" || type === "input_text" || type === "output_text") {
      text += String(b.text ?? "");
    } else if (type === "tool_use") {
      tools.push(
        `${String(b.name ?? "tool")}: ${jsonPreview(b.input, toolCap)}`,
      );
    } else if (type === "tool_result" && b.is_error === true) {
      errors.push(jsonPreview(b.content, 300));
    }
  }
  return { text: text.slice(0, textCap), tools, errors };
}

/** Compact JSON preview, capped. */
export function jsonPreview(value: unknown, cap: number): string {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return (s ?? "").replace(/\s+/g, " ").slice(0, cap);
}

/** Condense a Claude Code transcript (JSONL) into turns. */
export function stripClaudeCode(raw: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    const type = o.type;
    if (type !== "user" && type !== "assistant") continue;
    const msg = (o.message ?? {}) as Record<string, unknown>;
    const role = type as "user" | "assistant";
    const cap = role === "user" ? 2500 : 1500;
    const { text, tools, errors } = blocksToParts(msg.content, cap);
    if (!text.trim() && tools.length === 0 && errors.length === 0) continue;
    turns.push({
      role,
      ts: o.timestamp as string | undefined,
      text: text.trim(),
      tools: tools.length ? tools : undefined,
      errors: errors.length ? errors : undefined,
    });
  }
  return turns;
}

/** Condense a Codex CLI rollout (JSONL) into turns. */
export function stripCodex(raw: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    const p = (o.payload ?? {}) as Record<string, unknown>;
    const ts = o.timestamp as string | undefined;
    const ptype = p.type;
    if (ptype === "message") {
      const role = p.role;
      if (role !== "user" && role !== "assistant") continue; // drop developer/system
      const { text, errors } = blocksToParts(
        p.content,
        role === "user" ? 2500 : 1500,
      );
      if (!text.trim()) continue;
      turns.push({
        role,
        ts,
        text: text.trim(),
        errors: errors.length ? errors : undefined,
      });
    } else if (ptype === "agent_message") {
      const text = String(p.message ?? "").trim();
      if (text) {
        turns.push({ role: "assistant", ts, text: text.slice(0, 1500) });
      }
    } else if (ptype === "function_call") {
      turns.push({
        role: "assistant",
        ts,
        text: "",
        tools: [
          `${String(p.name ?? "tool")}: ${jsonPreview(p.arguments, 120)}`,
        ],
      });
    } else if (ptype === "function_call_output") {
      const out = String(p.output ?? "");
      const m = out.match(/Process exited with code (\d+)/);
      if (m && m[1] !== "0") {
        turns.push({
          role: "assistant",
          ts,
          text: "",
          errors: [`exit ${m[1]}: ${out.replace(/\s+/g, " ").slice(0, 300)}`],
        });
      }
    }
  }
  // Codex mirrors each agent turn as both `agent_message` and an assistant
  // `message` with identical text; collapse the echo.
  const out: Turn[] = [];
  for (const t of turns) {
    const prev = out[out.length - 1];
    if (
      t.role === "assistant" && t.text && prev?.role === "assistant" &&
      prev.text === t.text
    ) {
      continue;
    }
    out.push(t);
  }
  return out;
}

/** Condense an Amp thread (JSON) into turns. */
export function stripAmp(raw: string): Turn[] {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!o || typeof o !== "object") return [];
  const messages = Array.isArray(o.messages) ? o.messages : [];
  const turns: Turn[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const role = rec.role;
    if (role !== "user" && role !== "assistant") continue;
    const { text, tools, errors } = blocksToParts(
      rec.content,
      role === "user" ? 2500 : 1500,
    );
    if (!text.trim() && tools.length === 0 && errors.length === 0) continue;
    turns.push({
      role,
      text: text.trim(),
      tools: tools.length ? tools : undefined,
      errors: errors.length ? errors : undefined,
    });
  }
  return turns;
}

/** Condense a transcript with the adapter for its runtime. */
export function stripFor(runtime: string, raw: string): Turn[] {
  switch (runtime) {
    case "claude-code":
      return stripClaudeCode(raw);
    case "codex":
      return stripCodex(raw);
    case "amp":
      return stripAmp(raw);
    default:
      return [];
  }
}

/** Render turns to the digest input text, eliding the middle when over cap. */
export function renderTurns(
  turns: Turn[],
  maxChars: number,
): { content: string; chars: number; truncated: boolean } {
  const lines: string[] = [];
  for (const t of turns) {
    if (t.text) {
      lines.push(`${t.role === "user" ? "USER" : "ASSISTANT"}: ${t.text}`);
    }
    for (const tool of t.tools ?? []) lines.push(`  [tool] ${tool}`);
    for (const err of t.errors ?? []) lines.push(`  [err] ${err}`);
  }
  let content = lines.join("\n");
  let truncated = false;
  if (content.length > maxChars) {
    truncated = true;
    const head = Math.floor(maxChars * 0.4);
    const tail = maxChars - head;
    content = `${content.slice(0, head)}\n…[middle elided]…\n${
      content.slice(content.length - tail)
    }`;
  }
  return { content, chars: content.length, truncated };
}

/** Extract the first JSON object/array from a model reply. */
export function extractJson(text: string, kind: "object" | "array"): unknown {
  let t = text.trim();
  try {
    const direct = JSON.parse(t);
    if (kind === "array" ? Array.isArray(direct) : !Array.isArray(direct)) {
      return direct;
    }
  } catch { /* fall through */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const open = kind === "array" ? "[" : "{";
  const close = kind === "array" ? "]" : "}";
  const start = t.indexOf(open);
  const end = t.lastIndexOf(close);
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Render a digest as markdown for the (untracked) digests directory. */
export function digestToMarkdown(d: z.infer<typeof DigestSchema>): string {
  const out: string[] = [];
  out.push(
    `# ${d.runtime}/${shortId(d.sessionId)} — ${d.date || "?"} — ${d.scope}`,
  );
  out.push(
    `meta: model(s) ${
      d.models || "?"
    } | outcome ${d.outcome} | effectiveness ${d.effectiveness}/5`,
  );
  out.push(`\ntask: ${d.task || "(none recorded)"}`);
  out.push(`\nfriction:`);
  if (d.friction.length === 0) out.push("- (none)");
  for (const f of d.friction) {
    out.push(
      `- [${f.tag}] [${f.severity}] ${f.quote || "(no quote — weak)"}${
        f.cost ? ` (cost: ${f.cost})` : ""
      }`,
    );
  }
  if (d.wins.length) {
    out.push(`\nwins:`);
    for (const w of d.wins) out.push(`- [win] ${w}`);
  }
  if (d.delegation) out.push(`\ndelegation: ${d.delegation}`);
  if (d.userStyle.length) {
    out.push(`\nuser-style:`);
    for (const u of d.userStyle) out.push(`- ${u}`);
  }
  if (d.recs.length) {
    out.push(`\nrecs:`);
    for (const r of d.recs) out.push(`- [${r.tag}] ${r.text}`);
  }
  return out.join("\n") + "\n";
}

/** Render the findings register as findings.md. */
export function registerToMarkdown(
  findings: Finding[],
  promptCookbook: string[] = [],
): string {
  const out: string[] = [];
  out.push("# Findings Register");
  out.push("");
  out.push(
    "Cumulative, evidence-backed findings about how the human and their coding agents work together. Maintained per the retro playbook Phases 3-4.",
  );
  out.push("");
  out.push(
    "Status lifecycle: `candidate` (1 sighting) → `recurring` (2+) → `promoted` (change made) → `verified-fixed` | `retired`.",
  );
  out.push("");
  out.push("## Prompt cookbook");
  out.push("");
  if (promptCookbook.length === 0) out.push("_(none yet)_");
  for (const p of promptCookbook) out.push(`- ${p}`);
  out.push("");
  out.push("## Findings");
  out.push("");
  for (const f of findings) {
    out.push(`### ${f.id} · [${f.tag}] ${f.title}`);
    out.push(`- status: ${f.status}`);
    out.push(`- sightings: ${f.sightings}`);
    for (const e of f.evidence) out.push(`  - ${e}`);
    if (f.cost) out.push(`- cost: ${f.cost}`);
    if (f.recommendation) out.push(`- recommendation: ${f.recommendation}`);
    if (f.promotedTo) out.push(`- promoted-to: ${f.promotedTo}`);
    if (f.verifyBy) out.push(`- verify-by: ${f.verifyBy}`);
    out.push("");
  }
  return out.join("\n");
}

/** Render a round/batch summary as batches/round-NN.md. */
export function batchToMarkdown(r: z.infer<typeof RoundSchema>): string {
  const out: string[] = [];
  out.push(`# ${roundLabel(r.round)} — sessions assessed`);
  out.push("");
  out.push(`generated: ${r.createdAt}`);
  out.push("");
  out.push("## Sessions");
  for (const s of r.sessions) out.push(`- ${s}`);
  out.push("");
  out.push("## Effectiveness");
  for (const e of r.effectiveness) out.push(`- ${e.session}: ${e.score}/5`);
  out.push("");
  out.push("## New findings");
  for (const n of r.newFindings) out.push(`- ${n}`);
  if (r.newFindings.length === 0) out.push("- (none)");
  out.push("");
  out.push("## Recurrences");
  for (const n of r.recurrences) out.push(`- ${n}`);
  if (r.recurrences.length === 0) out.push("- (none)");
  out.push("");
  out.push("## Promotions proposed");
  for (const n of r.promotions) out.push(`- ${n}`);
  if (r.promotions.length === 0) out.push("- (none)");
  out.push("");
  if (r.processNotes) {
    out.push("## Process notes (on the retro itself)");
    out.push("");
    out.push(r.processNotes);
    out.push("");
  }
  return out.join("\n");
}

/** Serialize ledger rows to TSV with a header. */
export function ledgerToTsv(rows: LedgerRow[]): string {
  const header =
    "scope\truntime\tsession_id\tstarted\tsize_kb\tstatus\tbatch\tnote";
  const lines = rows.map((r) =>
    [
      r.scope,
      r.runtime,
      r.sessionId,
      r.started,
      String(r.sizeKb),
      r.status,
      r.batch ? String(r.batch) : "",
      r.note,
    ].join("\t")
  );
  return [header, ...lines].join("\n") + "\n";
}

/** Parse a ledger TSV produced by `ledgerToTsv`. */
export function parseLedgerTsv(text: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const [scope, runtime, sessionId, started, sizeKb, status, batch, note] =
      line.split("\t");
    if (!sessionId) continue;
    rows.push(
      LedgerRowSchema.parse({
        scope: scope ?? "",
        runtime: runtime ?? "",
        sessionId,
        started: started ?? "",
        sizeKb: Number(sizeKb ?? 0),
        status: status ?? "pending",
        batch: Number(batch || 0),
        note: note ?? "",
      }),
    );
  }
  return rows;
}

/** Key identifying one session across the ledger. */
export function ledgerKey(r: {
  runtime: string;
  sessionId: string;
}): string {
  return `${r.runtime}:${r.sessionId}`;
}

/**
 * Merge freshly discovered rows into an existing ledger.
 *
 * Settled rows (`digested`, `synthesized`, `skipped-subagent`) keep their
 * status; everything else takes the freshly observed status so a transcript
 * that was in-flight or trivial last time can become `pending` once it settles
 * or grows. A row still `pending` but no longer on disk becomes `lost` — but
 * only for runtimes that were actually scanned, so a transiently unreadable
 * store root cannot wipe the ledger.
 */
export function mergeLedger(
  existing: LedgerRow[],
  discovered: LedgerRow[],
  scannedRuntimes?: Set<string>,
): LedgerRow[] {
  const settled = new Set(["digested", "synthesized", "skipped-subagent"]);
  const byKey = new Map(existing.map((r) => [ledgerKey(r), r]));
  const seen = new Set<string>();
  const merged: LedgerRow[] = [];
  for (const d of discovered) {
    const key = ledgerKey(d);
    seen.add(key);
    const prior = byKey.get(key);
    if (!prior) {
      merged.push(d);
      continue;
    }
    merged.push({
      ...d,
      batch: prior.batch,
      status: settled.has(prior.status) ? prior.status : d.status,
      note: prior.note || d.note,
      sizeKb: d.sizeKb,
    });
  }
  for (const r of existing) {
    const key = ledgerKey(r);
    if (seen.has(key)) continue;
    const scanned = !scannedRuntimes || scannedRuntimes.has(r.runtime);
    if (
      scanned && (r.status === "pending" || r.status === "skipped-inflight")
    ) {
      merged.push({
        ...r,
        status: "lost",
        note: r.note || "transcript no longer on disk",
      });
    } else {
      merged.push(r);
    }
  }
  merged.sort((
    a,
    b,
  ) => (a.started < b.started ? 1 : a.started > b.started ? -1 : 0));
  return merged;
}

/** Take the next `batchSize` pending rows (newest-first). */
export function nextBatch(
  rows: LedgerRow[],
  batchSize: number,
): LedgerRow[] {
  return rows.filter((r) => r.status === "pending").slice(0, batchSize);
}

/** Mark only the selected rows with their round number. */
export function markBatch(
  rows: LedgerRow[],
  selected: LedgerRow[],
  round: number,
): LedgerRow[] {
  const keys = new Set(selected.map((r) => ledgerKey(r)));
  return rows.map((r) => keys.has(ledgerKey(r)) ? { ...r, batch: round } : r);
}

/** Findings that are actionable and not yet promoted (playbook Phase 4). */
export function pickActionable(findings: Finding[]): Finding[] {
  return findings.filter((f) =>
    (f.status === "recurring" || f.status === "promoted") &&
    f.sightings >= 2 &&
    !f.promotedTo &&
    f.tag !== "win"
  );
}

/** The durable home for a finding, by tag. */
export function routeForTag(tag: string): string {
  return (TAG_HOME as Record<string, string>)[tag] ??
    "Review manually (unrecognized tag)";
}

// ---------- model calls -----------------------------------------------------

/** POST a single-turn prompt to the Anthropic Messages API. */
export async function callAnthropic(
  cfg: {
    apiUrl: string;
    apiKey: string;
    model: string;
    maxTokens: number;
  },
  system: string,
  prompt: string,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  if (!cfg.apiKey) {
    throw new Error("apiKey is required when provider=anthropic");
  }
  const res = await fetchFn(cfg.apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Anthropic API error (${res.status}): ${await res.text()}`);
  }
  const body = await res.json();
  return ((body.content ?? []) as Array<Record<string, unknown>>)
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("");
}

/** Run a shell command, feeding the prompt on stdin and reading stdout. */
export async function callCommand(
  command: string,
  system: string,
  prompt: string,
): Promise<string> {
  const proc = new Deno.Command("/bin/sh", {
    args: ["-c", command],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(`${system}\n\n${prompt}`));
  await writer.close();
  const { code, stdout, stderr } = await proc.output();
  const out = new TextDecoder().decode(stdout).trim();
  if (code !== 0 && !out) {
    throw new Error(
      `command provider failed (exit ${code}): ${
        new TextDecoder().decode(stderr).trim().slice(0, 500)
      }`,
    );
  }
  return out;
}

/** Route a prompt to the configured provider. */
export async function callModel(
  cfg: GlobalArgs,
  system: string,
  prompt: string,
  model: string,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  if (cfg.provider === "command") {
    if (!cfg.command) {
      throw new Error("provider=command requires the `command` global arg");
    }
    return await callCommand(cfg.command, system, prompt);
  }
  return await callAnthropic(
    { apiUrl: cfg.apiUrl, apiKey: cfg.apiKey, model, maxTokens: cfg.maxTokens },
    system,
    prompt,
    signal,
    fetchFn,
  );
}

/** The fixed digest rubric prompt (playbook Phase 2b). */
export const DIGEST_SYSTEM =
  "You digest coding-agent session transcripts into evidence-backed JSON. " +
  "Quote real text; never invent. Output only JSON.";

/** Build the digest prompt for one stripped session. */
export function digestPrompt(
  s: z.infer<typeof StrippedSchema>,
): string {
  return `Digest this ${s.runtime} session (id ${s.sessionId}, scope ${s.scope}).

The transcript below is condensed: USER turns are the human's requests;
ASSISTANT turns are truncated; [tool] and [err] lines are tool calls and errors.

Tags: ${TAXONOMY.join(", ")}.

Return ONLY a JSON object with these fields:
{
  "task": "what was asked, 1-3 lines",
  "outcome": "done-verified|done|partial|abandoned|unclear",
  "effectiveness": 1-5,
  "models": "model(s) used if visible, else \\"\\"",
  "friction": [{"tag": "...", "severity": "H|M|L", "quote": "<=25-word real quote", "cost": "who paid and how much"}],
  "wins": ["what worked and why"],
  "delegation": "subagents/exec spawned; tier fit; redos",
  "userStyle": ["phrasings that produced clean runs or confusion, short quotes"],
  "recs": [{"tag": "...", "text": "candidate recommendation"}]
}
A finding with no quote is an impression: still record it but quote "" and keep it out of recs.
High-signal markers: user corrections ("no, I meant", "stop"), permission stalls,
tool-error retry loops, compaction, questions the opening prompt should have answered.

Transcript:
${s.content}`;
}

/** The fixed synthesis system prompt (playbook Phase 3). */
export const SYNTH_SYSTEM =
  "You maintain a cumulative, evidence-backed findings register. Merge new " +
  "batch evidence into existing findings without inventing findings. Output only JSON.";

/** Build the synthesis prompt from digests and the current register. */
export function synthPrompt(
  register: z.infer<typeof RegisterSchema>,
  digests: Array<z.infer<typeof DigestSchema>>,
  round: number,
): string {
  return `You are running retrospective round ${round}. Merge this round's
per-session digests into the cumulative findings register.

Rules:
- A friction/win recurring in a digest matches an existing finding: append the
  new evidence line, bump \`sightings\`, and move \`candidate\` -> \`recurring\`.
- A new friction/win not in the register becomes a new finding with status
  \`candidate\` and sightings 1. Assign the next sequential id (F-NNN).
- For most recent sessions, note whether older friction is absent (that is
  evidence toward \`verified-fixed\`).
- Never delete findings; retire them instead.
- Evidence lines look like: "<runtime>/<id8> (<date>): \\"<=25-word quote\\"".

Current register (JSON):
${JSON.stringify(register.findings)}

Round ${round} digests (JSON):
${JSON.stringify(digests)}

Return ONLY a JSON object:
{
  "findings": [ {id, tag, title, status, sightings, evidence: [..], cost, recommendation, promotedTo, verifyBy} ],
  "processNotes": "notes about the retro itself (rubric gaps, digest quality)"
}`;
}

// ---------- resource/file plumbing -----------------------------------------

async function writeFileEnsured(path: string, text: string): Promise<void> {
  const dir = path.replace(/\/[^/]*$/, "");
  if (dir) await Deno.mkdir(dir, { recursive: true }).catch(() => {});
  await Deno.writeTextFile(path, text);
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walkFiles(full);
    else if (entry.isFile) yield full;
  }
}

// ---------- discovery (Phase 1) --------------------------------------------

interface DiscoverOpts {
  scope: string;
  sinceDays: number;
  minSizeKb: number;
  minMessages: number;
  inflightMinutes: number;
  include: string[];
  exclude: string[];
}

function nowMs(): number {
  return Date.now();
}

function classify(
  sizeKb: number,
  mtimeMs: number,
  opts: DiscoverOpts,
  kind: "size" | "messages",
  messages: number,
  inherentSkip: string,
): LedgerStatus {
  if (inherentSkip) return inherentSkip as LedgerStatus;
  if (nowMs() - mtimeMs <= opts.inflightMinutes * 60_000) {
    return "skipped-inflight";
  }
  if (kind === "size" ? sizeKb < opts.minSizeKb : messages < opts.minMessages) {
    return "skipped-trivial";
  }
  return "pending";
}

function withinWindow(mtimeMs: number, sinceDays: number): boolean {
  if (sinceDays <= 0) return true;
  return nowMs() - mtimeMs <= sinceDays * 24 * 60 * 60 * 1000;
}

function scopeAllowed(label: string, opts: DiscoverOpts): boolean {
  if (opts.include.length > 0 && !globMatch(opts.include, [label])) {
    return false;
  }
  if (globMatch(opts.exclude, [label])) return false;
  return true;
}

async function discoverClaude(
  projectsDir: string,
  opts: DiscoverOpts,
): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  let projects: Deno.DirEntry[];
  try {
    projects = await Array.fromAsync(Deno.readDir(projectsDir));
  } catch {
    return rows;
  }
  for (const proj of projects) {
    if (!proj.isDirectory) continue;
    const label = scopeFromSlug(proj.name);
    if (!scopeAllowed(label, opts)) continue;
    const dir = `${projectsDir}/${proj.name}`;
    let files: Deno.DirEntry[];
    try {
      files = await Array.fromAsync(Deno.readDir(dir));
    } catch {
      continue;
    }
    for (const f of files) {
      // Top-level files only; subdirectories are tool results/sidechains.
      if (!f.isFile || !f.name.endsWith(".jsonl")) continue;
      const full = `${dir}/${f.name}`;
      const st = await Deno.stat(full).catch(() => null);
      if (!st) continue;
      const sizeKb = Math.round((st.size ?? 0) / 1024);
      const mtimeMs = (st.mtime ?? new Date()).getTime();
      if (!withinWindow(mtimeMs, opts.sinceDays)) continue;
      const status = classify(sizeKb, mtimeMs, opts, "size", 0, "");
      rows.push({
        scope: label,
        runtime: "claude-code",
        sessionId: f.name.replace(/\.jsonl$/, ""),
        started: new Date(mtimeMs).toISOString(),
        sizeKb,
        status,
        batch: 0,
        note: status === "skipped-inflight" ? "this session" : "",
      });
    }
  }
  return rows;
}

async function discoverCodex(
  sessionsDir: string,
  opts: DiscoverOpts,
): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  for await (const full of walkFiles(sessionsDir)) {
    if (!/rollout-.*\.jsonl$/.test(full)) continue;
    const st = await Deno.stat(full).catch(() => null);
    if (!st) continue;
    const sizeKb = Math.round((st.size ?? 0) / 1024);
    const mtimeMs = (st.mtime ?? new Date()).getTime();
    if (!withinWindow(mtimeMs, opts.sinceDays)) continue;
    const firstLine = (await readFileOrNull(full))?.split("\n")[0] ?? "";
    let payload: Record<string, unknown> = {};
    try {
      payload = (JSON.parse(firstLine).payload ?? {}) as Record<
        string,
        unknown
      >;
    } catch { /* ignore */ }
    const originator = String(payload.originator ?? "");
    const source = typeof payload.source === "string" ? payload.source : "";
    const idMatch = full.match(/([0-9a-f-]{36})\.jsonl$/);
    const sessionId = idMatch
      ? idMatch[1]
      : full.replace(/.*\//, "").replace(/\.jsonl$/, "");
    const cwd = String(payload.cwd ?? "");
    const label = cwd
      ? cwd.replace(/\/+$/, "").split("/").pop() ?? opts.scope
      : opts.scope;
    if (!scopeAllowed(label, opts)) continue;
    let skip = "";
    if (!(originator === "codex-tui" && source === "cli")) {
      skip = "skipped-subagent";
    }
    const status = classify(sizeKb, mtimeMs, opts, "size", 0, skip);
    rows.push({
      scope: label,
      runtime: "codex",
      sessionId,
      started: new Date(mtimeMs).toISOString(),
      sizeKb,
      status,
      batch: 0,
      note: skip ? `originator=${originator} source=${source || "?"}` : "",
    });
  }
  return rows;
}

async function discoverAmp(
  threadsDir: string,
  opts: DiscoverOpts,
): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  let files: Deno.DirEntry[];
  try {
    files = await Array.fromAsync(Deno.readDir(threadsDir));
  } catch {
    return rows;
  }
  for (const f of files) {
    if (!f.isFile || !f.name.startsWith("T-") || !f.name.endsWith(".json")) {
      continue;
    }
    const full = `${threadsDir}/${f.name}`;
    const st = await Deno.stat(full).catch(() => null);
    if (!st) continue;
    const mtimeMs = (st.mtime ?? new Date()).getTime();
    if (!withinWindow(mtimeMs, opts.sinceDays)) continue;
    let messages = 0;
    let label = opts.scope;
    try {
      const o = JSON.parse(await Deno.readTextFile(full)) as Record<
        string,
        unknown
      >;
      messages = Array.isArray(o.messages) ? o.messages.length : 0;
      if (typeof o.cwd === "string" && o.cwd) {
        label = o.cwd.replace(/\/+$/, "").split("/").pop() ?? label;
      }
    } catch { /* ignore */ }
    if (!scopeAllowed(label, opts)) continue;
    const sizeKb = Math.round((st.size ?? 0) / 1024);
    const status = classify(0, mtimeMs, opts, "messages", messages, "");
    rows.push({
      scope: label,
      runtime: "amp",
      sessionId: f.name.replace(/\.json$/, ""),
      started: new Date(mtimeMs).toISOString(),
      sizeKb,
      status,
      batch: 0,
      note: `${messages} messages`,
    });
  }
  return rows;
}

async function dirReadable(dir: string): Promise<boolean> {
  try {
    const st = await Deno.stat(dir);
    return st.isDirectory;
  } catch {
    return false;
  }
}

async function discover(
  cfg: GlobalArgs,
  home: string,
): Promise<{ rows: LedgerRow[]; scanned: Set<string> }> {
  const opts: DiscoverOpts = {
    scope: cfg.scope,
    sinceDays: cfg.sinceDays,
    minSizeKb: cfg.minSizeKb,
    minMessages: cfg.minMessages,
    inflightMinutes: cfg.inflightMinutes,
    include: parseCsv(cfg.includeScopes),
    exclude: parseCsv(cfg.excludeScopes),
  };
  const runtimes = parseCsv(cfg.runtimes);
  const out: LedgerRow[] = [];
  const scanned = new Set<string>();
  if (runtimes.includes("claude-code")) {
    const dir = cfg.projectsDir || `${home}/.claude/projects`;
    if (await dirReadable(dir)) {
      scanned.add("claude-code");
      out.push(...await discoverClaude(dir, opts));
    }
  }
  if (runtimes.includes("codex")) {
    const dir = cfg.codexSessionsDir || `${home}/.codex/sessions`;
    if (await dirReadable(dir)) {
      scanned.add("codex");
      out.push(...await discoverCodex(dir, opts));
    }
  }
  if (runtimes.includes("amp")) {
    const dir = cfg.ampThreadsDir || `${home}/.local/share/amp/threads`;
    if (await dirReadable(dir)) {
      scanned.add("amp");
      out.push(...await discoverAmp(dir, opts));
    }
  }
  return { rows: out, scanned };
}

// ---------- method context --------------------------------------------------

interface MethodCtx {
  globalArgs: GlobalArgs;
  signal?: AbortSignal;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  readResource: (
    instance: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
}

async function readResourceSafe(
  ctx: MethodCtx,
  name: string,
): Promise<Record<string, unknown> | null> {
  try {
    return await ctx.readResource(name);
  } catch {
    return null;
  }
}

// ---------- methods ---------------------------------------------------------

async function inventory(
  _args: Record<string, never>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const home = cfg.home || Deno.env.get("HOME") || "";
  const { rows: discovered, scanned } = await discover(cfg, home);

  const priorLedger = await readResourceSafe(ctx, "ledger");
  let existing: LedgerRow[] = priorLedger
    ? LedgerSchema.parse(priorLedger).rows
    : [];
  if (existing.length === 0) {
    const tsv = await readFileOrNull(`${cfg.retroDir}/ledger.tsv`);
    if (tsv) existing = parseLedgerTsv(tsv);
  }

  const merged = mergeLedger(existing, discovered, scanned);
  const maxRound = merged.reduce((m, r) => Math.max(m, r.batch), 0);
  const selected = nextBatch(merged, cfg.batchSize);
  const pending = merged.filter((r) => r.status === "pending").length;

  if (selected.length === 0) {
    const ledgerHandle = await ctx.writeResource("ledger", "ledger", {
      generatedAt: new Date().toISOString(),
      rows: merged,
    });
    await writeFileEnsured(`${cfg.retroDir}/ledger.tsv`, ledgerToTsv(merged));
    ctx.logger.info(
      "Inventory: {total} rows, {pending} pending; next batch is empty",
      { total: merged.length, pending },
    );
    return { dataHandles: [ledgerHandle] };
  }

  const round = maxRound + 1;
  const rows = markBatch(merged, selected, round);
  const batch = selected.map((r) => ({ ...r, batch: round }));
  const ledgerHandle = await ctx.writeResource("ledger", "ledger", {
    generatedAt: new Date().toISOString(),
    rows,
  });
  await ctx.writeResource("state", "state", {
    currentRound: round,
    updatedAt: new Date().toISOString(),
  });
  const batchHandle = await ctx.writeResource("batch", batchResName(round), {
    round,
    size: batch.length,
    createdAt: new Date().toISOString(),
    sessions: batch,
  });
  await writeFileEnsured(`${cfg.retroDir}/ledger.tsv`, ledgerToTsv(rows));

  ctx.logger.info(
    "Inventory: {total} rows, {pending} pending; round {round} took {n}",
    { total: rows.length, pending, round, n: batch.length },
  );
  return { dataHandles: [ledgerHandle, batchHandle] };
}

async function strip(
  _args: Record<string, never>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const state = await readResourceSafe(ctx, "state");
  if (!state) throw new Error("No state — run `inventory` first");
  const round = StateSchema.parse(state).currentRound;
  const batchRaw = await readResourceSafe(ctx, batchResName(round));
  if (!batchRaw) {
    throw new Error(`No batch for ${roundLabel(round)} — run \`inventory\``);
  }
  const batch = BatchSchema.parse(batchRaw);

  const home = cfg.home || Deno.env.get("HOME") || "";
  const dirFor = (runtime: string): string =>
    runtime === "claude-code"
      ? (cfg.projectsDir || `${home}/.claude/projects`)
      : runtime === "codex"
      ? (cfg.codexSessionsDir || `${home}/.codex/sessions`)
      : (cfg.ampThreadsDir || `${home}/.local/share/amp/threads`);

  const handles: Array<{ name: string }> = [];
  for (const s of batch.sessions) {
    if (ctx.signal?.aborted) break;
    const file = await locateTranscript(s, dirFor(s.runtime));
    if (!file) {
      ctx.logger.error("Transcript missing for {runtime}/{id}", {
        runtime: s.runtime,
        id: s.sessionId,
      });
      continue;
    }
    const raw = await Deno.readTextFile(file);
    const turns = stripFor(s.runtime, raw);
    const { content, chars, truncated } = renderTurns(
      turns,
      cfg.maxCharsPerSession,
    );
    const name = strippedResName(s.runtime, s.sessionId);
    handles.push(
      await ctx.writeResource("stripped", name, {
        runtime: s.runtime,
        sessionId: s.sessionId,
        scope: s.scope,
        started: s.started,
        turns: turns.length,
        chars,
        truncated,
        content,
      }),
    );
    await writeFileEnsured(
      `${cfg.retroDir}/digests/work/${name}.stripped.txt`,
      content,
    );
    ctx.logger.info("Stripped {name}: {turns} turns, {chars} chars", {
      name,
      turns: turns.length,
      chars,
    });
  }
  return { dataHandles: handles };
}

/** Find the on-disk transcript for a ledger row (runtime-specific). */
async function locateTranscript(
  row: LedgerRow,
  dir: string,
): Promise<string | null> {
  if (row.runtime === "claude-code") {
    for await (const full of walkFiles(dir)) {
      if (full.endsWith(`/${row.sessionId}.jsonl`)) return full;
    }
    return null;
  }
  if (row.runtime === "codex") {
    for await (const full of walkFiles(dir)) {
      if (full.endsWith(`${row.sessionId}.jsonl`)) return full;
    }
    return null;
  }
  if (row.runtime === "amp") {
    const full = `${dir}/${row.sessionId}.json`;
    return await Deno.stat(full).then(() => full).catch(() => null);
  }
  return null;
}

async function digest(
  _args: Record<string, never>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const state = await readResourceSafe(ctx, "state");
  if (!state) throw new Error("No state — run `inventory` first");
  const round = StateSchema.parse(state).currentRound;
  const batchRaw = await readResourceSafe(ctx, batchResName(round));
  if (!batchRaw) {
    throw new Error(`No batch for ${roundLabel(round)} — run \`inventory\``);
  }
  const batch = BatchSchema.parse(batchRaw);
  const model = cfg.digestModel || cfg.model;
  const handles: Array<{ name: string }> = [];
  for (const s of batch.sessions) {
    if (ctx.signal?.aborted) break;
    const sName = strippedResName(s.runtime, s.sessionId);
    const dName = digestResName(s.runtime, s.sessionId);
    const strippedRaw = await readResourceSafe(ctx, sName);
    if (!strippedRaw) {
      ctx.logger.error("No stripped transcript for {name}; run `strip`", {
        name: sName,
      });
      continue;
    }
    const stripped = StrippedSchema.parse(strippedRaw);
    const reply = await callModel(
      cfg,
      DIGEST_SYSTEM,
      digestPrompt(stripped),
      model,
      ctx.signal,
    );
    const parsed = extractJson(reply, "object");
    if (!parsed) {
      ctx.logger.error("Digest reply was not JSON for {name}", { name: sName });
      continue;
    }
    // Identity fields are authoritative: spread the model output first so it
    // cannot override the runtime/session/scope this digest belongs to.
    const d = DigestSchema.parse({
      ...(parsed as Record<string, unknown>),
      runtime: s.runtime,
      sessionId: s.sessionId,
      scope: s.scope,
    });
    handles.push(await ctx.writeResource("digest", dName, d));
    await writeFileEnsured(
      `${cfg.retroDir}/digests/${sName}.md`,
      digestToMarkdown(d),
    );
    ctx.logger.info("Digested {name}: effectiveness {e}/5", {
      name: dName,
      e: d.effectiveness,
    });
  }
  return { dataHandles: handles };
}

async function synthesize(
  _args: Record<string, never>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const state = await readResourceSafe(ctx, "state");
  if (!state) throw new Error("No state — run `inventory` first");
  const round = StateSchema.parse(state).currentRound;
  const batchRaw = await readResourceSafe(ctx, batchResName(round));
  if (!batchRaw) throw new Error(`No batch for ${roundLabel(round)}`);
  const batch = BatchSchema.parse(batchRaw);

  const digests: Array<z.infer<typeof DigestSchema>> = [];
  const digestedKeys = new Set<string>();
  for (const s of batch.sessions) {
    const raw = await readResourceSafe(
      ctx,
      digestResName(s.runtime, s.sessionId),
    );
    if (raw) {
      digests.push(DigestSchema.parse(raw));
      digestedKeys.add(ledgerKey(s));
    }
  }
  if (digests.length === 0) {
    throw new Error("No digests found for this batch — run `digest` first");
  }

  let register = RegisterSchema.parse(
    await readResourceSafe(ctx, "register") ?? {
      updatedAt: new Date().toISOString(),
      findings: [],
    },
  );
  if (register.findings.length === 0 && cfg.seedRegisterFile) {
    const seed = await readFileOrNull(cfg.seedRegisterFile);
    if (seed) {
      try {
        register = RegisterSchema.parse(JSON.parse(seed));
      } catch { /* ignore malformed seed */ }
    }
  }

  const reply = await callModel(
    cfg,
    SYNTH_SYSTEM,
    synthPrompt(register, digests, round),
    cfg.model,
    ctx.signal,
  );
  const parsed = extractJson(reply, "object") as
    | { findings?: unknown; processNotes?: unknown }
    | null;
  const findings = Array.isArray(parsed?.findings)
    ? parsed!.findings as unknown[]
    : null;
  if (!findings) {
    throw new Error("Synthesis reply did not contain a `findings` array");
  }
  const validated = findings.map((f) => FindingSchema.parse(f));
  if (validated.length === 0 && register.findings.length > 0) {
    throw new Error(
      "Synthesis returned no findings but the register was non-empty — refusing to wipe history",
    );
  }
  const processNotes = typeof parsed?.processNotes === "string"
    ? parsed.processNotes
    : "";

  const updatedAt = new Date().toISOString();
  await ctx.writeResource("register", "register", {
    updatedAt,
    findings: validated,
  });

  const priorIds = new Set(register.findings.map((f) => f.id));
  const newFindings = validated.filter((f) => !priorIds.has(f.id)).map((f) =>
    `${f.id} [${f.tag}] ${f.title}`
  );
  const recurrences = validated
    .filter((f) => priorIds.has(f.id) && f.sightings > 1)
    .map((f) => `${f.id} [${f.tag}] ${f.title} (${f.sightings})`);
  const promotions = pickActionable(validated).map((f) =>
    `${f.id} → ${routeForTag(f.tag)}`
  );

  const roundRec = {
    round,
    createdAt: updatedAt,
    sessions: digests.map((d) => `${d.runtime}/${shortId(d.sessionId)}`),
    effectiveness: digests.map((d) => ({
      session: `${d.runtime}/${shortId(d.sessionId)}`,
      score: d.effectiveness,
    })),
    newFindings,
    recurrences,
    promotions,
    processNotes,
  };
  const handle = await ctx.writeResource(
    "round",
    roundResName(round),
    roundRec,
  );
  await writeFileEnsured(
    `${cfg.retroDir}/batches/${roundLabel(round)}.md`,
    batchToMarkdown(RoundSchema.parse(roundRec)),
  );
  await writeFileEnsured(
    `${cfg.retroDir}/findings.md`,
    registerToMarkdown(validated),
  );

  const ledger = await readResourceSafe(ctx, "ledger");
  if (ledger) {
    const rows = LedgerSchema.parse(ledger).rows.map((r) =>
      digestedKeys.has(ledgerKey(r))
        ? { ...r, status: "synthesized" as LedgerStatus }
        : r
    );
    await ctx.writeResource("ledger", "ledger", {
      generatedAt: updatedAt,
      rows,
    });
    await writeFileEnsured(`${cfg.retroDir}/ledger.tsv`, ledgerToTsv(rows));
  }

  ctx.logger.info(
    "Synthesized round {round}: {n} findings, {new} new, {rec} recurring",
    {
      round,
      n: validated.length,
      new: newFindings.length,
      rec: recurrences.length,
    },
  );
  return { dataHandles: [handle] };
}

async function promote(
  _args: Record<string, never>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const registerRaw = await readResourceSafe(ctx, "register");
  if (!registerRaw) throw new Error("No register — run `synthesize` first");
  const register = RegisterSchema.parse(registerRaw);
  const actionable = pickActionable(register.findings);

  const handles: Array<{ name: string }> = [];
  const md: string[] = ["# Promotion queue", ""];
  for (const f of actionable) {
    const route = routeForTag(f.tag);
    const rec = {
      findingId: f.id,
      tag: f.tag,
      title: f.title,
      route,
      recommendation: f.recommendation || "(none recorded)",
      verifyBy: f.verifyBy ||
        "(unset — a later round must confirm the friction is gone)",
    };
    handles.push(
      await ctx.writeResource("recommendation", `rec-${slugify(f.id)}`, rec),
    );
    md.push(`## ${f.id} · [${f.tag}] ${f.title}`);
    md.push(`- route: ${route}`);
    md.push(`- recommendation: ${rec.recommendation}`);
    md.push(`- verify-by: ${rec.verifyBy}`);
    md.push("");
  }
  await writeFileEnsured(`${cfg.retroDir}/promotions.md`, md.join("\n"));
  ctx.logger.info("Promotion queue: {n} actionable findings", {
    n: actionable.length,
  });
  return { dataHandles: handles };
}

async function status(
  _args: Record<string, never>,
  ctx: MethodCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const ledger = await readResourceSafe(ctx, "ledger");
  const rows = ledger ? LedgerSchema.parse(ledger).rows : [];
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const register = await readResourceSafe(ctx, "register");
  const findings = register ? RegisterSchema.parse(register).findings : [];
  ctx.logger.info("Ledger: {byStatus}", { byStatus });
  ctx.logger.info("Register: {n} findings; {actionable} actionable", {
    n: findings.length,
    actionable: pickActionable(findings).length,
  });
  return { dataHandles: [] };
}

// ---------- model -----------------------------------------------------------

/** Swamp model: mine agent sessions into a cumulative retrospective register. */
export const model = {
  type: "@maphew/retro",
  version: "2026.10.11.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    ledger: {
      description:
        "One row per known session (scope, runtime, id, size, status, batch)",
      schema: LedgerSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    batch: {
      description:
        "The sessions selected for one round (factory, one per round)",
      schema: BatchSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    state: {
      description: "Cursor: the round currently in progress",
      schema: StateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 1,
    },
    stripped: {
      description:
        "A mechanically condensed transcript (factory, one per session)",
      schema: StrippedSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    digest: {
      description: "A per-session digest (factory, one per session)",
      schema: DigestSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    register: {
      description: "The cumulative findings register",
      schema: RegisterSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    round: {
      description: "One batch's synthesis summary (factory, one per round)",
      schema: RoundSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    recommendation: {
      description: "An actionable finding routed to a durable home (factory)",
      schema: RecommendationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    inventory: {
      description:
        "Scan session stores into a ledger and select the next batch of sessions",
      arguments: z.object({}),
      execute: (
        args: Record<string, never>,
        ctx: Parameters<typeof inventory>[1],
      ) => inventory(args, ctx),
    },
    strip: {
      description:
        "Mechanically condense the batch's transcripts (no LLM calls)",
      arguments: z.object({}),
      execute: (
        args: Record<string, never>,
        ctx: Parameters<typeof strip>[1],
      ) => strip(args, ctx),
    },
    digest: {
      description: "One rubric-driven model call per stripped session",
      arguments: z.object({}),
      execute: (
        args: Record<string, never>,
        ctx: Parameters<typeof digest>[1],
      ) => digest(args, ctx),
    },
    synthesize: {
      description:
        "Merge batch digests into the cumulative findings register (model call)",
      arguments: z.object({}),
      execute: (
        args: Record<string, never>,
        ctx: Parameters<typeof synthesize>[1],
      ) => synthesize(args, ctx),
    },
    promote: {
      description:
        "Route actionable findings to their durable homes (no LLM calls)",
      arguments: z.object({}),
      execute: (
        args: Record<string, never>,
        ctx: Parameters<typeof promote>[1],
      ) => promote(args, ctx),
    },
    status: {
      description: "Summarize ledger coverage and register size",
      arguments: z.object({}),
      execute: (
        args: Record<string, never>,
        ctx: Parameters<typeof status>[1],
      ) => status(args, ctx),
    },
  },
};
