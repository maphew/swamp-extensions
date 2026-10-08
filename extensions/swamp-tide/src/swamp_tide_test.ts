import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  barChartSvg,
  bucketParts,
  buildHeatmap,
  buildProfiles,
  calendarDay,
  feedItemToEvent,
  lineChartSvg,
  parseFeedItems,
  renderHeatmapMarkdown,
} from "./swamp_tide.ts";
import type { Event } from "./swamp_tide.ts";

const RSS_SINGLE = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Swamp Club Feed</title>
    <item>
      <title>Hi &amp; bye</title>
      <link>https://swamp-club.com/feed/p/1</link>
      <guid isPermaLink="true">https://swamp-club.com/feed/p/1</guid>
      <dc:creator>alice</dc:creator>
      <pubDate>Tue, 06 Oct 2026 14:45:14 GMT</pubDate>
      <description><![CDATA[<p>raw <b>html</b> here</p>]]></description>
    </item>
  </channel>
</rss>`;

const RSS_MULTI = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <item>
      <title>one</title>
      <link>https://swamp-club.com/feed/p/1</link>
      <dc:creator>alice</dc:creator>
      <pubDate>Tue, 06 Oct 2026 14:00:00 GMT</pubDate>
    </item>
    <item>
      <title>two</title>
      <link>https://swamp-club.com/feed/p/2</link>
      <dc:creator>bob</dc:creator>
      <pubDate>Tue, 06 Oct 2026 14:30:00 GMT</pubDate>
    </item>
    <item>
      <title>three</title>
      <link>https://swamp-club.com/feed/p/3</link>
      <dc:creator>alice</dc:creator>
      <pubDate>Wed, 07 Oct 2026 09:15:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

Deno.test("parseFeedItems extracts a single item", () => {
  const items = parseFeedItems(RSS_SINGLE);
  assertEquals(items.length, 1);
  assertEquals(items[0].title, "Hi & bye");
  assertEquals(items[0]["dc:creator"], "alice");
  assertEquals(items[0].pubDate, "Tue, 06 Oct 2026 14:45:14 GMT");
});

Deno.test("parseFeedItems extracts every item", () => {
  assertEquals(parseFeedItems(RSS_MULTI).length, 3);
});

Deno.test("parseFeedItems returns [] for non-RSS input", () => {
  assertEquals(parseFeedItems("<html></html>"), []);
  assertEquals(parseFeedItems("not xml at all"), []);
});

Deno.test("feedItemToEvent maps rss fields and strips html", () => {
  const event = feedItemToEvent(parseFeedItems(RSS_SINGLE)[0], "feed");
  assertEquals(event, {
    id: "https://swamp-club.com/feed/p/1",
    ts: "2026-10-06T14:45:14.000Z",
    source: "feed",
    kind: "feed_post",
    actor: "alice",
    actorKind: "human",
    url: "https://swamp-club.com/feed/p/1",
    title: "Hi & bye",
    detail: "raw html here",
  });
});

Deno.test("feedItemToEvent falls back to link when guid is absent", () => {
  const item = parseFeedItems(RSS_MULTI)[0];
  const event = feedItemToEvent(item, "feed");
  assertEquals(event?.id, "https://swamp-club.com/feed/p/1");
});

Deno.test("feedItemToEvent drops items without parseable dates", () => {
  assertEquals(
    feedItemToEvent({ title: "x", pubDate: "nonsense" }, "feed"),
    null,
  );
  assertEquals(feedItemToEvent({}, "feed"), null);
});

Deno.test("bucketParts buckets a UTC timestamp into day and hour", () => {
  // 2026-10-06 is a Tuesday
  assertEquals(bucketParts("2026-10-06T14:45:14Z", "UTC"), {
    day: 2,
    hour: 14,
  });
});

Deno.test("bucketParts converts to the configured timezone", () => {
  // 14:45Z is 07:45 in America/Los_Angeles (PDT, UTC-7) in October
  assertEquals(
    bucketParts("2026-10-06T14:45:14Z", "America/Los_Angeles"),
    { day: 2, hour: 7 },
  );
});

Deno.test("buildHeatmap fills all 168 cells and finds the peak", () => {
  const events: Event[] = [
    {
      id: "1",
      ts: "2026-10-06T14:00:00Z",
      source: "feed",
      kind: "feed_post",
      actor: "alice",
      actorKind: "human",
      url: null,
      title: "one",
      detail: null,
    },
    {
      id: "2",
      ts: "2026-10-06T14:30:00Z",
      source: "feed",
      kind: "feed_post",
      actor: "bob",
      actorKind: "human",
      url: null,
      title: "two",
      detail: null,
    },
    {
      id: "3",
      ts: "2026-10-07T09:15:00Z",
      source: "feed",
      kind: "feed_post",
      actor: "alice",
      actorKind: "human",
      url: null,
      title: "three",
      detail: null,
    },
  ];
  const report = buildHeatmap(events, "UTC");
  assertEquals(report.cells.length, 168);
  assertEquals(report.totalEvents, 3);
  assertEquals(report.uniqueActors, 2);
  assertEquals(report.from, "2026-10-06T14:00:00Z");
  assertEquals(report.to, "2026-10-07T09:15:00Z");

  const tue14 = report.cells.find((c) => c.day === 2 && c.hour === 14);
  assertEquals(tue14?.count, 2);
  assertEquals(tue14?.actors.sort(), ["alice", "bob"]);
  assertEquals(tue14?.sourceCounts, { feed: 2 });

  const wed9 = report.cells.find((c) => c.day === 3 && c.hour === 9);
  assertEquals(wed9?.count, 1);

  assertEquals(report.peaks[0].count, 2);
  assertEquals(report.peaks[0].day, 2);
  assertEquals(report.peaks[0].hour, 14);
  assertEquals(report.peaks.length, 3);
});

Deno.test("buildHeatmap reports an empty grid for no events", () => {
  const report = buildHeatmap([], "UTC");
  assertEquals(report.totalEvents, 0);
  assertEquals(report.cells.length, 168);
  assertEquals(report.cells.every((c) => c.count === 0), true);
  assertEquals(report.from, null);
  assertEquals(report.peaks[0].count, 0);
});

Deno.test("calendarDay formats the local calendar day", () => {
  assertEquals(calendarDay("2026-10-06T14:00:00Z", "UTC"), "2026-10-06");
});

Deno.test("buildProfiles aggregates hourly, weekday, month and daily", () => {
  const events: Event[] = [
    {
      id: "1",
      ts: "2026-10-06T14:00:00Z",
      source: "feed",
      kind: "feed_post",
      actor: "alice",
      actorKind: "human",
      url: null,
      title: "one",
      detail: null,
    },
    {
      id: "2",
      ts: "2026-10-06T14:30:00Z",
      source: "feed",
      kind: "feed_post",
      actor: "bob",
      actorKind: "human",
      url: null,
      title: "two",
      detail: null,
    },
    {
      id: "3",
      ts: "2026-10-07T09:15:00Z",
      source: "feed",
      kind: "feed_post",
      actor: "alice",
      actorKind: "human",
      url: null,
      title: "three",
      detail: null,
    },
  ];
  const profiles = buildProfiles(events, "UTC");
  assertEquals(profiles.hourly[14], 2);
  assertEquals(profiles.hourly[9], 1);
  assertEquals(profiles.hourly.length, 24);
  assertEquals(profiles.weekday[2], 2); // Tuesday
  assertEquals(profiles.weekday[3], 1); // Wednesday
  assertEquals(profiles.month[5], 2); // Oct 6
  assertEquals(profiles.month[6], 1); // Oct 7
  assertEquals(profiles.month.length, 31);
  assertEquals(profiles.daily, [
    { day: "2026-10-06", count: 2 },
    { day: "2026-10-07", count: 1 },
  ]);
});

Deno.test("buildProfiles returns zeroed profiles for no events", () => {
  const profiles = buildProfiles([], "UTC");
  assertEquals(profiles.hourly.every((v) => v === 0), true);
  assertEquals(profiles.weekday.every((v) => v === 0), true);
  assertEquals(profiles.month.every((v) => v === 0), true);
  assertEquals(profiles.daily, []);
});

Deno.test("barChartSvg renders one bar per value with a dark peak bar", () => {
  const svg = barChartSvg("Test chart", [0, 3, 1], ["a", "b", "c"]);
  assertEquals(svg.includes("<svg"), true);
  assertEquals(svg.includes("Test chart"), true);
  assertEquals((svg.match(/<rect /g) ?? []).length, 3);
  assertEquals(svg.includes('fill="#0e7a4d"'), true);
});

Deno.test("lineChartSvg renders area and line series", () => {
  const svg = lineChartSvg("Trend", [1, 3, 2], ["a", "b", "c"]);
  assertEquals(svg.includes("<polygon"), true);
  assertEquals(svg.includes("<polyline"), true);
  assertEquals(svg.includes("Trend"), true);
});

Deno.test("renderHeatmapMarkdown renders grid, peak line and legend", () => {
  const events: Event[] = [
    {
      id: "1",
      ts: "2026-10-06T14:00:00Z",
      source: "feed",
      kind: "feed_post",
      actor: "alice",
      actorKind: "human",
      url: null,
      title: "one",
      detail: null,
    },
  ];
  const markdown = renderHeatmapMarkdown(buildHeatmap(events, "UTC"));
  assertEquals(markdown.includes("# Swamp Tide"), true);
  assertEquals(
    markdown.includes("The swamp bites hardest **Tue 14:00**"),
    true,
  );
  assertEquals(markdown.includes("Legend: · quiet, @ peak density"), true);
  assertEquals(markdown.includes("## Activity — hour of day"), true);
  assertEquals(markdown.includes("## Activity — day of week"), true);
  assertEquals(markdown.includes("## Activity — day of month"), true);
  assertEquals(markdown.includes("## Trajectory — events per day"), true);
  assertEquals(markdown.includes("## Peak slots"), true);
  // Header row and all seven day rows are present
  assertEquals(markdown.includes("     00 01 02"), true);
  assertEquals(markdown.split("\n").filter((l) => /^Sun /.test(l)).length, 1);
  assertEquals(markdown.split("\n").filter((l) => /^Sat /.test(l)).length, 1);
});
