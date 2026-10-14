/**
 * Club pulse — personal Swamp Club points velocity, bucketed by minute, hour
 * and day.
 *
 * The Swamp Club exposes only point-in-time leaderboard snapshots (no
 * timestamped XP history), so velocity can only be derived by sampling on a
 * cadence and differencing. This model does exactly that:
 *
 *   - `sample`  fetch the current club-points snapshot for a user and append it
 *               to a rolling buffer (`samples`).
 *   - `pulse`   read the buffer, diff consecutive samples, bucket the deltas by
 *               minute / hour / day, and render a markdown pulse report.
 *
 * The resolution of the result is bounded by the sampling cadence: hourly
 * sampling yields hourly buckets, not true hour-granular events. This is called
 * out in the report itself.
 *
 * Metric choice: this tracks *club points* (the leaderboard score), not Genesis
 * quest XP (`swamp quest`). Quest XP only moves when a challenge completes, so
 * once every challenge is done it is permanently flat. Club points keep moving.
 *
 * @module
 */

import { z } from "npm:zod@4";

// ---------- schemas ---------------------------------------------------------

const SampleSchema = z.object({
  ts: z.iso.datetime().describe("UTC timestamp this sample was taken"),
  score: z.number().describe("Lifetime club points"),
  todayScore: z.number().describe("Club points earned today"),
  weekScore: z.number().describe("Club points earned this week"),
  rank: z.number().nullable().describe("Lifetime leaderboard rank"),
  todayRank: z.number().nullable().describe("Today leaderboard rank"),
  weekRank: z.number().nullable().describe("Week leaderboard rank"),
  streak: z.number().nullable().describe("Current daily streak in days"),
  tierName: z.string().nullable(),
});
type Sample = z.infer<typeof SampleSchema>;

const SamplesSchema = z.object({
  username: z.string(),
  samples: z.array(SampleSchema),
  updatedAt: z.iso.datetime(),
  dropped: z.number().int().describe("Samples trimmed off the front"),
});
type Samples = z.infer<typeof SamplesSchema>;

const BucketEntrySchema = z.object({
  key: z.string().describe("UTC bucket key (minute, hour or day)"),
  gained: z.number().describe("Net club points attributable to this bucket"),
  samples: z.number().int(),
  startScore: z.number().nullable(),
  endScore: z.number().nullable(),
  endTodayScore: z.number().nullable(),
  endRank: z.number().nullable(),
});
type BucketEntry = z.infer<typeof BucketEntrySchema>;

const PulseSchema = z.object({
  username: z.string(),
  asOf: z.iso.datetime(),
  sampleCount: z.number().int(),
  firstSampleAt: z.iso.datetime().nullable(),
  lastSampleAt: z.iso.datetime().nullable(),
  latest: SampleSchema.nullable(),
  totalGained: z.number(),
  resolution: z.string(),
  buckets: z.object({
    minute: z.array(BucketEntrySchema),
    hour: z.array(BucketEntrySchema),
    day: z.array(BucketEntrySchema),
  }),
});
type Pulse = z.infer<typeof PulseSchema>;

const GlobalArgsSchema = z.object({
  username: z.string().min(1).describe(
    "Swamp Club username to track (required)",
  ),
  clubUrl: z.string().url().default("https://swamp-club.com").describe(
    "Swamp Club base URL",
  ),
  maxSamples: z.number().int().positive().default(5000).describe(
    "Maximum samples retained in the rolling buffer",
  ),
  reportBuckets: z.number().int().positive().default(24).describe(
    "How many recent buckets to render per granularity in the report",
  ),
  timeoutMs: z.number().int().positive().default(15_000).describe(
    "Per-request timeout in milliseconds",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------- pure helpers (exported for tests) -------------------------------

/** UTC bucket key for an ISO timestamp at the given granularity. */
export function bucketKey(
  iso: string,
  granularity: "minute" | "hour" | "day",
): string {
  if (granularity === "minute") return iso.slice(0, 16); // YYYY-MM-DDTHH:MM
  if (granularity === "hour") return iso.slice(0, 13); // YYYY-MM-DDTHH
  return iso.slice(0, 10); // YYYY-MM-DD
}

/**
 * Diff consecutive samples and sum the lifetime-point deltas into buckets.
 *
 * A delta `s[i].score - s[i-1].score` is attributed to the bucket containing
 * `s[i].ts`. The first sample seeds its bucket with a zero gain so the bucket
 * still shows a level even before a second sample exists.
 */
export function computeBuckets(
  samples: Sample[],
  granularity: "minute" | "hour" | "day",
): BucketEntry[] {
  const ordered = [...samples].sort((a, b) => a.ts.localeCompare(b.ts));
  const byKey = new Map<string, BucketEntry>();

  const touch = (s: Sample): BucketEntry => {
    const key = bucketKey(s.ts, granularity);
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        key,
        gained: 0,
        samples: 0,
        startScore: s.score,
        endScore: s.score,
        endTodayScore: s.todayScore,
        endRank: s.rank,
      };
      byKey.set(key, entry);
    }
    return entry;
  };

  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i];
    const entry = touch(s);
    entry.samples += 1;
    entry.endScore = s.score;
    entry.endTodayScore = s.todayScore;
    entry.endRank = s.rank;
    if (i > 0) entry.gained += s.score - ordered[i - 1].score;
  }

  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Build the full pulse payload from a rolling sample buffer. */
export function buildPulse(
  username: string,
  samples: Sample[],
  asOf: string,
): Pulse {
  const ordered = [...samples].sort((a, b) => a.ts.localeCompare(b.ts));
  const latest = ordered.length > 0 ? ordered[ordered.length - 1] : null;
  const first = ordered.length > 0 ? ordered[0] : null;
  const totalGained = ordered.length > 1 ? latest!.score - first!.score : 0;

  return {
    username,
    asOf,
    sampleCount: ordered.length,
    firstSampleAt: first?.ts ?? null,
    lastSampleAt: latest?.ts ?? null,
    latest,
    totalGained,
    resolution:
      "Bucket resolution is bounded by the sampling cadence — an hourly sampler cannot resolve true hourly XP events.",
    buckets: {
      minute: computeBuckets(ordered, "minute"),
      hour: computeBuckets(ordered, "hour"),
      day: computeBuckets(ordered, "day"),
    },
  };
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-US");
}

function sign(n: number): string {
  return n > 0 ? `+${fmt(n)}` : fmt(n);
}

function renderBucketTable(
  title: string,
  buckets: BucketEntry[],
  recent: number,
): string[] {
  const lines: string[] = [];
  lines.push(`### ${title}`);
  lines.push("");
  if (buckets.length === 0) {
    lines.push("_No samples yet._");
    lines.push("");
    return lines;
  }
  const shown = buckets.slice(-recent);
  lines.push("| Bucket (UTC) | Gained | Samples | End points | Today | Rank |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const b of shown) {
    lines.push(
      `| \`${b.key}\` | ${sign(b.gained)} | ${b.samples} | ${
        fmt(b.endScore)
      } | ${fmt(b.endTodayScore)} | ${fmt(b.endRank)} |`,
    );
  }
  lines.push("");
  return lines;
}

/** Render the markdown pulse report. */
export function renderPulseMarkdown(pulse: Pulse, recent: number): string {
  const lines: string[] = [];
  const latest = pulse.latest;

  lines.push("# Club Points Pulse");
  lines.push("");
  lines.push(`- Operative: **${pulse.username}**`);
  lines.push(`- As of: \`${pulse.asOf}\``);
  lines.push(
    `- Samples: ${pulse.sampleCount}${
      pulse.firstSampleAt ? ` (since \`${pulse.firstSampleAt}\`)` : ""
    }`,
  );
  lines.push(`- Net points over window: **${sign(pulse.totalGained)}**`);
  lines.push("");
  if (latest) {
    lines.push("## Latest snapshot");
    lines.push("");
    lines.push(
      `- Lifetime: **${fmt(latest.score)}** (rank ${fmt(latest.rank)})`,
    );
    lines.push(
      `- Today: **${fmt(latest.todayScore)}** (rank ${fmt(latest.todayRank)})`,
    );
    lines.push(
      `- This week: **${fmt(latest.weekScore)}** (rank ${
        fmt(latest.weekRank)
      })`,
    );
    lines.push(`- Streak: ${fmt(latest.streak)} day(s)`);
    lines.push(`- Tier: ${latest.tierName ?? "—"}`);
    lines.push("");
  } else {
    lines.push(
      "No samples yet — run `sample` (ideally on a schedule) to begin.",
    );
    lines.push("");
    return lines.join("\n");
  }

  lines.push("## Velocity");
  lines.push("");
  lines.push(`> ${pulse.resolution}`);
  lines.push("");
  lines.push(...renderBucketTable("By minute", pulse.buckets.minute, recent));
  lines.push(...renderBucketTable("By hour", pulse.buckets.hour, recent));
  lines.push(...renderBucketTable("By day", pulse.buckets.day, recent));

  return lines.join("\n");
}

// ---------- HTML dashboard (exported for tests) ----------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function round(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

const PULSE_CSS = `
:root{color-scheme:light;--bg:#fbfaf7;--fg:#1f2430;--muted:#5a6270;--border:#dfe3e8;--card:#fff;--accent:#0e7a4d;--accent-soft:rgba(14,122,77,.14)}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#15181e;--fg:#e6e8eb;--muted:#9aa1ad;--border:#2e3440;--card:#1c212a;--accent:#4cc38a;--accent-soft:rgba(76,195,138,.16)}}
*{box-sizing:border-box}
body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:960px;margin:0 auto;padding:2rem 1.25rem 5rem;color:var(--fg);background:var(--bg)}
h1{font-size:1.6rem;margin:0 0 .25rem}
h2{font-size:1.05rem;margin:2rem 0 .5rem;border-bottom:1px solid var(--border);padding-bottom:.3rem}
.muted{color:var(--muted)}
.small{font-size:.85rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.75rem;margin:1.25rem 0}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:.75rem 1rem}
.card-label{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.card-value{font-size:1.35rem;font-weight:600;margin-top:.15rem;font-variant-numeric:tabular-nums}
svg{max-width:100%;height:auto;display:block}
.axis{fill:var(--muted);font-size:11px;font-family:ui-monospace,monospace}
.bar-pos{fill:var(--accent)}
.bar-neg{fill:#e5484d}
`;

type Point = { label: string; value: number };

/** Area chart of a value series (used for the lifetime-points trend). */
function lineChart(values: number[], width = 900, height = 220): string {
  if (values.length === 0) return '<p class="muted">No samples yet.</p>';
  const capped = values.slice(-500);
  const padL = 78, padR = 16, padT = 16, padB = 30;
  const w = width - padL - padR;
  const h = height - padT - padB;
  const min = Math.min(...capped);
  const max = Math.max(...capped);
  const span = max - min || 1;
  const n = capped.length;
  const x = (i: number) => padL + (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number) => padT + h - ((v - min) / span) * h;
  const pts = capped.map((v, i) => `${round(x(i))},${round(y(v))}`);
  const area = `M ${round(padL)},${round(padT + h)} L ${pts.join(" L ")} L ${
    round(padL + w)
  },${round(padT + h)} Z`;
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Lifetime points over time">
  <path d="${area}" fill="var(--accent-soft)" stroke="none"/>
  <polyline points="${
    pts.join(" ")
  }" fill="none" stroke="var(--accent)" stroke-width="2"/>
  <text x="${padL - 8}" y="${padT + 4}" text-anchor="end" class="axis">${
    esc(fmt(max))
  }</text>
  <text x="${padL - 8}" y="${padT + h}" text-anchor="end" class="axis">${
    esc(fmt(min))
  }</text>
</svg>`;
}

/** Bar chart of per-bucket point gains; negative bars (score corrections) are red. */
function barChart(points: Point[], width = 900, height = 180): string {
  if (points.length === 0) return '<p class="muted">No buckets yet.</p>';
  const padL = 78, padR = 16, padT = 16, padB = 34;
  const w = width - padL - padR;
  const h = height - padT - padB;
  const absMax = Math.max(...points.map((p) => Math.abs(p.value)), 1);
  const baseY = padT + h;
  const step = w / points.length;
  const barW = Math.max(1, step * 0.68);
  const bars = points.map((p, i) => {
    const bh = (Math.abs(p.value) / absMax) * h;
    const bx = padL + i * step + (step - barW) / 2;
    const by = p.value >= 0 ? baseY - bh : baseY;
    const cls = p.value >= 0 ? "bar-pos" : "bar-neg";
    return `<rect class="${cls}" x="${round(bx)}" y="${round(by)}" width="${
      round(barW)
    }" height="${round(bh)}"><title>${esc(p.label)}: ${
      esc(sign(p.value))
    }</title></rect>`;
  }).join("");
  const labelAt = (i: number, anchor: string) => {
    const p = points[i];
    if (!p) return "";
    return `<text x="${round(padL + i * step + step / 2)}" y="${
      height - 10
    }" text-anchor="${anchor}" class="axis">${esc(p.label.slice(-5))}</text>`;
  };
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Points gained per bucket">
  ${bars}
  ${labelAt(0, "start")}
  ${labelAt(points.length - 1, "end")}
  <text x="${padL - 8}" y="${padT + 4}" text-anchor="end" class="axis">+${
    esc(fmt(absMax))
  }</text>
</svg>`;
}

function statCard(label: string, value: string): string {
  return `<div class="card"><div class="card-label">${
    esc(label)
  }</div><div class="card-value">${esc(value)}</div></div>`;
}

function barPoints(buckets: BucketEntry[], recent: number): Point[] {
  return buckets.slice(-recent).map((b) => ({ label: b.key, value: b.gained }));
}

/** Render a self-contained HTML dashboard for the pulse (no external assets). */
export function renderPulseHtml(pulse: Pulse, recent: number): string {
  const latest = pulse.latest;
  const cards = latest
    ? [
      statCard("Lifetime", fmt(latest.score)),
      statCard("Today", fmt(latest.todayScore)),
      statCard("This week", fmt(latest.weekScore)),
      statCard("Rank", fmt(latest.rank)),
      statCard("Streak", latest.streak === null ? "—" : `${latest.streak}d`),
      statCard("Tier", latest.tierName ?? "—"),
    ].join("")
    : "";

  const lifetimeSeries = pulse.buckets.day.map((b) => b.endScore ?? 0);

  const body = latest
    ? `
<div class="cards">${cards}</div>
<section><h2>Lifetime points</h2>${lineChart(lifetimeSeries)}</section>
<section><h2>Gained per hour</h2>${
      barChart(barPoints(pulse.buckets.hour, recent))
    }</section>
<section><h2>Gained per day</h2>${
      barChart(barPoints(pulse.buckets.day, recent))
    }</section>
<section><h2>Gained per minute</h2>${
      barChart(barPoints(pulse.buckets.minute, recent))
    }</section>`
    : '<p class="muted">No samples yet — run the club-pulse workflow to begin.</p>';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Club Pulse — ${esc(pulse.username)}</title>
<style>${PULSE_CSS}</style>
</head><body>
<header>
<h1>Club Points Pulse</h1>
<p class="muted">${esc(pulse.username)} · as of ${
    esc(pulse.asOf)
  } · ${pulse.sampleCount} sample(s) · net ${esc(sign(pulse.totalGained))}</p>
<p class="muted small">${esc(pulse.resolution)}</p>
</header>
${body}
</body></html>`;
}

// ---------- fetch -----------------------------------------------------------

type LocateRow = {
  rank?: number;
  username?: string;
  score?: number;
  streak?: number;
  isMatch?: boolean;
  tier?: { tierName?: string };
};
type LocateBoard = { found?: boolean; rows?: LocateRow[] };
type LocatePayload = {
  found?: boolean;
  target?: string;
  boards?: Record<string, LocateBoard>;
};

function pickRow(
  boards: Record<string, LocateBoard>,
  name: string,
  username: string,
): LocateRow | null {
  const rows = boards[name]?.rows ?? [];
  return rows.find((r) => r.isMatch || r.username === username) ?? null;
}

async function fetchSample(cfg: GlobalArgs): Promise<Sample> {
  const url = `${cfg.clubUrl.replace(/\/+$/, "")}/api/v1/leaderboard/locate?q=${
    encodeURIComponent(cfg.username)
  }`;
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "swamp-club-pulse/1",
    },
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`club locate request failed: HTTP ${res.status}`);
  }
  const data = await res.json() as LocatePayload;
  if (!data || data.found === false) {
    throw new Error(`no Swamp Club profile found for "${cfg.username}"`);
  }
  const boards = data.boards ?? {};
  const all = pickRow(boards, "alltime", cfg.username);
  const today = pickRow(boards, "today", cfg.username);
  const week = pickRow(boards, "week", cfg.username);
  const streakRow = pickRow(boards, "streaks", cfg.username);

  if (!all) {
    throw new Error(
      `"${cfg.username}" is not present on the alltime board; cannot track lifetime points`,
    );
  }

  return {
    ts: new Date().toISOString(),
    score: all.score ?? 0,
    todayScore: today?.score ?? 0,
    weekScore: week?.score ?? 0,
    rank: all.rank ?? null,
    todayRank: today?.rank ?? null,
    weekRank: week?.rank ?? null,
    streak: streakRow?.streak ?? null,
    tierName: all.tier?.tierName ?? today?.tier?.tierName ?? null,
  };
}

// ---------- context type ----------------------------------------------------

type ModelContext = {
  globalArgs: GlobalArgs;
  readResource?: (name: string) => Promise<Record<string, unknown> | null>;
  writeResource: (
    spec: string,
    instance: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  createFileWriter: (
    spec: string,
    instance: string,
  ) => { writeText: (text: string) => Promise<{ name: string }> };
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
};

// ---------- model -----------------------------------------------------------

export const model = {
  type: "@maphew/club-pulse",
  version: "2026.10.14.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    samples: {
      description: "Rolling buffer of timestamped club-points samples",
      schema: SamplesSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    pulse: {
      description: "Bucketed club-points velocity (minute / hour / day)",
      schema: PulseSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  files: {
    report: {
      description: "Markdown club-points pulse report",
      contentType: "text/markdown",
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    dashboard: {
      description: "Self-contained HTML club-points dashboard",
      contentType: "text/html",
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    sample: {
      description:
        "Fetch the current club-points snapshot and append it to the rolling buffer",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ModelContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
        const current = fetchSample(cfg);

        const previous = ctx.readResource
          ? await ctx.readResource("samples-current")
          : null;
        const parsed = previous ? SamplesSchema.parse(previous) : null;
        const prior = parsed?.samples ?? [];
        const sample = await current;

        const combined = [...prior, sample];
        const overflow = Math.max(0, combined.length - cfg.maxSamples);
        const kept = overflow > 0 ? combined.slice(overflow) : combined;

        const buffer: Samples = {
          username: cfg.username,
          samples: kept,
          updatedAt: sample.ts,
          dropped: (parsed?.dropped ?? 0) + overflow,
        };

        const handle = await ctx.writeResource(
          "samples",
          "samples-current",
          buffer,
        );
        ctx.logger.info("Sampled {user}: {score} lifetime, {today} today", {
          user: cfg.username,
          score: sample.score,
          today: sample.todayScore,
        });
        return { dataHandles: [handle] };
      },
    },
    pulse: {
      description:
        "Bucket recorded samples into minute / hour / day point deltas and render the pulse report",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ModelContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
        const stored = ctx.readResource
          ? await ctx.readResource("samples-current")
          : null;
        if (!stored) {
          throw new Error(
            "no samples recorded yet — run `sample` first (schedule it for a real time series)",
          );
        }
        const buffer = SamplesSchema.parse(stored);
        const asOf = new Date().toISOString();
        const pulse = buildPulse(buffer.username, buffer.samples, asOf);
        const markdown = renderPulseMarkdown(pulse, cfg.reportBuckets);

        const pulseHandle = await ctx.writeResource(
          "pulse",
          "pulse-current",
          pulse,
        );
        const reportHandle = await ctx.createFileWriter(
          "report",
          "pulse-report-current",
        ).writeText(markdown);
        const dashboardHandle = await ctx.createFileWriter(
          "dashboard",
          "pulse-dashboard",
        ).writeText(renderPulseHtml(pulse, cfg.reportBuckets));

        ctx.logger.info(
          "Pulse: {n} sample(s), {gained} net points over window",
          { n: pulse.sampleCount, gained: pulse.totalGained },
        );
        return { dataHandles: [pulseHandle, reportHandle, dashboardHandle] };
      },
    },
  },
};
