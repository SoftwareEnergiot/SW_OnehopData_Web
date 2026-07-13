// Pure helpers that turn the raw (created_at, byte_length) pairs from
// GET /api/payloads/summary into the evenly-spaced buckets the charts plot.
// Kept free of React/DOM so they can be unit-tested directly.

export interface SummaryPoint {
  created_at: string;
  byte_length: number;
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
}

interface TimelineOptions {
  /** Explicit domain bounds (epoch ms) from the range filter, when set. */
  from?: number | null;
  to?: number | null;
  bucketCount: number;
}

// A domain narrower than this is widened so a single payload still plots on a
// readable axis instead of a zero-width one.
const MIN_DOMAIN_MS = 60_000;

/**
 * Bucket payloads into `bucketCount` equal time slices.
 *
 * The domain is the filter range when one is set — so an empty stretch at
 * either end of the selected range still shows as a gap in reception rather
 * than being cropped away — and otherwise spans the payloads themselves.
 * Buckets that received nothing keep `count: 0` and null byte stats.
 */
export function buildTimeline(
  points: SummaryPoint[],
  { from, to, bucketCount }: TimelineOptions,
): Timeline | null {
  const parsed = points
    .map((p) => ({ t: Date.parse(p.created_at), bytes: p.byte_length }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);

  const hasFrom = typeof from === "number" && Number.isFinite(from);
  const hasTo = typeof to === "number" && Number.isFinite(to);

  if (parsed.length === 0 && !(hasFrom && hasTo)) return null;

  let start = hasFrom ? (from as number) : parsed[0].t;
  let end = hasTo ? (to as number) : parsed[parsed.length - 1].t;

  if (end < start) [start, end] = [end, start];
  if (end - start < MIN_DOMAIN_MS) {
    const pad = (MIN_DOMAIN_MS - (end - start)) / 2;
    start -= pad;
    end += pad;
  }

  const n = Math.max(1, Math.floor(bucketCount));
  const bucketMs = (end - start) / n;

  const buckets: TimelineBucket[] = Array.from({ length: n }, (_, i) => ({
    start: start + i * bucketMs,
    end: start + (i + 1) * bucketMs,
    count: 0,
    minBytes: null,
    maxBytes: null,
    meanBytes: null,
  }));

  const sums = new Array<number>(n).fill(0);

  for (const { t, bytes } of parsed) {
    // Points outside an explicit filter domain are not plotted.
    if (t < start || t > end) continue;
    const index = Math.min(n - 1, Math.floor((t - start) / bucketMs));
    const bucket = buckets[index];
    bucket.count += 1;
    sums[index] += bytes;
    bucket.minBytes =
      bucket.minBytes === null ? bytes : Math.min(bucket.minBytes, bytes);
    bucket.maxBytes =
      bucket.maxBytes === null ? bytes : Math.max(bucket.maxBytes, bytes);
  }

  for (let i = 0; i < n; i++) {
    if (buckets[i].count > 0) buckets[i].meanBytes = sums[i] / buckets[i].count;
  }

  const inRange = parsed.filter((p) => p.t >= start && p.t <= end);
  const byteValues = inRange.map((p) => p.bytes);

  return {
    buckets,
    start,
    end,
    bucketMs,
    total: inRange.length,
    minBytes: byteValues.length ? Math.min(...byteValues) : null,
    maxBytes: byteValues.length ? Math.max(...byteValues) : null,
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
  { zeroBased = false, tickCount = 4 }: { zeroBased?: boolean; tickCount?: number } = {},
): Scale {
  let lo = zeroBased ? 0 : min;
  let hi = max;

  if (lo === hi) {
    const pad = Math.max(1, Math.abs(hi) * 0.05);
    lo = zeroBased ? 0 : lo - pad;
    hi += pad;
  }

  const step = niceNum((hi - lo) / Math.max(1, tickCount - 1), true);
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
 * Format an epoch as a UTC wall clock — the same clock `created_at` is stored
 * and displayed on, so axis labels never disagree with the table.
 */
export function formatTimeTick(ms: number, spanMs: number): string {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const day = `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  const time = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  // Over a multi-day span the date carries the reading; within a day, the clock.
  if (spanMs > 3 * 24 * 3600_000) return day;
  return spanMs > 24 * 3600_000 ? `${day} ${time}` : time;
}

/** Full UTC stamp for tooltips and the table view. */
export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
  );
}

/** Human bucket width, e.g. "30 s", "5 min", "2 h". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 24 * 3600_000) return `${(ms / 3600_000).toFixed(1)} h`;
  return `${(ms / (24 * 3600_000)).toFixed(1)} d`;
}
