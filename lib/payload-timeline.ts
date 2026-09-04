// Pure helpers that turn the raw (created_at, byte_length) pairs from
// GET /api/payloads/summary into the evenly-spaced buckets the charts plot.
// Kept free of React/DOM so they can be unit-tested directly.

import { toDisplayClock } from "@/lib/timezone";

export interface SummaryPoint {
  created_at: string;
  byte_length: number;
  reporting_counter: number;
  // V1 battery and radio diagnostics, generated from `context` by scripts/004.
  // Null or absent for V0 payloads (which carry no such fields) and for every
  // payload if that migration has not been applied.
  battery_soc?: number | null;
  battery_voltage?: number | null;
  /** RSRP in dBm. The firmware sends 0 for "not available". */
  rsrp?: number | null;
  /** SNR in dB. 0 also means "not available". */
  snr?: number | null;
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
  /**
   * Battery state of charge (%), null when no payload in the bucket reported
   * one. A genuine 0 is a flat battery, not a missing reading, so zeros count.
   */
  minBatterySoc: number | null;
  maxBatterySoc: number | null;
  meanBatterySoc: number | null;
  /** VBAT (mV) of the last payload in the bucket that reported one. */
  lastBatteryVoltage: number | null;
  /** RSRP (dBm) stats over the payloads that reported a usable (non-zero) one. */
  minRsrp: number | null;
  maxRsrp: number | null;
  meanRsrp: number | null;
  /** Mean SNR (dB) over the payloads that reported a usable (non-zero) one. */
  meanSnr: number | null;
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
   * Payloads in the domain that reported a battery reading. Zero means the
   * range holds no V1 diagnostics (all V0, or scripts/004 not applied), and the
   * battery chart is not worth drawing.
   */
  batteryCount: number;
  minBatterySoc: number | null;
  maxBatterySoc: number | null;
  firstBatterySoc: number | null;
  lastBatterySoc: number | null;
  minBatteryVoltage: number | null;
  maxBatteryVoltage: number | null;
  /** Payloads that reported a usable (non-zero) RSRP. */
  signalCount: number;
  minRsrp: number | null;
  maxRsrp: number | null;
  minSnr: number | null;
  maxSnr: number | null;
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

// A real number, or null for anything missing (V0 rows, an un-migrated
// database, a malformed value).
function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Same, but treating 0 as "not available" — the convention the firmware uses
// for RSRP and SNR. Plotting those zeros would draw a flat, very strong signal
// exactly when there was no measurement at all.
function availableOrNull(value: number | null | undefined): number | null {
  const n = finiteOrNull(value);
  return n === null || n === 0 ? null : n;
}

// Min/max/mean over the values that are present; all-null in, all-null out.
function statsOf(values: (number | null)[]): {
  min: number | null;
  max: number | null;
  mean: number | null;
} {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return { min: null, max: null, mean: null };
  return {
    min: Math.min(...present),
    max: Math.max(...present),
    mean: present.reduce((a, b) => a + b, 0) / present.length,
  };
}

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
      // V0 rows have no diagnostics at all; a V1 row can still omit a radio
      // metric by sending 0, which the spec defines as "not available".
      batterySoc: finiteOrNull(p.battery_soc),
      batteryVoltage: finiteOrNull(p.battery_voltage),
      rsrp: availableOrNull(p.rsrp),
      snr: availableOrNull(p.snr),
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
    minBatterySoc: null,
    maxBatterySoc: null,
    meanBatterySoc: null,
    lastBatteryVoltage: null,
    minRsrp: null,
    maxRsrp: null,
    meanRsrp: null,
    meanSnr: null,
  }));

  const sums = new Array<number>(n).fill(0);
  // Per-bucket diagnostic readings, kept aside so each bucket's stats are
  // computed only over the payloads that actually carried them.
  const socByBucket: number[][] = Array.from({ length: n }, () => []);
  const rsrpByBucket: number[][] = Array.from({ length: n }, () => []);
  const snrByBucket: number[][] = Array.from({ length: n }, () => []);
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

    if (point.batterySoc !== null) socByBucket[index].push(point.batterySoc);
    if (point.batteryVoltage !== null) {
      bucket.lastBatteryVoltage = point.batteryVoltage;
    }
    if (point.rsrp !== null) rsrpByBucket[index].push(point.rsrp);
    if (point.snr !== null) snrByBucket[index].push(point.snr);
  }

  for (let i = 0; i < n; i++) {
    if (buckets[i].count > 0) buckets[i].meanBytes = sums[i] / buckets[i].count;

    const soc = statsOf(socByBucket[i]);
    buckets[i].minBatterySoc = soc.min;
    buckets[i].maxBatterySoc = soc.max;
    buckets[i].meanBatterySoc = soc.mean;

    const rsrp = statsOf(rsrpByBucket[i]);
    buckets[i].minRsrp = rsrp.min;
    buckets[i].maxRsrp = rsrp.max;
    buckets[i].meanRsrp = rsrp.mean;

    buckets[i].meanSnr = statsOf(snrByBucket[i]).mean;
  }

  // A counter that goes backwards between consecutive payloads is a reset —
  // the discontinuities the reader is looking for in the counter chart.
  let counterResets = 0;
  for (let i = 1; i < inRange.length; i++) {
    if (inRange[i].counter < inRange[i - 1].counter) counterResets += 1;
  }

  const bytes = inRange.map((p) => p.bytes);
  const counters = inRange.map((p) => p.counter);

  // Domain-wide diagnostic stats, over the payloads that reported each metric.
  const socValues = inRange
    .map((p) => p.batterySoc)
    .filter((v): v is number => v !== null);
  const soc = statsOf(socValues);
  const voltage = statsOf(inRange.map((p) => p.batteryVoltage));
  const rsrpValues = inRange
    .map((p) => p.rsrp)
    .filter((v): v is number => v !== null);
  const rsrp = statsOf(rsrpValues);
  const snr = statsOf(inRange.map((p) => p.snr));

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
    batteryCount: socValues.length,
    minBatterySoc: soc.min,
    maxBatterySoc: soc.max,
    firstBatterySoc: socValues.length ? socValues[0] : null,
    lastBatterySoc: socValues.length ? socValues[socValues.length - 1] : null,
    minBatteryVoltage: voltage.min,
    maxBatteryVoltage: voltage.max,
    signalCount: rsrpValues.length,
    minRsrp: rsrp.min,
    maxRsrp: rsrp.max,
    minSnr: snr.min,
    maxSnr: snr.max,
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
