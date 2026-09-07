"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  buildTimeline,
  formatDuration,
  formatTimestamp,
  formatTimeTick,
  MAX_BUCKETS,
  median,
  niceScale,
  type Scale,
  type SummaryPoint,
  type Timeline,
} from "@/lib/payload-timeline";
import {
  buildTimelineCsv,
  chartsToPngBlob,
  downloadBlob,
  exportStamp,
  type ChartFigure,
} from "@/lib/chart-export";
import { downloadCsv } from "@/lib/payload-csv";
import { createdAtBoundFromInput } from "@/lib/utils";
import { toast } from "sonner";
import {
  Activity,
  BatteryMedium,
  ChartLine,
  Download,
  FileImage,
  Hash,
  Sheet,
  SignalHigh,
  TriangleAlert,
  X,
} from "lucide-react";

const MINUTE = 60_000;
const HOUR = 3_600_000;

// Bucket widths the reader can switch between. One minute is the default: at
// this device's ~1 payload/minute cadence each point is 0 or 1, so the line
// shows every single reception and every missed minute.
const INTERVALS = [
  { label: "1 minute", ms: MINUTE },
  { label: "5 minutes", ms: 5 * MINUTE },
  { label: "15 minutes", ms: 15 * MINUTE },
  { label: "1 hour", ms: HOUR },
  { label: "6 hours", ms: 6 * HOUR },
  { label: "1 day", ms: 24 * HOUR },
];
const DEFAULT_INTERVAL = MINUTE;

const PLOT_HEIGHT = 200;
const PAD = { top: 12, right: 16, bottom: 24, left: 56 };

interface PayloadChartsProps {
  /** Bumped by the parent's Refresh button to force a refetch. */
  refreshKey: number;
}

export function PayloadCharts({ refreshKey }: PayloadChartsProps) {
  const [points, setPoints] = useState<SummaryPoint[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showValues, setShowValues] = useState(false);
  const [bucketMs, setBucketMs] = useState(DEFAULT_INTERVAL);
  // The charts carry their own received-timestamp range, independent of the
  // table's filter, so the reader can pan back over previous data on the charts
  // alone. Values are wall-clock strings from <input type="datetime-local">,
  // read on the same clock as the created_at timestamps they filter.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const hasFilter = from !== "" || to !== "";

  // The range as ISO instants — the slice the timeline is drawn from.
  const fromBound = createdAtBoundFromInput(from, "from");
  const toBound = createdAtBoundFromInput(to, "to");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams();
    if (fromBound) params.set("from", fromBound);
    if (toBound) params.set("to", toBound);

    fetch(`/api/payloads/summary?${params.toString()}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((result) => {
        if (cancelled) return;
        if (result.success) {
          setPoints(result.points ?? []);
          setTruncated(Boolean(result.truncated));
          setFailed(false);
        } else {
          setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fromBound, toBound, refreshKey]);

  const timeline = useMemo(
    () =>
      buildTimeline(points, {
        from: fromBound ? Date.parse(fromBound) : null,
        to: toBound ? Date.parse(toBound) : null,
        bucketMs,
      }),
    [points, fromBound, toBound, bucketMs],
  );

  // A narrow interval over a wide range hits the bucket ceiling: say so rather
  // than silently charting a slice of it.
  const clamped = timeline?.clamped ?? false;

  // Wraps the three plots so an export can gather their <svg>s and the card's
  // resolved colours together.
  const chartsRef = useRef<HTMLDivElement>(null);
  const [exportingPng, setExportingPng] = useState(false);
  const canExport = Boolean(timeline && timeline.total > 0);

  // The bucket rows the "Show values" table renders, downloaded as a CSV.
  const handleExportCsv = useCallback(() => {
    if (!timeline) return;
    try {
      downloadCsv(
        buildTimelineCsv(timeline),
        `reception-timeline-${exportStamp()}.csv`,
      );
      toast.success(`Exported ${timeline.buckets.length} bucket(s).`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not export the data.",
      );
    }
  }, [timeline]);

  // The three plots, stacked into one PNG image at device resolution.
  const handleExportPng = useCallback(async () => {
    const container = chartsRef.current;
    if (!container) return;
    setExportingPng(true);
    try {
      // Each plot is the role="img" <svg>; the icons in the titles are plain
      // decorative <svg>s and are skipped by that selector.
      const figures = Array.from(container.querySelectorAll("figure"))
        .map((figure): ChartFigure | null => {
          const svg = figure.querySelector<SVGSVGElement>("svg[role='img']");
          if (!svg) return null;
          return { title: figure.querySelector("h3")?.textContent?.trim() ?? "", svg };
        })
        .filter((f): f is ChartFigure => f !== null);
      const blob = await chartsToPngBlob(figures, container);
      downloadBlob(blob, `reception-timeline-${exportStamp()}.png`);
      toast.success("Exported charts as PNG.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not export the charts.",
      );
    } finally {
      setExportingPng(false);
    }
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ChartLine className="h-4 w-4 text-primary" />
          Reception timeline
        </CardTitle>
        <CardAction>
          <div className="flex flex-wrap items-end justify-end gap-3">
            {/* The charts' own range — pan back over previous data without
                touching the table's filter below. */}
            <div className="grid gap-1.5">
              <Label
                htmlFor="chart-from"
                className="text-xs text-muted-foreground"
              >
                From
              </Label>
              <Input
                id="chart-from"
                type="datetime-local"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
                className="h-9 w-auto"
              />
            </div>
            <div className="grid gap-1.5">
              <Label
                htmlFor="chart-to"
                className="text-xs text-muted-foreground"
              >
                To
              </Label>
              <Input
                id="chart-to"
                type="datetime-local"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
                className="h-9 w-auto"
              />
            </div>
            {hasFilter && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFrom("");
                  setTo("");
                }}
                className="gap-1"
              >
                <X className="h-4 w-4" />
                Clear
              </Button>
            )}
            <div className="grid gap-1.5">
              <Label
                htmlFor="bucket-interval"
                className="text-xs text-muted-foreground"
              >
                Interval
              </Label>
              <select
                id="bucket-interval"
                value={bucketMs}
                onChange={(e) => setBucketMs(Number(e.target.value))}
                className="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {INTERVALS.map((interval) => (
                  <option key={interval.ms} value={interval.ms}>
                    {interval.label}
                  </option>
                ))}
              </select>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowValues((v) => !v)}
              disabled={!timeline}
            >
              {showValues ? "Hide values" : "Show values"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canExport || exportingPng}
                  className="gap-2"
                >
                  <Download className="h-4 w-4" />
                  {exportingPng ? "Exporting…" : "Export"}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={handleExportCsv}>
                  <Sheet className="h-4 w-4" />
                  Data as CSV
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleExportPng}>
                  <FileImage className="h-4 w-4" />
                  Charts as PNG
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {failed ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Could not load the timeline.
          </p>
        ) : !timeline || timeline.total === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {loading ? "Loading…" : "No payloads to chart in this time range."}
          </p>
        ) : (
          <>
            {truncated && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <TriangleAlert className="h-3.5 w-3.5" />
                Charting the first 20,000 payloads of this range — narrow the
                range to chart all of them.
              </p>
            )}
            {clamped && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <TriangleAlert className="h-3.5 w-3.5" />
                At a {formatDuration(timeline.bucketMs)} interval this range
                needs more than {formatCount(MAX_BUCKETS)} points — charting the
                most recent {formatDuration(timeline.end - timeline.start)}{" "}
                only ({formatTimestamp(timeline.start)} onwards). Widen the
                interval or narrow the range to see the rest.
              </p>
            )}
            {/* Refetch holds the previous render at reduced opacity: no skeleton flash. */}
            <div
              ref={chartsRef}
              className={`space-y-8 transition-opacity ${
                loading ? "opacity-60" : "opacity-100"
              }`}
            >
              <FrequencyChart timeline={timeline} />
              <ByteSizeChart timeline={timeline} />
              <CounterChart timeline={timeline} />
              {/* V1 only: a range of V0 payloads carries no diagnostics, and an
                  empty plot says less than no plot at all. */}
              {timeline.batteryCount > 0 && <BatteryChart timeline={timeline} />}
              {timeline.signalCount > 0 && <SignalChart timeline={timeline} />}
            </div>
            {showValues && <ValuesTable timeline={timeline} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ charts */

function FrequencyChart({ timeline }: { timeline: Timeline }) {
  const counts = timeline.buckets.map((b) => b.count);
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  // The reference is the typical *active* bucket: across a wide range most
  // buckets can be idle, and a reference pinned to the baseline says nothing.
  const typical = median(counts.filter((c) => c > 0));
  const scale = niceScale(0, max, { zeroBased: true, integer: true });
  const unit = formatDuration(timeline.bucketMs);

  return (
    <figure className="space-y-1">
      <figcaption className="space-y-0.5">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-3.5 w-3.5 text-primary" />
          Payloads received per {formatDuration(timeline.bucketMs)}
        </h3>
        <p className="text-xs text-muted-foreground">
          {formatCount(timeline.total)} payload(s) ·{" "}
          {min === max ? (
            <>
              perfectly constant at <span className="font-mono">{max}</span> per{" "}
              {unit}
            </>
          ) : (
            <>
              typically <span className="font-mono">{typical}</span> per{" "}
              {unit} that received anything · range{" "}
              <span className="font-mono">
                {min}–{max}
              </span>{" "}
              — a {unit} with nothing received sits at{" "}
              <span className="font-mono">0</span>, so the line is continuous
              and every gap in reception is visible
            </>
          )}
        </p>
      </figcaption>
      <LineChart
        timeline={timeline}
        values={counts}
        scale={scale}
        reference={typical > 0 ? typical : null}
        formatValue={formatCount}
        valueName="payloads"
      />
    </figure>
  );
}

function ByteSizeChart({ timeline }: { timeline: Timeline }) {
  const values = timeline.buckets.map((b) => b.meanBytes);
  const { minBytes, maxBytes } = timeline;
  const constant = minBytes !== null && minBytes === maxBytes;
  const scale = niceScale(minBytes ?? 0, maxBytes ?? 1);

  return (
    <figure className="space-y-1">
      <figcaption className="space-y-0.5">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-3.5 w-3.5 text-primary" />
          Payload size (bytes)
        </h3>
        <p className="text-xs text-muted-foreground">
          {constant ? (
            <>
              Constant at <span className="font-mono">{minBytes}</span>{" "}
              bytes across every payload in this range
            </>
          ) : (
            <>
              Varies from <span className="font-mono">{minBytes}</span> to{" "}
              <span className="font-mono">{maxBytes}</span>{" "}
              bytes — the shaded band is each bucket&apos;s min–max spread, so a
              lone odd-sized payload still shows
            </>
          )}
        </p>
      </figcaption>
      <LineChart
        timeline={timeline}
        values={values}
        band={timeline.buckets.map((b) =>
          b.minBytes === null || b.maxBytes === null
            ? null
            : [b.minBytes, b.maxBytes],
        )}
        scale={scale}
        reference={constant ? null : minBytes}
        formatValue={formatCount}
        valueName="bytes"
      />
    </figure>
  );
}

function CounterChart({ timeline }: { timeline: Timeline }) {
  const { minCounter, maxCounter, firstCounter, lastCounter, counterResets } =
    timeline;
  // The counter is a whole number too — no half-frame ticks.
  const scale = niceScale(minCounter ?? 0, maxCounter ?? 1, { integer: true });

  return (
    <figure className="space-y-1">
      <figcaption className="space-y-0.5">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Hash className="h-3.5 w-3.5 text-primary" />
          Frame counter (reporting_counter)
        </h3>
        <p className="text-xs text-muted-foreground">
          Latest value in each bucket ·{" "}
          <span className="font-mono">{firstCounter}</span> →{" "}
          <span className="font-mono">{lastCounter}</span> · range{" "}
          <span className="font-mono">
            {minCounter}–{maxCounter}
          </span>{" "}
          ·{" "}
          {counterResets === 0 ? (
            "counting up without a reset"
          ) : (
            <>
              <span className="font-mono">{counterResets}</span> reset(s) — each
              drop is the counter starting over
            </>
          )}
          {/* V1 explains its own gaps: the device counts the reports it knows
              it lost, which is what a jump in this series means. */}
          {timeline.reportsLost !== null && (
            <>
              {" "}
              ·{" "}
              {timeline.reportsLost === 0 ? (
                "the device reports no lost payloads over this range"
              ) : (
                <>
                  the device reports{" "}
                  <span className="font-mono">
                    {formatCount(timeline.reportsLost)}
                  </span>{" "}
                  lost payload(s) here
                  {timeline.txFailed !== null && timeline.txFailed > 0 && (
                    <>
                      , after{" "}
                      <span className="font-mono">
                        {formatCount(timeline.txFailed)}
                      </span>{" "}
                      failed send attempt(s)
                    </>
                  )}{" "}
                  — that accounts for the gaps in the counter
                </>
              )}
            </>
          )}
        </p>
      </figcaption>
      <LineChart
        timeline={timeline}
        values={timeline.buckets.map((b) => b.lastCounter)}
        band={timeline.buckets.map((b) =>
          b.minCounter === null || b.maxCounter === null
            ? null
            : [b.minCounter, b.maxCounter],
        )}
        scale={scale}
        formatValue={formatCount}
        valueName="counter"
      />
    </figure>
  );
}

// V1 battery diagnostics. Plots the mean state of charge per bucket with the
// bucket's min-max spread behind it. The scale is pinned to 0-100 rather than
// fitted to the data: a battery drifting 87 → 85 % should read as the near-flat
// line it is, not as a cliff produced by an auto-fitted axis.
function BatteryChart({ timeline }: { timeline: Timeline }) {
  const {
    batteryCount,
    minBatterySoc,
    maxBatterySoc,
    firstBatterySoc,
    lastBatterySoc,
    minBatteryVoltage,
    maxBatteryVoltage,
    total,
  } = timeline;
  // Pinned to 0-100 rather than fitted to the data, so a battery drifting
  // 87 -> 85 % reads as the near-flat line it is instead of a cliff. The
  // firmware does not clamp the gauge, so a reading above 100 extends the axis
  // rather than being clipped off the top of the plot.
  const scale = niceScale(0, Math.max(100, maxBatterySoc ?? 100), {
    zeroBased: true,
    integer: true,
  });
  const drop =
    firstBatterySoc !== null && lastBatterySoc !== null
      ? firstBatterySoc - lastBatterySoc
      : null;

  return (
    <figure className="space-y-1">
      <figcaption className="space-y-0.5">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <BatteryMedium className="h-3.5 w-3.5 text-primary" />
          Battery state of charge (%)
        </h3>
        <p className="text-xs text-muted-foreground">
          <span className="font-mono">{firstBatterySoc}</span> →{" "}
          <span className="font-mono">{lastBatterySoc}</span> % · range{" "}
          <span className="font-mono">
            {minBatterySoc}–{maxBatterySoc}
          </span>{" "}
          %
          {drop !== null && drop > 0 ? (
            <>
              {" "}
              · <span className="font-mono">{drop}</span> point(s) consumed over
              this range
            </>
          ) : null}
          {minBatteryVoltage !== null && (
            <>
              {" "}
              · VBAT{" "}
              <span className="font-mono">
                {minBatteryVoltage}–{maxBatteryVoltage}
              </span>{" "}
              mV
            </>
          )}
          {batteryCount < total && (
            <>
              {" "}
              · measured on{" "}
              <span className="font-mono">{formatCount(batteryCount)}</span> of{" "}
              <span className="font-mono">{formatCount(total)}</span> payloads —
              the rest either carry no battery reading (V0) or reported a failed
              fuel gauge, which is excluded rather than charted as 0 %
            </>
          )}
        </p>
      </figcaption>
      <LineChart
        timeline={timeline}
        values={timeline.buckets.map((b) => b.meanBatterySoc)}
        band={timeline.buckets.map((b) =>
          b.minBatterySoc === null || b.maxBatterySoc === null
            ? null
            : [b.minBatterySoc, b.maxBatterySoc],
        )}
        scale={scale}
        formatValue={formatCount}
        valueName="%"
      />
    </figure>
  );
}

// V1 radio coverage. RSRP is negative and closer to zero is better, so the
// axis reads "less negative = stronger" — worth saying in the caption, because
// the line going up meaning better signal is not obvious from a dBm axis.
function SignalChart({ timeline }: { timeline: Timeline }) {
  const { signalCount, minRsrp, maxRsrp, minSnr, maxSnr, total } = timeline;
  const scale = niceScale(minRsrp ?? -140, maxRsrp ?? -44, { integer: true });

  return (
    <figure className="space-y-1">
      <figcaption className="space-y-0.5">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <SignalHigh className="h-3.5 w-3.5 text-primary" />
          Cellular coverage — RSRP (dBm)
        </h3>
        <p className="text-xs text-muted-foreground">
          Range{" "}
          <span className="font-mono">
            {minRsrp}–{maxRsrp}
          </span>{" "}
          dBm — higher (less negative) is stronger
          {minSnr !== null && (
            <>
              {" "}
              · SNR{" "}
              <span className="font-mono">
                {minSnr}–{maxSnr}
              </span>{" "}
              dB
            </>
          )}
          {signalCount < total && (
            <>
              {" "}
              · measured on{" "}
              <span className="font-mono">{formatCount(signalCount)}</span> of{" "}
              <span className="font-mono">{formatCount(total)}</span> payloads —
              the rest reported 0, which the protocol defines as{" "}
              &ldquo;not available&rdquo;
            </>
          )}
          {" "}· these values describe the{" "}
          <em>previous</em> transmission cycle, not the moment the report was
          built
        </p>
      </figcaption>
      <LineChart
        timeline={timeline}
        values={timeline.buckets.map((b) => b.meanRsrp)}
        band={timeline.buckets.map((b) =>
          b.minRsrp === null || b.maxRsrp === null
            ? null
            : [b.minRsrp, b.maxRsrp],
        )}
        scale={scale}
        formatValue={formatCount}
        valueName="dBm"
      />
    </figure>
  );
}

/* -------------------------------------------------------------- line chart */

interface LineChartProps {
  timeline: Timeline;
  /** One value per bucket; null renders a gap (no payloads in that bucket). */
  values: (number | null)[];
  /** Optional per-bucket [min, max] spread, drawn as a wash behind the line. */
  band?: ([number, number] | null)[];
  scale: Scale;
  /** A hairline the reader compares the series against; null to omit. */
  reference?: number | null;
  formatValue: (value: number) => string;
  valueName: string;
}

function LineChart({
  timeline,
  values,
  band,
  scale,
  reference,
  formatValue,
  valueName,
}: LineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(containerRef, 360);
  const [active, setActive] = useState<number | null>(null);

  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = PLOT_HEIGHT - PAD.top - PAD.bottom;
  const [y0, y1] = scale.domain;
  const span = timeline.end - timeline.start;

  const sx = useCallback(
    (index: number) => {
      const centre = timeline.buckets[index].start + timeline.bucketMs / 2;
      return PAD.left + ((centre - timeline.start) / span) * plotW;
    },
    [timeline, span, plotW],
  );
  const sy = useCallback(
    (value: number) =>
      PAD.top + plotH - ((value - y0) / (y1 - y0 || 1)) * plotH,
    [plotH, y0, y1],
  );

  // Split into runs of consecutive non-null values so empty buckets read as
  // gaps in reception rather than an invented drop to zero.
  const { paths, isolated } = useMemo(() => {
    const paths: string[] = [];
    // A run of one has no segment to stroke — a lone `moveto` paints nothing —
    // so those buckets are drawn as dots instead of silently disappearing.
    const isolated: { x: number; y: number }[] = [];
    let run: { index: number; value: number }[] = [];

    const flush = () => {
      if (run.length === 1) {
        isolated.push({ x: sx(run[0].index), y: sy(run[0].value) });
      } else if (run.length > 1) {
        paths.push(
          run
            .map((p, i) => `${i ? "L" : "M"}${sx(p.index)},${sy(p.value)}`)
            .join(" "),
        );
      }
      run = [];
    };

    values.forEach((value, index) => {
      if (value === null) flush();
      else run.push({ index, value });
    });
    flush();

    return { paths, isolated };
  }, [values, sx, sy]);

  const bandPath = useMemo(() => {
    if (!band) return null;
    const top: string[] = [];
    const bottom: string[] = [];
    band.forEach((range, i) => {
      if (!range) return;
      top.push(`${top.length ? "L" : "M"}${sx(i)},${sy(range[1])}`);
      bottom.unshift(`L${sx(i)},${sy(range[0])}`);
    });
    if (!top.length) return null;
    return `${top.join(" ")} ${bottom.join(" ")} Z`;
  }, [band, sx, sy]);

  const lastIndex = useMemo(() => {
    for (let i = values.length - 1; i >= 0; i--) {
      if (values[i] !== null) return i;
    }
    return null;
  }, [values]);

  const activeValue = active === null ? null : values[active];
  const yTicks = scale.ticks;
  // Full-width plots carry more x labels; keep them clear of each other.
  const tickCount = Math.max(2, Math.min(6, Math.floor(width / 180)));
  const xTickIndexes = Array.from({ length: tickCount }, (_, i) =>
    Math.round((i * (values.length - 1)) / (tickCount - 1)),
  );

  const moveActive = useCallback(
    (delta: number) => {
      setActive((prev) => {
        const next = (prev ?? 0) + delta;
        return Math.max(0, Math.min(values.length - 1, next));
      });
    },
    [values.length],
  );

  const handlePointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    // The crosshair snaps to the nearest bucket: the reader aims at a time,
    // never at a 2px line.
    const ratio = (x - PAD.left) / plotW;
    const index = Math.round(ratio * (values.length - 1));
    setActive(Math.max(0, Math.min(values.length - 1, index)));
  };

  const bucket = active === null ? null : timeline.buckets[active];
  const activeSpread = active === null ? null : (band?.[active] ?? null);

  return (
    <div ref={containerRef} className="relative">
      <svg
        width={width}
        height={PLOT_HEIGHT}
        role="img"
        aria-label={`${valueName} per bucket over the selected time range`}
        tabIndex={0}
        className="touch-none outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onPointerMove={handlePointer}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((prev) => prev ?? 0)}
        onBlur={() => setActive(null)}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            moveActive(1);
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            moveActive(-1);
          } else if (event.key === "Escape") {
            setActive(null);
          }
        }}
      >
        {/* Gridlines: solid hairlines, one step off the surface. */}
        {yTicks.map((tick) => (
          <line
            key={tick}
            x1={PAD.left}
            x2={PAD.left + plotW}
            y1={sy(tick)}
            y2={sy(tick)}
            stroke="var(--border)"
            strokeWidth={1}
          />
        ))}
        {yTicks.map((tick) => (
          <text
            key={`label-${tick}`}
            x={PAD.left - 8}
            y={sy(tick)}
            textAnchor="end"
            dominantBaseline="middle"
            className="fill-muted-foreground text-[10px] [font-variant-numeric:tabular-nums]"
          >
            {formatValue(tick)}
          </text>
        ))}
        {xTickIndexes.map((index, position) => (
          <text
            key={`x-${index}`}
            x={sx(index)}
            y={PLOT_HEIGHT - 6}
            textAnchor={
              position === 0
                ? "start"
                : position === xTickIndexes.length - 1
                  ? "end"
                  : "middle"
            }
            className="fill-muted-foreground text-[10px] [font-variant-numeric:tabular-nums]"
          >
            {formatTimeTick(
              timeline.buckets[index].start + timeline.bucketMs / 2,
              span,
            )}
          </text>
        ))}

        {/* Min–max spread behind the line: a wash, never a saturated block. */}
        {bandPath && (
          <path d={bandPath} fill="var(--primary)" fillOpacity={0.1} />
        )}

        {/* Reference line — deviations from it are the extremes. */}
        {reference !== null && reference !== undefined && (
          <line
            x1={PAD.left}
            x2={PAD.left + plotW}
            y1={sy(reference)}
            y2={sy(reference)}
            stroke="var(--muted-foreground)"
            strokeWidth={1}
            opacity={0.5}
          />
        )}

        {paths.map((d, i) => (
          <path
            key={i}
            d={d}
            fill="none"
            stroke="var(--primary)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {isolated.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={2} fill="var(--primary)" />
        ))}

        {/* End marker + its direct label — the one value labelled on the plot. */}
        {lastIndex !== null && values[lastIndex] !== null && (
          <>
            <circle
              cx={sx(lastIndex)}
              cy={sy(values[lastIndex] as number)}
              r={4}
              fill="var(--primary)"
              stroke="var(--card)"
              strokeWidth={2}
            />
            <text
              x={sx(lastIndex) - 8}
              y={sy(values[lastIndex] as number) - 8}
              textAnchor="end"
              className="fill-foreground text-[10px] font-semibold [font-variant-numeric:tabular-nums]"
            >
              {formatValue(values[lastIndex] as number)}
            </text>
          </>
        )}

        {/* Crosshair. */}
        {active !== null && (
          <line
            x1={sx(active)}
            x2={sx(active)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            stroke="var(--muted-foreground)"
            strokeWidth={1}
          />
        )}
        {active !== null && activeValue !== null && (
          <circle
            cx={sx(active)}
            cy={sy(activeValue)}
            r={4}
            fill="var(--primary)"
            stroke="var(--card)"
            strokeWidth={2}
          />
        )}
      </svg>

      {bucket && (
        <div
          className="pointer-events-none absolute top-0 z-10 w-max max-w-56 rounded-md border bg-popover px-2.5 py-2 text-xs shadow-md"
          style={{
            left: Math.min(Math.max(sx(active as number) + 10, 0), width - 150),
          }}
        >
          <p className="font-mono text-[10px] text-muted-foreground">
            {formatTimestamp(bucket.start)}
          </p>
          <p className="mt-1 flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-3 rounded-full"
              style={{ backgroundColor: "var(--primary)" }}
            />
            <span className="font-mono font-semibold text-foreground">
              {activeValue === null ? "—" : formatValue(activeValue)}
            </span>
            <span className="text-muted-foreground">{valueName}</span>
          </p>
          {activeSpread && (
            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
              min {formatValue(activeSpread[0])} · max{" "}
              {formatValue(activeSpread[1])}
            </p>
          )}
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            {formatCount(bucket.count)} payload(s) in this{" "}
            {formatDuration(timeline.bucketMs)}
          </p>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- table twin */

function ValuesTable({ timeline }: { timeline: Timeline }) {
  return (
    <div className="max-h-72 overflow-y-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Bucket start</TableHead>
            <TableHead className="text-right">Payloads</TableHead>
            <TableHead className="text-right">Min bytes</TableHead>
            <TableHead className="text-right">Mean bytes</TableHead>
            <TableHead className="text-right">Max bytes</TableHead>
            <TableHead className="text-right">Counter (last)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {timeline.buckets.map((bucket) => (
            <TableRow key={bucket.start}>
              <TableCell className="font-mono text-xs">
                {formatTimestamp(bucket.start)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {bucket.count}
              </TableCell>
              <TableCell className="text-right font-mono">
                {bucket.minBytes ?? "—"}
              </TableCell>
              <TableCell className="text-right font-mono">
                {bucket.meanBytes === null
                  ? "—"
                  : Number.isInteger(bucket.meanBytes)
                    ? bucket.meanBytes
                    : bucket.meanBytes.toFixed(1)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {bucket.maxBytes ?? "—"}
              </TableCell>
              <TableCell className="text-right font-mono">
                {bucket.lastCounter ?? "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/* ------------------------------------------------------------------ helpers */

// Fixed en-US grouping: the browser's locale must not turn an axis tick into
// "166,175" (a decimal comma) where the reader expects a thousands separator.
function formatCount(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

// Track the container's width so the SVG lays out at real pixel sizes (text
// stays crisp — no preserveAspectRatio stretching).
function useElementWidth(
  ref: React.RefObject<HTMLDivElement | null>,
  fallback: number,
): number {
  const [width, setWidth] = useState(fallback);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next && next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
