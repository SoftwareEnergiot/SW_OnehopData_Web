import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  formatDuration,
  formatTimestamp,
  MAX_BUCKETS,
  median,
  niceScale,
  type SummaryPoint,
} from "./payload-timeline";

const HOUR = 3_600_000;

const point = (iso: string, bytes = 150, counter = 0): SummaryPoint => ({
  created_at: iso,
  byte_length: bytes,
  reporting_counter: counter,
});

describe("buildTimeline", () => {
  it("returns null when there is nothing to plot and no explicit range", () => {
    expect(buildTimeline([], { bucketMs: HOUR })).toBeNull();
  });

  it("still builds an empty timeline when both bounds are given", () => {
    const timeline = buildTimeline([], {
      from: Date.parse("2026-07-13T00:00:00Z"),
      to: Date.parse("2026-07-13T03:00:00Z"),
      bucketMs: HOUR,
    });
    expect(timeline).not.toBeNull();
    expect(timeline!.total).toBe(0);
    expect(timeline!.buckets.map((b) => b.count)).toEqual([0, 0, 0, 0]);
  });

  it("counts payloads into the hour that contains them", () => {
    const timeline = buildTimeline(
      [
        point("2026-07-13T00:10:00Z"),
        point("2026-07-13T00:20:00Z"),
        point("2026-07-13T02:30:00Z"),
        point("2026-07-13T03:59:00Z"),
      ],
      {
        from: Date.parse("2026-07-13T00:00:00Z"),
        to: Date.parse("2026-07-13T03:59:59Z"),
        bucketMs: HOUR,
      },
    )!;

    expect(timeline.buckets.map((b) => b.count)).toEqual([2, 0, 1, 1]);
    expect(timeline.total).toBe(4);
    expect(timeline.bucketMs).toBe(HOUR);
  });

  it("aligns buckets to the clock, so an hourly bucket starts on the hour", () => {
    const timeline = buildTimeline([point("2026-07-13T07:24:19Z")], {
      from: Date.parse("2026-07-13T07:23:00Z"),
      to: Date.parse("2026-07-13T09:11:00Z"),
      bucketMs: HOUR,
    })!;

    expect(timeline.start).toBe(Date.parse("2026-07-13T07:00:00Z"));
    expect(timeline.buckets[0].start).toBe(Date.parse("2026-07-13T07:00:00Z"));
    expect(timeline.buckets[1].start).toBe(Date.parse("2026-07-13T08:00:00Z"));
    expect(timeline.buckets[0].count).toBe(1);
  });

  it("honours a changed interval", () => {
    const points = [
      point("2026-07-13T00:05:00Z"),
      point("2026-07-13T00:20:00Z"),
    ];
    const bounds = {
      from: Date.parse("2026-07-13T00:00:00Z"),
      to: Date.parse("2026-07-13T00:59:00Z"),
    };

    const hourly = buildTimeline(points, { ...bounds, bucketMs: HOUR })!;
    expect(hourly.buckets).toHaveLength(1);
    expect(hourly.buckets[0].count).toBe(2);

    const quarterly = buildTimeline(points, {
      ...bounds,
      bucketMs: 15 * 60_000,
    })!;
    expect(quarterly.buckets).toHaveLength(4);
    expect(quarterly.buckets.map((b) => b.count)).toEqual([1, 1, 0, 0]);
  });

  it("gives every minute its own point, 0 when nothing was received", () => {
    const timeline = buildTimeline(
      [
        point("2026-07-13T00:00:30Z"),
        point("2026-07-13T00:01:10Z"),
        point("2026-07-13T00:01:50Z"),
        // 00:02 receives nothing.
        point("2026-07-13T00:03:05Z"),
      ],
      {
        from: Date.parse("2026-07-13T00:00:00Z"),
        to: Date.parse("2026-07-13T00:03:59Z"),
        bucketMs: 60_000,
      },
    )!;

    expect(timeline.buckets.map((b) => b.count)).toEqual([1, 2, 0, 1]);
    // The idle minute is a zero, not a hole: the line stays continuous.
    expect(timeline.buckets[2].count).toBe(0);
  });

  it("clamps to the MOST RECENT window when the range needs too many buckets", () => {
    const timeline = buildTimeline([point("2026-01-01T00:00:00Z")], {
      from: Date.parse("2026-01-01T00:00:00Z"),
      to: Date.parse("2026-12-31T00:00:00Z"),
      bucketMs: 60_000,
    })!;

    expect(timeline.clamped).toBe(true);
    expect(timeline.buckets).toHaveLength(MAX_BUCKETS);
    // The window ends at the range's upper bound, not its lower one.
    expect(timeline.end).toBe(
      Date.parse("2026-12-31T00:00:00Z") + 60_000,
    );
    expect(timeline.start).toBe(timeline.end - MAX_BUCKETS * 60_000);
    // The lone payload sits before the clamped window, so it is not charted.
    expect(timeline.total).toBe(0);
  });

  it("does not clamp a range that fits", () => {
    const timeline = buildTimeline([point("2026-07-13T00:30:00Z")], {
      from: Date.parse("2026-07-13T00:00:00Z"),
      to: Date.parse("2026-07-13T00:59:00Z"),
      bucketMs: 60_000,
    })!;

    expect(timeline.clamped).toBe(false);
    expect(timeline.buckets).toHaveLength(60);
  });

  it("leaves stats null for buckets that received nothing (a gap, not a zero)", () => {
    const timeline = buildTimeline([point("2026-07-13T00:10:00Z", 150, 7)], {
      from: Date.parse("2026-07-13T00:00:00Z"),
      to: Date.parse("2026-07-13T01:30:00Z"),
      bucketMs: HOUR,
    })!;

    expect(timeline.buckets[0].meanBytes).toBe(150);
    expect(timeline.buckets[0].lastCounter).toBe(7);
    expect(timeline.buckets[1].count).toBe(0);
    expect(timeline.buckets[1].meanBytes).toBeNull();
    expect(timeline.buckets[1].minBytes).toBeNull();
    expect(timeline.buckets[1].lastCounter).toBeNull();
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
        to: Date.parse("2026-07-13T01:59:00Z"),
        bucketMs: HOUR,
      },
    )!;

    expect(timeline.buckets[0].minBytes).toBe(94);
    expect(timeline.buckets[0].maxBytes).toBe(150);
    expect(timeline.buckets[0].meanBytes).toBe(122);
    expect(timeline.minBytes).toBe(94);
    expect(timeline.maxBytes).toBe(150);
  });

  it("tracks the frame counter: last per bucket, plus overall span", () => {
    const timeline = buildTimeline(
      [
        point("2026-07-13T00:10:00Z", 66, 5),
        point("2026-07-13T00:50:00Z", 66, 9),
        point("2026-07-13T01:10:00Z", 66, 12),
      ],
      {
        from: Date.parse("2026-07-13T00:00:00Z"),
        to: Date.parse("2026-07-13T01:59:00Z"),
        bucketMs: HOUR,
      },
    )!;

    expect(timeline.buckets[0].lastCounter).toBe(9);
    expect(timeline.buckets[0].minCounter).toBe(5);
    expect(timeline.buckets[0].maxCounter).toBe(9);
    expect(timeline.buckets[1].lastCounter).toBe(12);
    expect(timeline.firstCounter).toBe(5);
    expect(timeline.lastCounter).toBe(12);
    expect(timeline.counterResets).toBe(0);
  });

  it("counts a counter that goes backwards as a reset", () => {
    const timeline = buildTimeline(
      [
        point("2026-07-13T00:10:00Z", 66, 8),
        point("2026-07-13T00:20:00Z", 66, 9),
        point("2026-07-13T00:30:00Z", 66, 0),
        point("2026-07-13T00:40:00Z", 66, 1),
      ],
      {
        from: Date.parse("2026-07-13T00:00:00Z"),
        to: Date.parse("2026-07-13T00:59:00Z"),
        bucketMs: HOUR,
      },
    )!;

    expect(timeline.counterResets).toBe(1);
    expect(timeline.minCounter).toBe(0);
    expect(timeline.maxCounter).toBe(9);
  });

  it("puts a payload landing exactly on the upper bound in the last bucket", () => {
    const timeline = buildTimeline([point("2026-07-13T04:00:00Z")], {
      from: Date.parse("2026-07-13T00:00:00Z"),
      to: Date.parse("2026-07-13T04:00:00Z"),
      bucketMs: HOUR,
    })!;

    const last = timeline.buckets[timeline.buckets.length - 1];
    expect(last.count).toBe(1);
    expect(timeline.total).toBe(1);
  });

  it("drops payloads outside an explicit range", () => {
    const timeline = buildTimeline(
      [point("2026-07-12T23:00:00Z"), point("2026-07-13T01:00:00Z")],
      {
        from: Date.parse("2026-07-13T00:00:00Z"),
        to: Date.parse("2026-07-13T01:59:00Z"),
        bucketMs: HOUR,
      },
    )!;

    expect(timeline.total).toBe(1);
  });

  it("spans the payloads themselves when no range is set", () => {
    const timeline = buildTimeline(
      [point("2026-07-13T00:10:00Z"), point("2026-07-13T05:40:00Z")],
      { bucketMs: HOUR },
    )!;

    expect(timeline.start).toBe(Date.parse("2026-07-13T00:00:00Z"));
    expect(timeline.end).toBe(Date.parse("2026-07-13T06:00:00Z"));
    expect(timeline.total).toBe(2);
  });

  it("still plots a lone payload", () => {
    const timeline = buildTimeline([point("2026-07-13T00:30:00Z")], {
      bucketMs: HOUR,
    })!;

    expect(timeline.buckets).toHaveLength(1);
    expect(timeline.total).toBe(1);
    expect(timeline.buckets[0].count).toBe(1);
  });

  it("ignores unparseable timestamps", () => {
    const timeline = buildTimeline(
      [point("not-a-date"), point("2026-07-13T00:30:00Z")],
      {
        from: Date.parse("2026-07-13T00:00:00Z"),
        to: Date.parse("2026-07-13T00:59:00Z"),
        bucketMs: HOUR,
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

  it("never offers a fractional tick for an integer series", () => {
    // A per-minute count of 0–2 must tick 0/1/2, not 0/0.5/1/1.5/2.
    const { ticks } = niceScale(0, 2, { zeroBased: true, integer: true });
    expect(ticks).toEqual([0, 1, 2]);
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
    expect(formatDuration(7200_000)).toBe("2 h");
  });

  it("names a whole unit instead of numbering it", () => {
    expect(formatDuration(3600_000)).toBe("hour");
    expect(formatDuration(24 * 3600_000)).toBe("day");
  });

  it("stays in hours below two days, so 25 h is not reported as 1.0 d", () => {
    expect(formatDuration(25 * 3600_000)).toBe("25 h");
  });
});
