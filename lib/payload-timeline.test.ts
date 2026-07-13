import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  formatDuration,
  formatTimestamp,
  median,
  niceScale,
  type SummaryPoint,
} from "./payload-timeline";

const point = (iso: string, bytes = 150): SummaryPoint => ({
  created_at: iso,
  byte_length: bytes,
});

describe("buildTimeline", () => {
  it("returns null when there is nothing to plot and no explicit range", () => {
    expect(buildTimeline([], { bucketCount: 4 })).toBeNull();
  });

  it("still builds an empty timeline when both bounds are given", () => {
    const timeline = buildTimeline([], {
      from: Date.parse("2026-07-13T00:00:00Z"),
      to: Date.parse("2026-07-13T04:00:00Z"),
      bucketCount: 4,
    });
    expect(timeline).not.toBeNull();
    expect(timeline!.total).toBe(0);
    expect(timeline!.buckets.map((b) => b.count)).toEqual([0, 0, 0, 0]);
  });

  it("counts payloads into the bucket that contains them", () => {
    const timeline = buildTimeline(
      [
        point("2026-07-13T00:10:00Z"),
        point("2026-07-13T00:20:00Z"),
        point("2026-07-13T02:30:00Z"),
        point("2026-07-13T03:59:00Z"),
      ],
      {
        from: Date.parse("2026-07-13T00:00:00Z"),
        to: Date.parse("2026-07-13T04:00:00Z"),
        bucketCount: 4,
      },
    )!;

    expect(timeline.buckets.map((b) => b.count)).toEqual([2, 0, 1, 1]);
    expect(timeline.total).toBe(4);
    expect(timeline.bucketMs).toBe(3600_000);
  });

  it("leaves byte stats null for buckets that received nothing (a gap, not a zero)", () => {
    const timeline = buildTimeline(
      [point("2026-07-13T00:10:00Z", 150)],
      {
        from: Date.parse("2026-07-13T00:00:00Z"),
        to: Date.parse("2026-07-13T02:00:00Z"),
        bucketCount: 2,
      },
    )!;

    expect(timeline.buckets[0].meanBytes).toBe(150);
    expect(timeline.buckets[1].count).toBe(0);
    expect(timeline.buckets[1].meanBytes).toBeNull();
    expect(timeline.buckets[1].minBytes).toBeNull();
  });

  it("reports min/max/mean byte size per bucket and overall", () => {
    const timeline = buildTimeline(
      [
        point("2026-07-13T00:10:00Z", 150),
        point("2026-07-13T00:20:00Z", 94),
        point("2026-07-13T01:10:00Z", 122),
      ],
      {
        from: Date.parse("2026-07-13T00:00:00Z"),
        to: Date.parse("2026-07-13T02:00:00Z"),
        bucketCount: 2,
      },
    )!;

    expect(timeline.buckets[0].minBytes).toBe(94);
    expect(timeline.buckets[0].maxBytes).toBe(150);
    expect(timeline.buckets[0].meanBytes).toBe(122);
    expect(timeline.minBytes).toBe(94);
    expect(timeline.maxBytes).toBe(150);
  });

  it("puts a payload landing exactly on the upper bound in the last bucket", () => {
    const timeline = buildTimeline([point("2026-07-13T04:00:00Z")], {
      from: Date.parse("2026-07-13T00:00:00Z"),
      to: Date.parse("2026-07-13T04:00:00Z"),
      bucketCount: 4,
    })!;

    expect(timeline.buckets[3].count).toBe(1);
    expect(timeline.total).toBe(1);
  });

  it("drops payloads outside an explicit range", () => {
    const timeline = buildTimeline(
      [point("2026-07-12T23:00:00Z"), point("2026-07-13T01:00:00Z")],
      {
        from: Date.parse("2026-07-13T00:00:00Z"),
        to: Date.parse("2026-07-13T02:00:00Z"),
        bucketCount: 2,
      },
    )!;

    expect(timeline.total).toBe(1);
  });

  it("spans the payloads themselves when no range is set", () => {
    const timeline = buildTimeline(
      [point("2026-07-13T00:00:00Z"), point("2026-07-13T06:00:00Z")],
      { bucketCount: 6 },
    )!;

    expect(timeline.start).toBe(Date.parse("2026-07-13T00:00:00Z"));
    expect(timeline.end).toBe(Date.parse("2026-07-13T06:00:00Z"));
  });

  it("widens a zero-width domain so a lone payload still plots", () => {
    const timeline = buildTimeline([point("2026-07-13T00:00:00Z")], {
      bucketCount: 4,
    })!;

    expect(timeline.end - timeline.start).toBeGreaterThanOrEqual(60_000);
    expect(timeline.total).toBe(1);
  });

  it("ignores unparseable timestamps", () => {
    const timeline = buildTimeline(
      [point("not-a-date"), point("2026-07-13T00:30:00Z")],
      {
        from: Date.parse("2026-07-13T00:00:00Z"),
        to: Date.parse("2026-07-13T01:00:00Z"),
        bucketCount: 2,
      },
    )!;

    expect(timeline.total).toBe(1);
  });
});

describe("niceScale", () => {
  it("brackets a constant series so the flat line lands off the edges", () => {
    const { domain } = niceScale(66, 66);
    expect(domain[0]).toBeLessThan(66);
    expect(domain[1]).toBeGreaterThan(66);
  });

  it("produces round ticks, never values like 166.175", () => {
    const { ticks } = niceScale(0, 289, { zeroBased: true });
    expect(ticks.every((t) => Number.isInteger(t))).toBe(true);
    expect(ticks).toEqual([0, 100, 200, 300]);
  });

  it("covers the whole data range", () => {
    const { domain } = niceScale(66, 150);
    expect(domain[0]).toBeLessThanOrEqual(66);
    expect(domain[1]).toBeGreaterThanOrEqual(150);
  });

  it("anchors a zero-based scale at zero", () => {
    expect(niceScale(0, 30, { zeroBased: true }).domain[0]).toBe(0);
  });

  it("keeps ticks free of floating-point drift", () => {
    const { ticks } = niceScale(0, 1, { zeroBased: true });
    for (const tick of ticks) {
      expect(Number(tick.toFixed(6))).toBe(tick);
    }
  });
});

describe("median", () => {
  it("is 0 for an empty list", () => {
    expect(median([])).toBe(0);
  });

  it("averages the middle pair for an even count", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("ignores order", () => {
    expect(median([9, 1, 5])).toBe(5);
  });
});

describe("formatTimestamp", () => {
  it("formats on the UTC clock, matching created_at as stored", () => {
    expect(formatTimestamp(Date.parse("2026-07-13T07:24:19Z"))).toBe(
      "2026-07-13 07:24:19",
    );
  });
});

describe("formatDuration", () => {
  it("scales the unit to the bucket width", () => {
    expect(formatDuration(30_000)).toBe("30 s");
    expect(formatDuration(300_000)).toBe("5 min");
    expect(formatDuration(7200_000)).toBe("2.0 h");
  });
});
