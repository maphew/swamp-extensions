/**
 * Tests for the @maphew/retro model.
 *
 * Pure helpers and method plumbing are tested against inline fixtures shaped
 * like real Claude Code, Codex, and Amp session files. No network calls.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import {
  batchResName,
  batchToMarkdown,
  callAnthropic,
  digestToMarkdown,
  extractJson,
  globMatch,
  ledgerToTsv,
  markBatch,
  mergeLedger,
  model,
  nextBatch,
  parseCsv,
  parseLedgerTsv,
  pickActionable,
  registerToMarkdown,
  renderTurns,
  roundLabel,
  routeForTag,
  scopeFromSlug,
  sessionName,
  shortId,
  slugify,
  stripAmp,
  stripClaudeCode,
  stripCodex,
  strippedResName,
} from "./retro.ts";

type Store = Map<string, Record<string, unknown>>;

interface TestCtx {
  globalArgs: Record<string, unknown>;
  store: Store;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  readResource: (
    instance: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
}

function makeCtx(
  globalArgs: Record<string, unknown>,
  store: Store = new Map(),
): TestCtx {
  return {
    globalArgs,
    store,
    writeResource: (_spec, instance, data) => {
      store.set(instance, data as Record<string, unknown>);
      return Promise.resolve({ name: instance });
    },
    readResource: (instance) => Promise.resolve(store.get(instance) ?? null),
    logger: { info: () => {}, error: () => {} },
  };
}

function run(
  method: string,
  ctx: TestCtx,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const fn = (model.methods as unknown as Record<string, {
    execute: (
      a: unknown,
      c: unknown,
    ) => Promise<{ dataHandles: Array<{ name: string }> }>;
  }>)[method].execute;
  return fn({}, ctx);
}

// ---------- fixtures --------------------------------------------------------

const CLAUDE_FIXTURE = [
  `{"type":"last-prompt","leafUuid":"x"}`,
  `{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"content":"do the thing"}}`,
  `{"type":"assistant","timestamp":"2026-01-01T00:01:00Z","message":{"model":"claude-x","content":[{"type":"text","text":"on it"},{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}`,
  `{"type":"user","timestamp":"2026-01-01T00:02:00Z","message":{"content":[{"type":"tool_result","is_error":true,"content":"boom"}]}}`,
  `{"type":"attachment","foo":1}`,
].join("\n");

const CODEX_FIXTURE = [
  `{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"x","originator":"codex-tui","source":"cli","cwd":"/home/me/proj"}}`,
  `{"timestamp":"2026-01-01T00:00:01Z","type":"event","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"instructions"}]}}`,
  `{"timestamp":"2026-01-01T00:00:02Z","type":"event","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"do it"}]}}`,
  `{"timestamp":"2026-01-01T00:00:03Z","type":"event","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"ls\\"}"}}`,
  `{"timestamp":"2026-01-01T00:00:04Z","type":"event","payload":{"type":"function_call_output","output":"Process exited with code 2\\nboom"}}`,
  `{"timestamp":"2026-01-01T00:00:05Z","type":"event","payload":{"type":"agent_message","message":"done"}}`,
  `{"timestamp":"2026-01-01T00:00:05Z","type":"event","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}`,
].join("\n");

const AMP_FIXTURE = JSON.stringify({
  id: "T-1",
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "hello" },
        { type: "tool_use", name: "Read", input: { file: "x" } },
      ],
    },
  ],
});

// ---------- helpers ---------------------------------------------------------

Deno.test("parseCsv and globMatch", () => {
  assertEquals(parseCsv("a, b ,, c"), ["a", "b", "c"]);
  assert(globMatch(["*-proj-*"], ["home-proj-x"]));
  assert(!globMatch(["-Users-me"], ["home-proj-x"]));
});

Deno.test("naming helpers", () => {
  assertEquals(scopeFromSlug("-home-mhw-dev-myswamp"), "myswamp");
  assertEquals(slugify("F-001"), "f-001");
  assertEquals(
    sessionName("claude-code", "abcd-1234-5678"),
    "claude-code-abcd1234",
  );
  assertEquals(roundLabel(3), "round-03");
  assertEquals(shortId("abcd1234-5678"), "abcd1234");
  assertEquals(batchResName(1), "batch-01");
  assertEquals(
    strippedResName("codex", "abcdef12-3456"),
    "stripped-codex-abcdef12",
  );
});

Deno.test("stripClaudeCode extracts user, assistant, tool, and error signal", () => {
  const turns = stripClaudeCode(CLAUDE_FIXTURE);
  assertEquals(turns.length, 3);
  assertEquals(turns[0].role, "user");
  assertEquals(turns[0].text, "do the thing");
  assertEquals(turns[1].role, "assistant");
  assertStringIncludes(turns[1].text, "on it");
  assert(turns[1].tools?.[0]?.startsWith("Bash:"));
  assertEquals(turns[2].errors?.[0], "boom");
});

Deno.test("stripCodex drops developer turns and captures tools and errors", () => {
  const turns = stripCodex(CODEX_FIXTURE);
  assertEquals(turns.map((t) => t.role), [
    "user",
    "assistant",
    "assistant",
    "assistant",
  ]);
  assertEquals(turns[0].text, "do it");
  assert(turns[1].tools?.[0]?.startsWith("exec_command:"));
  assertStringIncludes(turns[2].errors?.[0] ?? "", "exit 2");
  assertEquals(turns[3].text, "done");
});

Deno.test("stripAmp keeps text and tools, drops thinking", () => {
  const turns = stripAmp(AMP_FIXTURE);
  assertEquals(turns.length, 2);
  assertEquals(turns[1].text, "hello");
  assert(turns[1].tools?.[0]?.startsWith("Read:"));
});

Deno.test("renderTurns elides the middle when over cap", () => {
  const turns = Array.from({ length: 100 }, (_, i) => ({
    role: "user" as const,
    text: `line ${i} ${"x".repeat(50)}`,
  }));
  const whole = renderTurns(turns, 1_000_000);
  assert(!whole.truncated);
  const capped = renderTurns(turns, 500);
  assert(capped.truncated);
  assertStringIncludes(capped.content, "[middle elided]");
  assert(capped.content.length <= 520);
});

Deno.test("extractJson handles direct, fenced, and embedded JSON", () => {
  assertEquals(extractJson('{"a":1}', "object"), { a: 1 });
  assertEquals(extractJson("```json\n[1,2]\n```", "array"), [1, 2]);
  assertEquals(extractJson('noise {"b":2} tail', "object"), { b: 2 });
  assertEquals(extractJson("nonsense", "object"), null);
});

// ---------- ledger ----------------------------------------------------------

Deno.test("ledger TSV round-trips", () => {
  const rows = [
    {
      scope: "proj",
      runtime: "claude-code",
      sessionId: "abc",
      started: "2026-01-01T00:00:00Z",
      sizeKb: 120,
      status: "pending",
      batch: 0,
      note: "",
    },
  ];
  assertEquals(parseLedgerTsv(ledgerToTsv(rows)), rows);
});

Deno.test("mergeLedger preserves status and marks vanished pending rows lost", () => {
  const existing = [
    {
      scope: "p",
      runtime: "claude-code",
      sessionId: "keep",
      started: "2026-01-02T00:00:00Z",
      sizeKb: 1,
      status: "digested",
      batch: 1,
      note: "done",
    },
    {
      scope: "p",
      runtime: "claude-code",
      sessionId: "gone",
      started: "2026-01-01T00:00:00Z",
      sizeKb: 1,
      status: "pending",
      batch: 0,
      note: "",
    },
  ];
  const discovered = [
    {
      scope: "p",
      runtime: "claude-code",
      sessionId: "keep",
      started: "2026-01-02T00:00:00Z",
      sizeKb: 2,
      status: "pending",
      batch: 0,
      note: "",
    },
  ];
  const merged = mergeLedger(existing, discovered);
  const keep = merged.find((r) => r.sessionId === "keep")!;
  const gone = merged.find((r) => r.sessionId === "gone")!;
  assertEquals(keep.status, "digested");
  assertEquals(keep.sizeKb, 2);
  assertEquals(gone.status, "lost");
});

Deno.test("nextBatch and assignBatch select newest pending rows", () => {
  const rows = [
    {
      scope: "p",
      runtime: "c",
      sessionId: "old",
      started: "2026-01-01T00:00:00Z",
      sizeKb: 1,
      status: "pending",
      batch: 0,
      note: "",
    },
    {
      scope: "p",
      runtime: "c",
      sessionId: "new",
      started: "2026-01-03T00:00:00Z",
      sizeKb: 1,
      status: "pending",
      batch: 0,
      note: "",
    },
    {
      scope: "p",
      runtime: "c",
      sessionId: "done",
      started: "2026-01-04T00:00:00Z",
      sizeKb: 1,
      status: "digested",
      batch: 1,
      note: "",
    },
  ];
  const batch = nextBatch(rows, 5);
  assertEquals(batch.map((r) => r.sessionId), ["old", "new"]);
  const withRound = markBatch(rows, batch, 2);
  assertEquals(withRound.find((r) => r.sessionId === "old")!.batch, 2);
  assertEquals(withRound.find((r) => r.sessionId === "done")!.batch, 1);
});

// ---------- findings --------------------------------------------------------

Deno.test("pickActionable and routeForTag", () => {
  const findings = [
    {
      id: "F-001",
      tag: "bad-tool",
      title: "a",
      status: "recurring",
      sightings: 2,
      evidence: [],
      cost: "",
      recommendation: "",
      promotedTo: "",
      verifyBy: "",
    },
    {
      id: "F-002",
      tag: "missing-skill",
      title: "b",
      status: "candidate",
      sightings: 1,
      evidence: [],
      cost: "",
      recommendation: "",
      promotedTo: "",
      verifyBy: "",
    },
    {
      id: "F-003",
      tag: "process",
      title: "c",
      status: "recurring",
      sightings: 3,
      evidence: [],
      cost: "",
      recommendation: "",
      promotedTo: "x",
      verifyBy: "",
    },
    {
      id: "F-004",
      tag: "win",
      title: "d",
      status: "recurring",
      sightings: 4,
      evidence: [],
      cost: "",
      recommendation: "",
      promotedTo: "",
      verifyBy: "",
    },
  ] as const;
  const actionable = pickActionable([...findings] as never);
  assertEquals(actionable.map((f) => f.id), ["F-001"]);
  assertStringIncludes(routeForTag("missing-skill"), "Skill repository");
  assertStringIncludes(routeForTag("unknown-tag"), "Review manually");
});

Deno.test("register and digest markdown renderers", () => {
  const md = registerToMarkdown([
    {
      id: "F-001",
      tag: "bad-tool",
      title: "x",
      status: "recurring",
      sightings: 2,
      evidence: ['claude/abc (2026-01-01): "quote"'],
      cost: "agent",
      recommendation: "fix it",
      promotedTo: "",
      verifyBy: "",
    },
  ]);
  assertStringIncludes(md, "### F-001 · [bad-tool] x");
  assertStringIncludes(md, "status: recurring");

  const dmd = digestToMarkdown({
    runtime: "codex",
    sessionId: "abcdef12-3456",
    scope: "proj",
    date: "2026-01-01",
    models: "gpt-5",
    outcome: "done",
    effectiveness: 4,
    task: "did a thing",
    friction: [{
      tag: "tokenomics",
      severity: "H",
      quote: "waited forever",
      cost: "agent",
    }],
    wins: ["clean run"],
    delegation: "one scout",
    userStyle: [],
    recs: [],
  });
  assertStringIncludes(dmd, "# codex/abcdef12");
  assertStringIncludes(dmd, "[tokenomics] [H]");
});

Deno.test("batchToMarkdown lists sessions and findings", () => {
  const md = batchToMarkdown({
    round: 2,
    createdAt: "2026-01-01T00:00:00Z",
    sessions: ["claude-code/abc12345"],
    effectiveness: [{ session: "claude-code/abc12345", score: 4 }],
    newFindings: ["F-002 [process] y"],
    recurrences: [],
    promotions: ["F-001 → Prompt cookbook (top of findings.md)"],
    processNotes: "rubric fine",
  });
  assertStringIncludes(md, "# round-02");
  assertStringIncludes(md, "F-002");
});

// ---------- model calls -----------------------------------------------------

Deno.test("callAnthropic sends the API shape and extracts text", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init! };
    return Promise.resolve(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
        {
          status: 200,
        },
      ),
    );
  }) as unknown as typeof fetch;

  const out = await callAnthropic(
    {
      apiUrl: "https://example.test/v1/messages",
      apiKey: "k",
      model: "m",
      maxTokens: 10,
    },
    "sys",
    "prompt",
    undefined,
    fakeFetch,
  );
  assertEquals(out, "ok");
  const headers = (captured!.init.headers ?? {}) as Record<string, string>;
  assertEquals(headers["x-api-key"], "k");
  assertStringIncludes(String(captured!.init.body), '"prompt"');
});

Deno.test("callAnthropic throws on a missing key and on non-2xx", async () => {
  await assertRejects(
    () =>
      callAnthropic(
        { apiUrl: "https://x", apiKey: "", model: "m", maxTokens: 1 },
        "s",
        "p",
      ),
    Error,
    "apiKey is required",
  );
  const failFetch = (() =>
    Promise.resolve(
      new Response("nope", { status: 500 }),
    )) as unknown as typeof fetch;
  await assertRejects(
    () =>
      callAnthropic(
        { apiUrl: "https://x", apiKey: "k", model: "m", maxTokens: 1 },
        "s",
        "p",
        undefined,
        failFetch,
      ),
    Error,
    "Anthropic API error",
  );
});

// ---------- inventory + strip (no LLM) --------------------------------------

Deno.test("inventory discovers, batches; strip condenses", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "retro_test_" });
  const projects = `${tmp}/projects/-home-me-proj`;
  await Deno.mkdir(projects, { recursive: true });
  const sessionId = "abcd1234-5678-90ab-cdef-1234567890ab";
  const file = `${projects}/${sessionId}.jsonl`;
  await Deno.writeTextFile(file, CLAUDE_FIXTURE.repeat(20));
  const past = new Date(Date.now() - 3_600_000);
  await Deno.utime(file, past, past);

  const store: Store = new Map();
  const ctx = makeCtx({
    runtimes: "claude-code",
    projectsDir: `${tmp}/projects`,
    retroDir: `${tmp}/retro`,
    minSizeKb: 1,
    inflightMinutes: 1,
    batchSize: 5,
  }, store);

  await run("inventory", ctx);
  const ledger = store.get("ledger") as {
    rows: Array<Record<string, unknown>>;
  };
  assert(ledger);
  const row = ledger.rows.find((r) => r.sessionId === sessionId)!;
  assertEquals(row.status, "pending");
  const batch = store.get(batchResName(1)) as { sessions: unknown[] };
  assertEquals(batch.sessions.length, 1);
  assertEquals(
    (store.get("state") as { currentRound: number }).currentRound,
    1,
  );

  await run("strip", ctx);
  const stripped = store.get(strippedResName("claude-code", sessionId)) as {
    content: string;
    turns: number;
  };
  assert(stripped);
  assertStringIncludes(stripped.content, "USER: do the thing");
  assert(stripped.turns >= 3);
});

Deno.test("stripCodex collapses the agent_message/message echo", () => {
  const turns = stripCodex(CODEX_FIXTURE);
  assertEquals(turns.filter((t) => t.text === "done").length, 1);
});

Deno.test("mergeLedger refreshes unsettled status and honors scanned runtimes", () => {
  const row = (
    id: string,
    runtime: string,
    status: string,
  ): Record<string, unknown> => ({
    scope: "p",
    runtime,
    sessionId: id,
    started: `2026-01-0${id.length}T00:00:00Z`,
    sizeKb: 1,
    status,
    batch: 0,
    note: "",
  });
  const existing = [
    row("inflight", "claude-code", "skipped-inflight"),
    row("trivial", "claude-code", "skipped-trivial"),
    row("coded", "codex", "pending"),
    row("done", "claude-code", "digested"),
  ] as unknown as never[];
  const discovered = [
    row("trivial", "claude-code", "pending"),
    row("inflight", "claude-code", "pending"),
    row("done", "claude-code", "pending"),
  ] as unknown as never[];

  const merged = mergeLedger(existing, discovered, new Set(["claude-code"]));
  const by = (id: string) => merged.find((r) => r.sessionId === id)!;
  assertEquals(by("trivial").status, "pending");
  assertEquals(by("inflight").status, "pending");
  assertEquals(by("done").status, "digested");
  // codex was not scanned this run, so its pending row must survive untouched.
  assertEquals(by("coded").status, "pending");
});
