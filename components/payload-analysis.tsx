"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BinaryHexView } from "@/components/binary-hex-view";
import {
  layoutOf,
  sampleInstant,
  type ContextFieldDef,
  type DecodedPayload,
  type DecodedSample,
  type PayloadAnalysis,
} from "@/lib/payload-decoder";
import { formatCreatedAt } from "@/lib/utils";
import {
  describeCommError,
  describeResetSource,
  formatErrorMask,
  formatSampleMask,
  invalidSampleFields,
  isBatterySocValid,
  resolveStatusFlags,
  resolveValidSampleMask,
} from "@/lib/payload-errors";
import { decodeErrorMask } from "@/lib/error-catalog";
import { useErrorCatalog } from "@/components/use-error-catalog";
import {
  Binary,
  Cpu,
  FileDigit,
  Layers,
  ListTree,
  TriangleAlert,
} from "lucide-react";

interface PayloadAnalysisViewProps {
  analysis: PayloadAnalysis;
}

// Render a raw channel value together with its scaled engineering value when a
// scaling factor is defined (raw / factor).
function scaledValue(raw: number, factor: number): string {
  if (factor === 1) return "—";
  return (raw / factor).toString();
}

// Human-readable gloss for the context fields whose numeric value encodes
// something (an enum, a bitmask, a hex register). Returns null for the plain
// numbers, which are shown as-is.
function describeContextValue(
  field: ContextFieldDef,
  value: number,
  // Needed to tell a flat battery from a failed fuel gauge, which the spec
  // distinguishes by a bit in the error mask of the same report.
  errorMask: number,
  // Whether this format's status flags carry the sample-time bits.
  hasSampleTime: boolean,
): string | null {
  const batterySocValid = isBatterySocValid(value, errorMask);
  switch (field.key) {
    case "error_mask":
      return formatErrorMask(value);
    case "last_communication_error":
      return describeCommError(value);
    case "status_flags":
      return resolveStatusFlags(value, hasSampleTime).join(", ");
    case "config_crc32":
      // Reserved for remote configuration: always 0 until polling exists.
      return value === 0
        ? "not available (always 0 until polling is implemented)"
        : `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
    case "last_poll_status":
      // Reserved for remote configuration; only 0 is defined so far.
      return value === 0 ? "no poll since boot" : "value not defined yet";
    case "reset_source":
      return describeResetSource(value);
    case "rsrp":
      // The spec uses 0 as "not available".
      return value === 0 ? "not available" : null;
    case "snr":
      // 0 means "not available", but 0 dB is also a legal reading and v1
      // carries no flag to tell the two apart. Say so rather than pick one.
      return value === 0 ? "not available, or a genuine 0 dB" : null;
    case "battery_soc":
      // A 0 with the fuel-gauge bit set is a failed gauge, not a flat battery.
      if (value === 0 && !batterySocValid) return "fuel gauge failed";
      return value > 100 ? "above 100 — the firmware does not clamp the gauge" : null;
    case "reporting_lost_counter":
    case "tx_failed":
      // Counters since boot: the useful reading is the delta between reports.
      return "counter since boot";
    case "boot_count":
      // In the current revision this is a lifetime count, never cleared; in the
      // earlier ones it was reset by a factory reset.
      return hasSampleTime
        ? "lifetime boots, never cleared — a low value does not mean a new device"
        : "boots since last factory reset";
    default:
      return null;
  }
}

function SummaryBadges({ analysis }: PayloadAnalysisViewProps) {
  const { meta, decoded } = analysis;
  const lengthOk = meta.byteLength === meta.expectedLength;
  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant="secondary">{meta.revisionLabel}</Badge>
      {decoded.device_uid && (
        <Badge variant="secondary" className="font-mono">
          {decoded.device_uid}
        </Badge>
      )}
      <Badge variant="secondary">{decoded.sample_count} sample(s)</Badge>
      <Badge variant={lengthOk ? "secondary" : "destructive"}>
        {meta.byteLength} / {meta.expectedLength} bytes
      </Badge>
      <Badge variant="secondary">
        mask {formatErrorMask(decoded.error_mask)}
      </Badge>
      <Badge variant="secondary">counter {decoded.reporting_counter}</Badge>
    </div>
  );
}

function HeaderSection({ analysis }: PayloadAnalysisViewProps) {
  const { decoded } = analysis;
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <FileDigit className="h-4 w-4 text-primary" />
        <CardTitle>Header ({analysis.meta.headerSize} B)</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Field</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Payload id / version</TableCell>
              <TableCell className="text-muted-foreground">uint8</TableCell>
              <TableCell className="text-right font-mono">
                {decoded.payload_version}
              </TableCell>
            </TableRow>
            {/* V1 and later carry the factory MAC in the header; V0 does not. */}
            {decoded.device_uid !== null && (
              <TableRow>
                <TableCell>Device UID</TableCell>
                <TableCell className="text-muted-foreground">uint8[8]</TableCell>
                <TableCell className="text-right font-mono">
                  {decoded.device_uid}
                </TableCell>
              </TableRow>
            )}
            <TableRow>
              <TableCell>Sample count</TableCell>
              <TableCell className="text-muted-foreground">uint8</TableCell>
              <TableCell className="text-right font-mono">
                {decoded.sample_count}
              </TableCell>
            </TableRow>
            {decoded.device_uid !== null && (
              <TableRow>
                <TableCell>Reporting counter</TableCell>
                <TableCell className="text-muted-foreground">uint32</TableCell>
                <TableCell className="text-right font-mono">
                  {decoded.reporting_counter}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// Render a sample's `time`. Status flags bit 5 decides what it is: a UTC epoch
// (shown on the Madrid clock, like every other timestamp in the dashboard) or
// seconds since boot, which has no absolute meaning — the document says to use
// the reception time instead.
function describeSampleTime(
  decoded: DecodedPayload,
  sample: DecodedSample,
): string {
  const instant = sampleInstant(decoded, sample);
  if (instant) return formatCreatedAt(instant.toISOString());
  const seconds = sample.time ?? 0;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const uptime = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m ${seconds % 60}s`;
  return `uptime ${uptime} — no clock sync yet, use the reception time`;
}

function SamplesSection({ analysis }: PayloadAnalysisViewProps) {
  const { decoded } = analysis;
  const fields = layoutOf(decoded).sampleFields;
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Layers className="h-4 w-4 text-primary" />
        <CardTitle>
          Samples ({decoded.sample_count} × {analysis.meta.sampleSize} B)
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        {decoded.samples.map((sample, index) => {
          // V1 marks which sensors were read successfully. Fields of a sensor
          // whose bit is clear are transmitted as 0 and must be discarded, not
          // read as a measurement.
          const hasMask = "valid_sample_mask" in sample;
          const invalid = hasMask
            ? invalidSampleFields(sample.valid_sample_mask)
            : new Set<string>();
          return (
            <div key={index} className="rounded-lg border">
              <div className="border-b bg-muted/40 px-3 py-2 text-sm font-semibold">
                sample[{index}]
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Channel</TableHead>
                    <TableHead className="text-right">Raw</TableHead>
                    <TableHead className="text-right">Scaled</TableHead>
                    <TableHead>Unit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fields.map((field) => {
                    const value = sample[field.key] ?? 0;
                    const discarded = invalid.has(field.key);
                    return (
                      <TableRow key={field.key} className={discarded ? "opacity-50" : undefined}>
                        <TableCell>
                          <span className="font-mono text-xs">{field.key}</span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {field.label}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {field.key === "valid_sample_mask"
                            ? formatSampleMask(value)
                            : value}
                        </TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">
                          {field.key === "time"
                            ? describeSampleTime(decoded, sample)
                            : discarded
                              ? "no reading"
                              : scaledValue(value, field.factor)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {field.unit || "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// V1 only: which sensors reported a usable reading in this sample.
function ValidMaskSection({ analysis }: PayloadAnalysisViewProps) {
  const sample = analysis.decoded.samples[0];
  if (!sample || !("valid_sample_mask" in sample)) return null;
  const mask = sample.valid_sample_mask;
  // Bit 7 (cable temperature 3) covers no field in V1 and the document says to
  // ignore it, so it is left out rather than shown as a perpetual failure.
  const bits = resolveValidSampleMask(mask).filter((bit) => bit.bit !== 7);

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Cpu className="h-4 w-4 text-primary" />
        <CardTitle>Valid sample mask ({formatSampleMask(mask)})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {bits.map((bit) => (
            <Badge
              key={bit.bit}
              variant={bit.valid ? "secondary" : "outline"}
              className={bit.valid ? undefined : "text-muted-foreground line-through"}
            >
              {bit.label}
            </Badge>
          ))}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Bit</TableHead>
              <TableHead>Sensor</TableHead>
              <TableHead>Fields covered</TableHead>
              <TableHead className="text-right">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bits.map((bit) => (
              <TableRow key={bit.bit}>
                <TableCell className="font-mono">{bit.bit}</TableCell>
                <TableCell>{bit.label}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {bit.fields.length > 0 ? bit.fields.join(", ") : "—"}
                </TableCell>
                <TableCell className="text-right">
                  {bit.valid ? (
                    <span className="text-xs font-medium text-emerald-600">
                      read OK
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      discarded
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ContextSection({ analysis }: PayloadAnalysisViewProps) {
  const { decoded } = analysis;
  const layout = layoutOf(decoded);
  const fields = layout.contextFields;
  const isV1 = decoded.payload_version >= 1;

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <ListTree className="h-4 w-4 text-primary" />
        <CardTitle>Batch context ({analysis.meta.contextSize} B)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Field</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Value</TableHead>
              <TableHead>Unit</TableHead>
              <TableHead>Meaning</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.map((field) => {
              const value = decoded.context[field.key] ?? 0;
              const gloss = describeContextValue(
                field,
                value,
                decoded.error_mask,
                layout.hasSampleTime,
              );
              return (
                <TableRow key={field.key}>
                  <TableCell>
                    <span className="font-mono text-xs">{field.key}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {field.label}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {field.type}
                  </TableCell>
                  <TableCell className="text-right font-mono">{value}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {field.unit || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {gloss ?? "—"}
                  </TableCell>
                </TableRow>
              );
            })}
            {/* V1 keeps the reporting counter in the header; it is mirrored into
                the context so both formats expose it in the same place. */}
            {isV1 && (
              <TableRow>
                <TableCell>
                  <span className="font-mono text-xs">reporting_counter</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    Reporting counter
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">uint32</TableCell>
                <TableCell className="text-right font-mono">
                  {decoded.reporting_counter}
                </TableCell>
                <TableCell className="text-muted-foreground">—</TableCell>
                <TableCell className="text-muted-foreground">
                  mirrored from the header
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {isV1 && (
          <p className="text-xs text-muted-foreground">
            Fields 8 to 14 (RSRP through last TX duration) are refreshed by the
            modem only while it registers on the network, so they describe the
            previous transmission cycle, not the instant this report was built.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The active flags of a payload's error mask, resolved against
 * `public.payload_error_codes`.
 *
 * The mask is re-decoded here rather than read from the `errors` column stored
 * with the payload: the lookup table is the authoritative source of the names
 * and descriptions, and a row stored before a catalog entry was renamed would
 * otherwise keep showing the old wording forever. Matching is bitwise on
 * `bit_value` — an entry is active when `(mask & bit_value) !== 0` — so a
 * combined mask expands to every flag it sets. A mask of 0 is ERR_RSN_NONE
 * alone, and ERR_RSN_NONE never appears next to a real error.
 */
function ErrorSection({ analysis }: PayloadAnalysisViewProps) {
  const { decoded } = analysis;
  const { codes, source } = useErrorCatalog();
  const errors = decodeErrorMask(decoded.error_mask, codes);

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <TriangleAlert className="h-4 w-4 text-primary" />
        <CardTitle>Error mask ({formatErrorMask(decoded.error_mask)})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {errors.map((err) => (
            <Badge
              key={err.code}
              variant="outline"
              style={{ borderColor: err.color, color: err.color }}
            >
              {err.name}
            </Badge>
          ))}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Tag</TableHead>
              <TableHead>Description</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {errors.map((err) => (
              <TableRow key={err.code}>
                <TableCell className="font-mono">{err.code}</TableCell>
                <TableCell>
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full align-middle"
                    style={{ backgroundColor: err.color }}
                  />
                  <span className="ml-2 align-middle font-mono text-xs">
                    {err.name}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {err.description}
                  {/* Reserved bits are specified as always 0; one that is set
                      is malformed data, and saying so beats rendering it as a
                      fault the device can actually report. */}
                  {err.reserved && (
                    <span className="ml-1 text-xs">
                      This bit is reserved and should always be 0 — treat it as
                      malformed data.
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="text-xs text-muted-foreground">
          {source === "database" ? (
            <>
              Names and descriptions read from{" "}
              <span className="font-mono">public.payload_error_codes</span>.
            </>
          ) : source === "loading" ? (
            <>Loading the catalog from public.payload_error_codes…</>
          ) : (
            <>
              <span className="font-mono">public.payload_error_codes</span>{" "}
              could not be read; showing the built-in catalog instead.
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

export function PayloadAnalysisView({ analysis }: PayloadAnalysisViewProps) {
  return (
    <div className="space-y-6">
      <SummaryBadges analysis={analysis} />

      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <Binary className="h-4 w-4 text-primary" />
          <CardTitle>Binary vs. hexadecimal</CardTitle>
        </CardHeader>
        <CardContent>
          <BinaryHexView bytes={analysis.bytes} meta={analysis.meta} />
        </CardContent>
      </Card>

      <HeaderSection analysis={analysis} />
      <SamplesSection analysis={analysis} />
      <ValidMaskSection analysis={analysis} />
      <ContextSection analysis={analysis} />
      <ErrorSection analysis={analysis} />
    </div>
  );
}
