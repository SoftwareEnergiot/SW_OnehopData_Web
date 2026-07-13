// Pure helpers that turn the raw (created_at, byte_length) pairs from
// GET /api/payloads/summary into the evenly-spaced buckets the charts plot.
// Kept free of React/DOM so they can be unit-tested directly.

import { toDisplayClock } from "@/lib/timezone";

export interface SummaryPoint {
  created_at: string;
  byte_length: number;
  reporting_counter: number;
}

export interface TimelineBucket {
  /** Bucket start, epoch ms (inclusive). */
  start: number;
  /** Bucket end, epoch ms (exclusive, except for the last bucket). */
  end: number;
  /** Payloads received in this bucket. */
  count: number;
  /** Byte-size stats, null when the bucket received nothing. */
  minBytes: number | null;
  maxBytes: number | null;
  meanBytes: number | null;
  /** Reporting-counter stats, null when the bucket received nothing. */
  minCounter: number | null;
  maxCounter: number | null;
  /** Counter of the last payload in the bucket — the series the chart plots. */
  lastCounter: number | null;
}

export interface Timeline {
  buckets: TimelineBucket[];
  /** Domain covered by the buckets, epoch ms. */
  start: number;
  end: number;
  bucketMs: number;
  /** Totals across the whole domain. */
  total: number;
  minBytes: number | null;
  maxBytes: number | null;
  minCounter: number | null;
  maxCounter: number | null;
  firstCounter: number | null;
  lastCounter: number | null;
  /** Times the counter went backwards between consecutive payloads (a reset). */
  counterResets: number;
  /**
   * True when the range needed more than MAX_BUCKETS buckets at this interval,
   * so only the most recent MAX_BUCKETS are plotted.
   */
  clamped: boolean;
}

interface TimelineOptions {
  /** Explicit domain bounds (epoch ms) from the range filter, when set. */
  from?: number | null;
  to?: number | null;
  /** Width of one bucket, e.g. 3_600_000 for hourly. */
  bucketMs: number;
}

// Ceiling on how many buckets a range may be cut into, so a narrow bucket over
// a wide range cannot produce tens of thousands of marks.
export const MAX_BUCKETS = 1500;

/**
 * Bucket payloads into fixed-width time slices (hourly by default).
 *
 * Buckets are aligned to the clock — an hourly bucket starts on the hour, and a
 * daily one at Madrid midnight (the clock the dashboard is read on) rather than
 * at an arbitrary offset — so "payloads this hour" means an actual hour.
 *
 * The domain is the filter range when one is set (an empty stretch at either
 * end still shows as a gap in reception rather than being cropped away) and
 * otherwise spans the payloads themselves. Buckets that received nothing keep
 * `count: 0` and null stats.
 *
 * Returns null when there is nothing to plot.
 */
export function buildTimeline(
  points: SummaryPoint[],
  { from, to, bucketMs }: TimelineOptions,
): Timeline | null {
  const parsed = points
    .map((p) => ({
      t: Date.parse(p.created_at),
      bytes: p.byte_length,
      counter: p.reporting_counter,
    }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);

  const hasFrom = typeof from === "number" && Number.isFinite(from);
  const hasTo = typeof to === "number" && Number.isFinite(to);

  if (parsed.length === 0 && !(hasFrom && hasTo)) return null;

  let lo = hasFrom ? (from as number) : parsed[0].t;
  let hi = hasTo ? (to as number) : parsed[parsed.length - 1].t;
  if (hi < lo) [lo, hi] = [hi, lo];

  // Snap the domain outward onto bucket boundaries so every bucket is a whole
  // clock interval (a real hour, not 07:23 → 08:23).
  const width = Math.max(1, bucketMs);
  // Snap on the Madrid clock, so a day bucket runs Madrid midnight to midnight.
  const offset = toDisplayClock(lo) - lo;
  let start = Math.floor((lo + offset) / width) * width - offset;
  // The bucket *containing* the upper bound is always included, so a payload
  // landing exactly on it (the `to` filter is inclusive) still plots. The
  // domain is never padded past the filter: an hour-wide range at the hourly
  // interval is exactly one bucket, not two with a fabricated empty hour.
  let n = Math.max(1, Math.floor((hi - start) / width) + 1);

  // Too many buckets to plot (e.g. a fortnight at one-minute resolution): keep
  // the *most recent* window rather than the oldest — on a live feed the tail
  // is what the reader came for. The caller surfaces `clamped` to say so.
  const clamped = n > MAX_BUCKETS;
  if (clamped) {
    start += (n - MAX_BUCKETS) * width;
    n = MAX_BUCKETS;
  }
  const end = start + n * width;

  const buckets: TimelineBucket[] = Array.from({ length: n }, (_, i) => ({
    start: start + i * width,
    end: start + (i + 1) * width,
    count: 0,
    minBytes: null,
    maxBytes: null,
    meanBytes: null,
    minCounter: null,
    maxCounter: null,
    lastCounter: null,
  }));

  const sums = new Array<number>(n).fill(0);
  const inRange: typeof parsed = [];

  for (const point of parsed) {
    const { t, bytes, counter } = point;
    // Points outside the plotted domain (e.g. beyond the bucket ceiling) are
    // not charted, and are excluded from the summary stats so the two agree.
    if (t < start || t >= end) continue;
    inRange.push(point);

    const index = Math.min(n - 1, Math.floor((t - start) / width));
    const bucket = buckets[index];
    bucket.count += 1;
    sums[index] += bytes;
    bucket.minBytes =
      bucket.minBytes === null ? bytes : Math.min(bucket.minBytes, bytes);
    bucket.maxBytes =
      bucket.maxBytes === null ? bytes : Math.max(bucket.maxBytes, bytes);
    bucket.minCounter =
      bucket.minCounter === null ? counter : Math.min(bucket.minCounter, counter);
    bucket.maxCounter =
      bucket.maxCounter === null ? counter : Math.max(bucket.maxCounter, counter);
    // Points are sorted, so the last one seen is the bucket's latest.
    bucket.lastCounter = counter;
  }

  for (let i = 0; i < n; i++) {
    if (buckets[i].count > 0) buckets[i].meanBytes = sums[i] / buckets[i].count;
  }

  // A counter that goes backwards between consecutive payloads is a reset —
  // the discontinuities the reader is looking for in the counter chart.
  let counterResets = 0;
  for (let i = 1; i < inRange.length; i++) {
    if (inRange[i].counter < inRange[i - 1].counter) counterResets += 1;
  }

  const bytes = inRange.map((p) => p.bytes);
  const counters = inRange.map((p) => p.counter);

  return {
    buckets,
    start,
    end,
    bucketMs: width,
    total: inRange.length,
    minBytes: bytes.length ? Math.min(...bytes) : null,
    maxBytes: bytes.length ? Math.max(...bytes) : null,
    minCounter: counters.length ? Math.min(...counters) : null,
    maxCounter: counters.length ? Math.max(...counters) : null,
    firstCounter: counters.length ? counters[0] : null,
    lastCounter: counters.length ? counters[counters.length - 1] : null,
    counterResets,
    clamped,
  };
}

export interface Scale {
  domain: [number, number];
  ticks: number[];
}

// Round a span up to a "nice" number (1, 2, 5, 10 × 10^k) so ticks land on
// values a reader recognises instead of 166.175.
function niceNum(range: number, round: boolean): number {
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exponent;
  let nice: number;
  if (round) {
    nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  } else {
    nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  }
  return nice * 10 ** exponent;
}

/**
 * A y-scale whose ticks are round numbers. A constant series (min === max)
 * still gets a band around it, so the flat line lands mid-plot rather than on
 * an edge — the point of these charts is to *see* that the value is constant.
 */
export function niceScale(
  min: number,
  max: number,
  {
    zeroBased = false,
    tickCount = 4,
    integer = false,
  }: { zeroBased?: boolean; tickCount?: number; integer?: boolean } = {},
): Scale {
  let lo = zeroBased ? 0 : min;
  let hi = max;

  if (lo === hi) {
    const pad = Math.max(1, Math.abs(hi) * 0.05);
    lo = zeroBased ? 0 : lo - pad;
    hi += pad;
  }

  let step = niceNum((hi - lo) / Math.max(1, tickCount - 1), true);
  // A count cannot be 1.5: never offer a tick the series can never land on.
  if (integer) step = Math.max(1, Math.round(step));
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;

  const ticks: number[] = [];
  // Accumulate in step units to avoid float drift (0.1 + 0.2 …).
  for (let i = 0; start + i * step <= end + step / 1000; i++) {
    ticks.push(Number((start + i * step).toPrecision(12)));
  }

  return { domain: [start, end], ticks };
}

/** Median of a list; 0 for an empty list. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  return Number.isInteger(value) ? value : Number(value.toFixed(1));
}

/**
 * Format an epoch as a Madrid wall clock — the same clock the table is rendered
 * on, so axis labels never disagree with it.
 */
export function formatTimeTick(ms: number, spanMs: number): string {
  const d = new Date(toDisplayClock(ms));
  const p2 = (n: number) => String(n).padStart(2, "0");
  const day = `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  const time = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  // Over a multi-day span the date carries the reading; within a day, the clock.
  if (spanMs > 3 * 24 * 3600_000) return day;
  return spanMs > 24 * 3600_000 ? `${day} ${time}` : time;
}

/** Full Madrid-clock stamp for tooltips and the table view. */
export function formatTimestamp(ms: number): string {
  const d = new Date(toDisplayClock(ms));
  const p2 = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
  );
}

/** Human bucket width, e.g. "30 s", "5 min", "hour", "6 h", "day". */
export function formatDuration(ms: number): string {
  // A whole unit reads better named than numbered: "per hour", not "per 1 h".
  if (ms === 3600_000) return "hour";
  if (ms === 24 * 3600_000) return "day";
  if (ms === 60_000) return "minute";

  const trim = (value: number) =>
    Number.isInteger(value) ? String(value) : value.toFixed(1);

  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${trim(ms / 1000)} s`;
  if (ms < 3600_000) return `${trim(ms / 60_000)} min`;
  // Stay in hours up to two days: "25 h" is clearer than "1.0 d".
  if (ms < 48 * 3600_000) return `${trim(ms / 3600_000)} h`;
  return `${trim(ms / (24 * 3600_000))} d`;
}
