import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import {
  bucketKey,
  buildPulse,
  computeBuckets,
  renderPulseHtml,
  renderPulseMarkdown,
} from "./club_pulse.ts";

type Sample = {
  ts: string;
  score: number;
  todayScore: number;
  weekScore: number;
  rank: number | null;
  todayRank: number | null;
  weekRank: number | null;
  streak: number | null;
  tierName: string | null;
};

function sample(ts: string, score: number, todayScore = 0): Sample {
  return {
    ts,
    score,
    todayScore,
    weekScore: 0,
    rank: 1,
    todayRank: 1,
    weekRank: 1,
    streak: null,
    tierName: "Murk Beast",
  };
}

Deno.test("bucketKey truncates to UTC minute/hour/day", () => {
  const ts = "2026-10-14T15:38:19.000Z";
  assertEquals(bucketKey(ts, "minute"), "2026-10-14T15:38");
  assertEquals(bucketKey(ts, "hour"), "2026-10-14T15");
  assertEquals(bucketKey(ts, "day"), "2026-10-14");
});

Deno.test("computeBuckets seeds the first bucket with zero gain", () => {
  const buckets = computeBuckets(
    [sample("2026-10-14T15:00:00.000Z", 100)],
    "hour",
  );
  assertEquals(buckets.length, 1);
  assertEquals(buckets[0].key, "2026-10-14T15");
  assertEquals(buckets[0].gained, 0);
  assertEquals(buckets[0].startScore, 100);
  assertEquals(buckets[0].endScore, 100);
  assertEquals(buckets[0].samples, 1);
});

Deno.test("computeBuckets sums deltas into the later sample's bucket", () => {
  const samples = [
    sample("2026-10-14T15:10:00.000Z", 100),
    sample("2026-10-14T15:40:00.000Z", 175),
    sample("2026-10-14T16:05:00.000Z", 200),
  ];
  const byHour = computeBuckets(samples, "hour");
  assertEquals(byHour.map((b) => [b.key, b.gained]), [
    ["2026-10-14T15", 75],
    ["2026-10-14T16", 25],
  ]);
  assertEquals(byHour[0].startScore, 100);
  assertEquals(byHour[0].endScore, 175);

  const byMinute = computeBuckets(samples, "minute");
  assertEquals(byMinute.map((b) => [b.key, b.gained]), [
    ["2026-10-14T15:10", 0],
    ["2026-10-14T15:40", 75],
    ["2026-10-14T16:05", 25],
  ]);
});

Deno.test("computeBuckets keeps a negative delta (score correction)", () => {
  const buckets = computeBuckets([
    sample("2026-10-14T15:00:00.000Z", 200),
    sample("2026-10-14T15:30:00.000Z", 150),
  ], "hour");
  assertEquals(buckets[0].gained, -50);
});

Deno.test("buildPulse reports span and net totals", () => {
  const pulse = buildPulse("maphew", [
    sample("2026-10-14T15:00:00.000Z", 100, 10),
    sample("2026-10-15T09:00:00.000Z", 250, 40),
  ], "2026-10-15T09:01:00.000Z");
  assertEquals(pulse.sampleCount, 2);
  assertEquals(pulse.totalGained, 150);
  assertEquals(pulse.firstSampleAt, "2026-10-14T15:00:00.000Z");
  assertEquals(pulse.lastSampleAt, "2026-10-15T09:00:00.000Z");
  assertEquals(pulse.latest?.score, 250);
  assertEquals(pulse.buckets.day.length, 2);
});

Deno.test("buildPulse handles an empty buffer", () => {
  const pulse = buildPulse("maphew", [], "2026-10-15T09:01:00.000Z");
  assertEquals(pulse.sampleCount, 0);
  assertEquals(pulse.latest, null);
  assertEquals(pulse.totalGained, 0);
});

Deno.test("renderPulseMarkdown emits the report shape", () => {
  const pulse = buildPulse("maphew", [
    sample("2026-10-14T15:00:00.000Z", 100),
    sample("2026-10-14T16:00:00.000Z", 175),
  ], "2026-10-14T16:01:00.000Z");
  const md = renderPulseMarkdown(pulse, 24);
  assertStringIncludes(md, "# Club Points Pulse");
  assertStringIncludes(md, "**maphew**");
  assertStringIncludes(md, "### By minute");
  assertStringIncludes(md, "### By hour");
  assertStringIncludes(md, "### By day");
  assertStringIncludes(md, "| `2026-10-14T16` | +75 |");
});

Deno.test("renderPulseHtml emits a self-contained dashboard", () => {
  const pulse = buildPulse("maphew", [
    sample("2026-10-14T15:00:00.000Z", 100, 10),
    sample("2026-10-14T16:00:00.000Z", 175, 40),
  ], "2026-10-14T16:01:00.000Z");
  const html = renderPulseHtml(pulse, 24);
  assertStringIncludes(html, "<!doctype html>");
  assertStringIncludes(html, "<title>Club Pulse — maphew</title>");
  assertStringIncludes(html, "Lifetime points");
  assertStringIncludes(html, "Gained per hour");
  assertStringIncludes(html, "Gained per day");
  assertStringIncludes(html, "Gained per minute");
  assertStringIncludes(html, "<svg");
  assertStringIncludes(html, 'class="bar-pos"');
  assertEquals(html.includes("http://") || html.includes("https://"), false);
});

Deno.test("renderPulseHtml handles no samples", () => {
  const pulse = buildPulse("maphew", [], "2026-10-14T16:01:00.000Z");
  const html = renderPulseHtml(pulse, 24);
  assertStringIncludes(html, "No samples yet");
});
