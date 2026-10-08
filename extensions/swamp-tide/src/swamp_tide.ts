/**
 * Swamp tide model.
 *
 * Trolls the Swamp Club activity logs to find when people — and their
 * agents — are participating: a 7x24 heatmap of event density over the
 * club feed, with peak-slot detection and a markdown tide report.
 *
 * Tracer-bullet slice: `collect` harvests the club feed RSS into a
 * normalized event stream; `heatmap` buckets events by day-of-week and
 * hour in a configurable IANA timezone. Future activity-log sources
 * (swamp run history via `swamp report search`, the leaderboard, the
 * extension registry, GitHub org events) slot into the same event
 * schema and light up extra cells in the same grid.
 *
 * @module
 */

import { XMLParser } from "npm:fast-xml-parser@5.11.2";
import { z } from "npm:zod@4";

// ---------- schemas ---------------------------------------------------------

const EventSchema = z.object({
  id: z.string().describe("Stable event id (feed guid or link)"),
  ts: z.string().describe("ISO-8601 event timestamp in UTC"),
  source: z.string().describe(
    "Activity log this event came from (e.g. feed)",
  ),
  kind: z.string().describe("Event kind, e.g. feed_post"),
  actor: z.string().describe("Who (or what) produced the event"),
  actorKind: z.enum(["human", "agent", "unknown"]).describe(
    "Participation class: person, automated agent, or undetermined",
  ),
  url: z.string().nullable().describe("Link back to the source item"),
  title: z.string().describe("Short human-readable summary"),
  detail: z.string().nullable().describe("Longer text, HTML stripped"),
});

const EventsReportSchema = z.object({
  collectedAt: z.string().describe("ISO-8601 collection time"),
  feedUrl: z.string().describe("Feed the events were harvested from"),
  count: z.number().int(),
  events: z.array(EventSchema),
});

const HeatmapCellSchema = z.object({
  day: z.number().int().min(0).max(6).describe(
    "0=Sunday .. 6=Saturday, in the report timezone",
  ),
  dayName: z.string().describe("Three-letter day name"),
  hour: z.number().int().min(0).max(23),
  count: z.number().int(),
  actors: z.array(z.string()).describe("Distinct actors active in this slot"),
  sourceCounts: z.record(z.string(), z.number()).describe(
    "Events per source in this slot",
  ),
});

const DailyCountSchema = z.object({
  day: z.string().describe("Calendar day, YYYY-MM-DD, in the report timezone"),
  count: z.number().int(),
});

const ProfilesSchema = z.object({
  hourly: z.array(z.number().int()).length(24).describe(
    "Events per hour of day, 00:00..23:00",
  ),
  weekday: z.array(z.number().int()).length(7).describe(
    "Events per weekday, Sunday..Saturday",
  ),
  month: z.array(z.number().int()).length(31).describe(
    "Events per day of month, 1..31",
  ),
  daily: z.array(DailyCountSchema).describe(
    "Events per calendar day, chronological",
  ),
});

const HeatmapReportSchema = z.object({
  generatedAt: z.string(),
  timezone: z.string().describe("IANA timezone the buckets were computed in"),
  from: z.string().nullable().describe("Earliest event timestamp"),
  to: z.string().nullable().describe("Latest event timestamp"),
  totalEvents: z.number().int(),
  uniqueActors: z.number().int(),
  cells: z.array(HeatmapCellSchema).describe("All 168 day/hour slots"),
  peaks: z.array(HeatmapCellSchema).describe("Top 3 busiest slots"),
  profiles: ProfilesSchema.describe(
    "Hour-of-day, weekday, day-of-month and daily-trajectory profiles",
  ),
});

const GlobalArgsSchema = z.object({
  feedUrl: z.string().url().default("https://swamp-club.com/feed.xml").describe(
    "Club activity feed RSS to troll",
  ),
  timezone: z.string().default("UTC").describe(
    "IANA timezone for the heatmap buckets",
  ),
  source: z.string().default("feed").describe(
    "Source label recorded on collected events",
  ),
});

const HeatmapArgumentsSchema = z.object({
  events: z.array(EventSchema).describe(
    'Events to bucket; wire from the collect step via data.latest(tideModel, "events-current").attributes.events',
  ),
});

// ---------- types -----------------------------------------------------------

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
/** Normalized activity-log event, the common currency across sources. */
export type Event = z.infer<typeof EventSchema>;
type HeatmapCell = z.infer<typeof HeatmapCellSchema>;
type HeatmapReport = z.infer<typeof HeatmapReportSchema>;

type RawFeedItem = {
  title?: unknown;
  link?: unknown;
  guid?: unknown;
  "dc:creator"?: unknown;
  pubDate?: unknown;
  description?: unknown;
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

// ---------- helpers ---------------------------------------------------------

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
const DENSITY_SCALE = " .:-=+*#%@";
const HTML_TAG_RE = /<[^>]+>/g;

const parser = new XMLParser({
  ignoreAttributes: true,
  isArray: (name: string) => name === "item",
});

/** Parse an RSS 2.0 document into its raw <item> entries. */
export function parseFeedItems(xml: string): RawFeedItem[] {
  const doc = parser.parse(xml) as {
    rss?: { channel?: { item?: RawFeedItem | RawFeedItem[] } };
  };
  const items = doc?.rss?.channel?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Normalize one feed item into the common event shape. Feed posts are
 * written by operatives, so actorKind is "human"; run-history and
 * registry sources will set "agent" when the actor is automated.
 * Returns null when the item carries no parseable timestamp.
 */
export function feedItemToEvent(
  item: RawFeedItem,
  source: string,
): Event | null {
  const date = new Date(asString(item.pubDate));
  if (Number.isNaN(date.getTime())) return null;
  const title = asString(item.title) || "(untitled)";
  const guid = asString(item.guid);
  const link = asString(item.link);
  const detail = asString(item.description)
    .replace(HTML_TAG_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    id: guid || link || `${source}:${title}`,
    ts: date.toISOString(),
    source,
    kind: "feed_post",
    actor: asString(item["dc:creator"]) || "unknown",
    actorKind: "human",
    url: link || null,
    title,
    detail: detail || null,
  };
}

/** Day-of-week (0=Sun) and hour for a timestamp in an IANA timezone. */
export function bucketParts(
  ts: string,
  timezone: string,
): { day: number; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  });
  let day = -1;
  let hour = -1;
  for (const part of fmt.formatToParts(new Date(ts))) {
    if (part.type === "weekday") day = DAY_INDEX[part.value] ?? -1;
    else if (part.type === "hour") hour = Number(part.value);
  }
  return { day, hour };
}

/**
 * Bucket events into the full 7x24 grid. Unbucketable events (bad
 * timestamps, unknown timezones) are skipped; every cell exists even
 * when empty so the grid always renders.
 */
export function buildHeatmap(
  events: Event[],
  timezone: string,
): HeatmapReport {
  const slots = new Map<string, HeatmapCell>();
  const actors = new Set<string>();
  let from: string | null = null;
  let to: string | null = null;
  let total = 0;

  for (const event of events) {
    const { day, hour } = bucketParts(event.ts, timezone);
    if (day < 0 || hour < 0) continue;
    total++;
    actors.add(event.actor);
    if (from === null || event.ts < from) from = event.ts;
    if (to === null || event.ts > to) to = event.ts;

    const key = `${day}-${hour}`;
    const existing = slots.get(key);
    if (existing) {
      existing.count += 1;
      if (!existing.actors.includes(event.actor)) {
        existing.actors.push(event.actor);
      }
      existing.sourceCounts[event.source] =
        (existing.sourceCounts[event.source] ?? 0) + 1;
    } else {
      slots.set(key, {
        day,
        dayName: DAY_NAMES[day],
        hour,
        count: 1,
        actors: [event.actor],
        sourceCounts: { [event.source]: 1 },
      });
    }
  }

  const cells: HeatmapCell[] = [];
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const slot = slots.get(`${day}-${hour}`);
      cells.push(
        slot ?? {
          day,
          dayName: DAY_NAMES[day],
          hour,
          count: 0,
          actors: [],
          sourceCounts: {},
        },
      );
    }
  }

  const peaks = [...cells]
    .sort((a, b) => b.count - a.count || a.day - b.day || a.hour - b.hour)
    .slice(0, 3);

  return {
    generatedAt: new Date().toISOString(),
    timezone,
    from,
    to,
    totalEvents: total,
    uniqueActors: actors.size,
    cells,
    peaks,
    profiles: buildProfiles(events, timezone),
  };
}

type DailyCount = z.infer<typeof DailyCountSchema>;
/** Chart profiles: hourly, weekday, day-of-month and daily trajectory. */
export type Profiles = z.infer<typeof ProfilesSchema>;

/** Calendar day (YYYY-MM-DD) of a timestamp in the report timezone. */
export function calendarDay(ts: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts));
}

/**
 * Aggregate events into the chart profiles: events per hour of
 * day, per weekday, per day of month, and a chronological
 * per-day trajectory. All buckets are computed in the report
 * timezone; empty buckets stay zero so charts always render.
 */
export function buildProfiles(
  events: Event[],
  timezone: string,
): Profiles {
  const hourly = new Array<number>(24).fill(0);
  const weekday = new Array<number>(7).fill(0);
  const month = new Array<number>(31).fill(0);
  const dailyMap = new Map<string, number>();

  for (const event of events) {
    const { day, hour } = bucketParts(event.ts, timezone);
    if (day < 0 || hour < 0) continue;
    hourly[hour] += 1;
    weekday[day] += 1;

    const dayOfMonth = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        day: "numeric",
      }).format(new Date(event.ts)),
    );
    if (dayOfMonth >= 1 && dayOfMonth <= 31) month[dayOfMonth - 1] += 1;

    const key = calendarDay(event.ts, timezone);
    dailyMap.set(key, (dailyMap.get(key) ?? 0) + 1);
  }

  const daily = [...dailyMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([day, count]) => ({ day, count }));

  return { hourly, weekday, month, daily };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Label step so at most ~12 axis labels fit under the bars. */
function labelStep(count: number): number {
  return Math.max(1, Math.ceil(count / 12));
}

/**
 * Render a bar chart as a self-contained inline SVG, styled
 * after the club device Activity chart: one bar per bucket,
 * the peak bar darker, dashed gridlines, sparse axis labels.
 */
export function barChartSvg(
  title: string,
  values: number[],
  labels: string[],
): string {
  const width = 720;
  const height = 180;
  const padTop = 30;
  const padBottom = 24;
  const padX = 10;
  const chartW = width - padX * 2;
  const chartH = height - padTop - padBottom;
  const max = Math.max(1, ...values);
  const peak = Math.max(0, ...values);
  const n = values.length;
  const slot = chartW / n;
  const barW = Math.max(2, slot * 0.72);
  const step = labelStep(n);

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${
      escapeXml(title)
    }">`,
    `<text x="${padX}" y="18" font-family="monospace" font-size="14">${
      escapeXml(title)
    }</text>`,
  ];
  for (let g = 1; g <= 3; g++) {
    const y = padTop + chartH - (chartH * g) / 3;
    parts.push(
      `<line x1="${padX}" y1="${y.toFixed(1)}" x2="${width - padX}" y2="${
        y.toFixed(1)
      }" stroke="currentColor" stroke-opacity="0.15" stroke-dasharray="2 3"/>`,
    );
  }
  for (let i = 0; i < n; i++) {
    const h = values[i] <= 0 ? 0 : Math.max(2, (values[i] / max) * chartH);
    const x = padX + i * slot + (slot - barW) / 2;
    const y = padTop + chartH - h;
    const fill = values[i] === peak && peak > 0 ? "#0e7a4d" : "#3aa675";
    parts.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${
        barW.toFixed(1)
      }" height="${h.toFixed(1)}" rx="1" fill="${fill}"/>`,
    );
    if (i % step === 0) {
      parts.push(
        `<text x="${(padX + i * slot + slot / 2).toFixed(1)}" y="${
          height - 6
        }" font-family="monospace" font-size="10" text-anchor="middle" fill="currentColor">${
          escapeXml(labels[i] ?? "")
        }</text>`,
      );
    }
  }
  parts.push("</svg>");
  return parts.join("\n");
}

/**
 * Render a chronological line/area chart as a self-contained
 * inline SVG, styled after the club device Trajectory chart.
 */
export function lineChartSvg(
  title: string,
  points: number[],
  labels: string[],
): string {
  const width = 720;
  const height = 180;
  const padTop = 30;
  const padBottom = 24;
  const padX = 10;
  const chartW = width - padX * 2;
  const chartH = height - padTop - padBottom;
  const max = Math.max(1, ...points);
  const n = points.length;

  const xAt = (i: number): number =>
    n <= 1 ? padX + chartW / 2 : padX + (i / (n - 1)) * chartW;
  const yAt = (v: number): number => padTop + chartH - (v / max) * chartH;

  const coords = points.map((v, i) =>
    `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`
  );
  const area = `${padX},${padTop + chartH} ${coords.join(" ")} ${
    padX + chartW
  },${padTop + chartH}`;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${
      escapeXml(title)
    }">`,
    `<text x="${padX}" y="18" font-family="monospace" font-size="14">${
      escapeXml(title)
    }</text>`,
  ];
  for (let g = 1; g <= 3; g++) {
    const y = padTop + chartH - (chartH * g) / 3;
    parts.push(
      `<line x1="${padX}" y1="${y.toFixed(1)}" x2="${width - padX}" y2="${
        y.toFixed(1)
      }" stroke="currentColor" stroke-opacity="0.15" stroke-dasharray="2 3"/>`,
    );
  }
  parts.push(`<polygon points="${area}" fill="#3aa675" fill-opacity="0.18"/>`);
  parts.push(
    `<polyline points="${
      coords.join(" ")
    }" fill="none" stroke="#0e7a4d" stroke-width="2"/>`,
  );
  const shown = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
  for (const i of shown) {
    parts.push(
      `<text x="${xAt(i).toFixed(1)}" y="${
        height - 6
      }" font-family="monospace" font-size="10" text-anchor="middle" fill="currentColor">${
        escapeXml(labels[i] ?? "")
      }</text>`,
    );
  }
  parts.push("</svg>");
  return parts.join("\n");
}

/** Render the heatmap report as markdown with an ASCII density grid. */
export function renderHeatmapMarkdown(report: HeatmapReport): string {
  const lines: string[] = [];
  lines.push("# Swamp Tide");
  lines.push("");
  lines.push(`- Timezone: \`${report.timezone}\``);
  lines.push(
    `- Events: ${report.totalEvents} from ${report.uniqueActors} actor(s)`,
  );
  if (report.from && report.to) {
    lines.push(`- Window: ${report.from} → ${report.to}`);
  }
  lines.push("");

  const peak = report.peaks[0];
  if (peak && peak.count > 0) {
    lines.push(
      `The swamp bites hardest **${peak.dayName} ${pad2(peak.hour)}:00** ` +
        `(${report.timezone}) — ${peak.count} event(s), ` +
        `${peak.actors.join(", ")}.`,
    );
  } else {
    lines.push("The swamp is silent: no events in this window.");
  }
  lines.push("");

  const max = Math.max(1, ...report.cells.map((c) => c.count));
  const glyph = (count: number): string =>
    count <= 0 ? "·" : DENSITY_SCALE[
      Math.min(
        DENSITY_SCALE.length - 1,
        Math.ceil((count / max) * (DENSITY_SCALE.length - 1)),
      )
    ];

  const header = "     " +
    Array.from({ length: 24 }, (_, h) => pad2(h)).join(" ");
  lines.push(header);
  for (let day = 0; day < 7; day++) {
    const row = report.cells.slice(day * 24, day * 24 + 24);
    lines.push(
      `${DAY_NAMES[day].padEnd(4)} ` +
        row.map((c) => ` ${glyph(c.count)} `).join(""),
    );
  }
  lines.push("");
  lines.push("Legend: · quiet, @ peak density");
  lines.push("");

  const p = report.profiles;
  lines.push("## Activity — hour of day");
  lines.push("");
  lines.push(
    barChartSvg(
      "Events by hour of day",
      p.hourly,
      Array.from({ length: 24 }, (_, h) => pad2(h)),
    ),
  );
  lines.push("");

  lines.push("## Activity — day of week");
  lines.push("");
  lines.push(barChartSvg("Events by weekday", p.weekday, DAY_NAMES));
  lines.push("");

  lines.push("## Activity — day of month");
  lines.push("");
  lines.push(
    barChartSvg(
      "Events by day of month",
      p.month,
      Array.from({ length: 31 }, (_, d) => String(d + 1)),
    ),
  );
  lines.push("");

  lines.push("## Trajectory — events per day");
  lines.push("");
  lines.push(
    lineChartSvg(
      "Events per day",
      p.daily.map((d) => d.count),
      p.daily.map((d) => d.day),
    ),
  );
  lines.push("");

  lines.push("## Peak slots");
  lines.push("");
  const live = report.peaks.filter((p) => p.count > 0);
  if (live.length === 0) {
    lines.push("No activity recorded.");
  } else {
    for (const p of live) {
      lines.push(
        `- ${p.dayName} ${pad2(p.hour)}:00 — ${p.count} event(s) · ${
          p.actors.join(", ")
        }`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ---------- methods ---------------------------------------------------------

async function collect(
  _args: Record<string, never>,
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const response = await fetch(cfg.feedUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Feed fetch failed: ${response.status} ${response.statusText} for ${cfg.feedUrl}`,
    );
  }
  const xml = await response.text();
  const events = parseFeedItems(xml)
    .map((item) => feedItemToEvent(item, cfg.source))
    .filter((event): event is Event => event !== null);

  const report: z.infer<typeof EventsReportSchema> = {
    collectedAt: new Date().toISOString(),
    feedUrl: cfg.feedUrl,
    count: events.length,
    events,
  };
  const handle = await ctx.writeResource("events", "events-current", report);
  ctx.logger.info("Collected {n} event(s) from {url}", {
    n: events.length,
    url: cfg.feedUrl,
  });
  return { dataHandles: [handle] };
}

async function heatmap(
  args: z.infer<typeof HeatmapArgumentsSchema>,
  ctx: ModelContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const cfg = GlobalArgsSchema.parse(ctx.globalArgs);
  const parsed = HeatmapArgumentsSchema.parse(args);
  const report = buildHeatmap(parsed.events, cfg.timezone);
  const markdown = renderHeatmapMarkdown(report);

  const handles = [
    await ctx.writeResource("heatmap", "heatmap-current", report),
    await ctx.createFileWriter("report", "report-current").writeText(markdown),
  ];
  const peak = report.peaks[0];
  ctx.logger.info(
    "Heatmap built: {n} event(s), peak {day} {hour}:00 ({tz})",
    {
      n: report.totalEvents,
      day: peak?.dayName ?? "n/a",
      hour: peak?.hour ?? -1,
      tz: cfg.timezone,
    },
  );
  return { dataHandles: handles };
}

/**
 * The swamp tide extension: participation analytics over the
 * swamp club activity logs. One model, two methods — collect
 * the activity, then heatmap it into charts and a report.
 */
export const model = {
  type: "@maphew/swamp-tide",
  version: "2026.10.08.3",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.08.2",
      description:
        "Version bump, no schema changes — bundled tide-view.mjs viewer",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.08.3",
      description: "tide-view follows the system light/dark setting with a " +
        "persisted override; extension relocated to the " +
        "swamp-extensions repo",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    events: {
      description:
        "Normalized activity events harvested from the club activity logs",
      schema: EventsReportSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    heatmap: {
      description: "7x24 participation heatmap with peak-slot detection",
      schema: HeatmapReportSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },
  files: {
    report: {
      description: "Markdown tide report with ASCII participation heatmap",
      contentType: "text/markdown",
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    collect: {
      description:
        "Troll the swamp club activity feed and store normalized events",
      arguments: z.object({}),
      execute: collect,
    },
    heatmap: {
      description:
        "Bucket events into a 7x24 participation heatmap and render the tide report",
      arguments: HeatmapArgumentsSchema,
      execute: heatmap,
    },
  },
};
