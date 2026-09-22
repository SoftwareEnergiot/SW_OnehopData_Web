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
import { PayloadCell, describeSampleTime } from "@/components/payload-cell";
import {
  ErrorMaskCard,
  describeContextValue,
} from "@/components/payload-analysis";
import {
  STATUS_FLAG_TIME_UTC,
  V1_CONTEXT_FIELDS,
} from "@/lib/payload-decoder";
import {
  TIME_SOURCES,
  formatSampleMask,
  resolveValidSampleMask,
} from "@/lib/payload-errors";
import {
  columnValue,
  fieldGroups,
  isReadingValid,
  numericValue,
  type PayloadFieldDef,
  type PayloadSchema,
} from "@/lib/payload-schemas";
import type { PayloadRow } from "@/lib/types";
import { Cpu, Clock, ListTree, TriangleAlert } from "lucide-react";

/**
 * The inspector for a dataset that stores already-decoded rows.
 *
 * Where the Development inspector re-decodes the stored frame byte by byte,
 * there is no frame here — `payloads_REE` holds one decoded sample per row. So
 * the view renders the row against the schema's field metadata instead: the
 * declared groups, labels, units and meanings, with every reading checked
 * against the row's valid-sample mask.
 */
export function PayloadRecordView({
  row,
  schema,
}: {
  row: PayloadRow;
  schema: PayloadSchema;
}) {
  const groups = fieldGroups(schema);
  const mask = columnValue(row, "valid_sample_mask");
  const hasMask = typeof mask === "number" && Number.isFinite(mask);
  const errorMask = numericValue(row, "error_mask");

  return (
    <div className="space-y-6">
      <SummaryBadges row={row} schema={schema} />

      {groups.map(({ group, fields }) => (
        <Card key={group}>
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <ListTree className="h-4 w-4 text-primary" />
            <CardTitle>{group}</CardTitle>
          </CardHeader>
          <CardContent>
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
                  const discarded = !isReadingValid(row, field);
                  return (
                    <TableRow
                      key={field.key}
                      className={discarded ? "opacity-60" : undefined}
                    >
                      <TableCell>
                        <span className="font-mono text-xs">{field.key}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {field.label}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {field.protocolType ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <PayloadCell row={row} field={field} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {field.unit || "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {meaningOf(row, field) ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}

      <SampleTimeSection row={row} />
      {hasMask && <ValidMaskSection mask={mask as number} />}

      {schema.capabilities.errorMask &&
        (errorMask !== null ? (
          <ErrorMaskCard mask={errorMask} />
        ) : (
          <Card>
            <CardHeader className="flex-row items-center gap-2 space-y-0">
              <TriangleAlert className="h-4 w-4 text-muted-foreground" />
              <CardTitle>Error mask</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Not stored for this row. It was received before{" "}
                <span className="font-mono">{schema.table}</span> had the
                context columns, and the raw frame is not kept.
              </p>
            </CardContent>
          </Card>
        ))}
    </div>
  );
}

const CONTEXT_KEYS = new Set(V1_CONTEXT_FIELDS.map((field) => field.key));

/**
 * What a field's value means. For a context field that encodes something (an
 * enum, a bitmask, a register) this is the same reading the Development
 * inspector gives the decoded frame; otherwise it is the field's description.
 */
function meaningOf(row: PayloadRow, field: PayloadFieldDef): string | undefined {
  const value = numericValue(row, field.key);
  if (value !== null && CONTEXT_KEYS.has(field.key)) {
    // The REE devices send the current V1 revision, whose status flags carry
    // the sample-time bits.
    const gloss = describeContextValue(
      field.key,
      value,
      numericValue(row, "error_mask") ?? 0,
      true,
    );
    if (gloss) return gloss;
  }
  return field.description;
}

function SummaryBadges({
  row,
  schema,
}: {
  row: PayloadRow;
  schema: PayloadSchema;
}) {
  const version = columnValue(row, "payload_version");
  const uid = columnValue(row, "device_uid");
  const samples = columnValue(row, "sample_count");
  const counter = columnValue(row, "reporting_counter");
  const mask = columnValue(row, "valid_sample_mask");

  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant="secondary">V{String(version)} {schema.rowNoun}</Badge>
      {typeof uid === "string" && (
        <Badge variant="secondary" className="font-mono">
          {uid}
        </Badge>
      )}
      {samples !== null && samples !== undefined && (
        <Badge variant="secondary">{String(samples)} sample(s) in report</Badge>
      )}
      {counter !== null && counter !== undefined && (
        <Badge variant="secondary">counter {String(counter)}</Badge>
      )}
      {typeof mask === "number" && (
        <Badge variant="secondary">mask {formatSampleMask(mask)}</Badge>
      )}
    </div>
  );
}

/**
 * The sample time read both ways.
 *
 * The protocol's status flags decide whether the value is a UTC epoch or
 * seconds since boot. Both readings are always listed; when the row carries
 * its status flags the one that applies is marked, and on older rows, stored
 * before the context columns existed, neither is chosen silently.
 */
function SampleTimeSection({ row }: { row: PayloadRow }) {
  const seconds = columnValue(row, "sample_time");
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  const { utc, uptime } = describeSampleTime(seconds);
  const flags = numericValue(row, "status_flags");
  const isUtc = flags === null ? null : (flags & STATUS_FLAG_TIME_UTC) !== 0;
  const applies = (
    <span className="ml-2 text-xs font-medium text-emerald-600">applies</span>
  );

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Clock className="h-4 w-4 text-primary" />
        <CardTitle>Sample time ({seconds} s)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Read as</TableHead>
              <TableHead>Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow className={isUtc === false ? "opacity-60" : undefined}>
              <TableCell>
                UTC epoch seconds
                {isUtc === true && applies}
              </TableCell>
              <TableCell className="font-mono text-xs">{utc}</TableCell>
            </TableRow>
            <TableRow className={isUtc === true ? "opacity-60" : undefined}>
              <TableCell>
                Seconds since boot
                {isUtc === false && applies}
              </TableCell>
              <TableCell className="font-mono text-xs">
                uptime {uptime}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <p className="text-xs text-muted-foreground">
          {flags === null ? (
            <>
              Which of the two applies is carried by the status flags (bit 5),
              which this row does not have: it was stored before the context
              columns existed. Use the received timestamp when the device had
              no clock sync.
            </>
          ) : isUtc ? (
            <>
              Status flags bit 5 is set: the time is UTC, last synced from the{" "}
              {TIME_SOURCES[(flags >> 6) & 0x03]}.
            </>
          ) : (
            <>
              Status flags bit 5 is clear: the device had no clock sync, so the
              time is seconds since boot. Use the received timestamp instead.
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

/** Which sensors reported a usable reading in this sample. */
function ValidMaskSection({ mask }: { mask: number }) {
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
              className={
                bit.valid ? undefined : "text-muted-foreground line-through"
              }
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
              <TableHead className="text-right">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bits.map((bit) => (
              <TableRow key={bit.bit}>
                <TableCell className="font-mono">{bit.bit}</TableCell>
                <TableCell>{bit.label}</TableCell>
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
