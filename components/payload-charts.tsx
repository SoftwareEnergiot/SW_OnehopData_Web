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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  buildTimeline,
  formatDuration,
  formatTimestamp,
  formatTimeTick,
  median,
  niceScale,
  type Scale,
  type SummaryPoint,
  type Timeline,
} from "@/lib/payload-timeline";
import { Activity, ChartLine, TriangleAlert } from "lucide-react";

const BUCKET_COUNT = 48;
const PLOT_HEIGHT = 172;
const PAD = { top: 12, right: 14, bottom: 24, left: 48 };

interface PayloadChartsProps {
  /** Range filter bounds as ISO instants, or null when unbounded. */
  from: string | null;
  to: string | null;
  /** Bumped by the parent's Refresh button to force a refetch. */
  refreshKey: number;
}

export function PayloadCharts({ from, to, refreshKey }: PayloadChartsProps) {
  const [points, setPoints] = useState<SummaryPoint[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showValues, setShowValues] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);

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
  }, [from, to, refreshKey]);

  const timeline = useMemo(
    () =>
      buildTimeline(points, {
        from: from ? Date.parse(from) : null,
        to: to ? Date.parse(to) : null,
        bucketCount: BUCKET_COUNT,
      }),
    [points, from, to],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ChartLine className="h-4 w-4 text-primary" />
          Reception timeline
        </CardTitle>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowValues((v) => !v)}
            disabled={!timeline}
          >
            {showValues ? "Hide values" : "Show values"}
          </Button>
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
            {/* Refetch holds the previous render at reduced opacity: no skeleton flash. */}
            <div
              className={`grid gap-6 transition-opacity lg:grid-cols-2 ${
                loading ? "opacity-60" : "opacity-100"
              }`}
            >
              <FrequencyChart timeline={timeline} />
              <ByteSizeChart timeline={timeline} />
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
  const scale = niceScale(0, max, { zeroBased: true });

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
              perfectly constant at <span className="font-mono">{max}</span> per
              bucket
            </>
          ) : (
            <>
              typically <span className="font-mono">{typical}</span> per active
              bucket · range{" "}
              <span className="font-mono">
                {min}–{max}
              </span>{" "}
              — anything far off the reference line is an extreme
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
  const xTickIndexes = [0, Math.floor(values.length / 2), values.length - 1];

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
              position === 0 ? "start" : position === 2 ? "end" : "middle"
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
          {band && bucket.minBytes !== null && (
            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
              min {bucket.minBytes} · max {bucket.maxBytes} · {bucket.count}{" "}
              payload(s)
            </p>
          )}
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
