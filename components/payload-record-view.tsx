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
import { formatSampleMask, resolveValidSampleMask } from "@/lib/payload-errors";
import {
  columnValue,
  fieldGroups,
  isReadingValid,
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
                        {field.description ?? "—"}
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

      {!schema.capabilities.errorMask && (
        <Card>
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <TriangleAlert className="h-4 w-4 text-muted-foreground" />
            <CardTitle>Error mask</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              <span className="font-mono">{schema.table}</span> carries no error
              reason column, and no other table or endpoint in this project
              holds one for it. The error catalog in{" "}
              <span className="font-mono">public.payload_error_codes</span>{" "}
              still decodes any mask it is given — there is simply no mask in
              this dataset to decode. The valid-sample mask below is the only
              per-row health signal these rows carry.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
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
 * seconds since boot, and this table carries no status-flags column — so both
 * readings are shown and labelled rather than one being chosen silently.
 */
function SampleTimeSection({ row }: { row: PayloadRow }) {
  const seconds = columnValue(row, "sample_time");
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  const { utc, uptime } = describeSampleTime(seconds);

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
            <TableRow>
              <TableCell>UTC epoch seconds</TableCell>
              <TableCell className="font-mono text-xs">{utc}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Seconds since boot</TableCell>
              <TableCell className="font-mono text-xs">
                uptime {uptime}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <p className="text-xs text-muted-foreground">
          Which of the two applies is carried by the protocol status flags (bit
          5), and this table has no column for them. Use the received timestamp
          when the device had no clock sync.
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
