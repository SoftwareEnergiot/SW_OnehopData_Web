"use client";

import { Badge } from "@/components/ui/badge";
import { formatCreatedAt } from "@/lib/utils";
import { formatSampleMask } from "@/lib/payload-errors";
import { formatMaskHex, toMask } from "@/lib/error-catalog";
import {
  columnValue,
  isReadingValid,
  type PayloadFieldDef,
} from "@/lib/payload-schemas";
import type { PayloadRow } from "@/lib/types";

/** Right-aligned in a table, the way numbers are read. */
export function isNumericField(field: PayloadFieldDef): boolean {
  return (
    field.kind === "integer" ||
    field.kind === "number" ||
    field.kind === "sampleTime"
  );
}

/**
 * A sample time as the two things it could be.
 *
 * The protocol decides between them with status-flags bit 5. Rows stored
 * before `payloads_REE` had a status-flags column cannot tell, so rather than
 * pick one and present a guess as a fact, both readings are offered and
 * labelled, and the inspector marks the one that applies when it can.
 */
export function describeSampleTime(seconds: number): {
  utc: string;
  uptime: string;
} {
  const utc = formatCreatedAt(new Date(seconds * 1000).toISOString());
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const uptime =
    d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
  return { utc, uptime };
}

/** A field's value as plain text — what the CSV and the tooltips use. */
export function cellText(row: PayloadRow, field: PayloadFieldDef): string {
  const value = columnValue(row, field.key);
  if (value === null || value === undefined) return "—";

  switch (field.kind) {
    case "timestamp":
      return typeof value === "string" ? formatCreatedAt(value) : String(value);
    case "errorMask":
      return formatMaskHex(toMask(value as number));
    case "sampleMask":
      return formatSampleMask(Number(value));
    case "number":
      return typeof value === "number"
        ? value.toFixed(field.decimals ?? 1)
        : String(value);
    case "boolean":
      return value ? "yes" : "no";
    default:
      return String(value);
  }
}

/**
 * One cell of a payload row, rendered from the active schema's field
 * definition. Every list, every detail view and every environment goes through
 * here, so a column can never be formatted two different ways.
 */
export function PayloadCell({
  row,
  field,
}: {
  row: PayloadRow;
  field: PayloadFieldDef;
}) {
  const value = columnValue(row, field.key);

  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }

  // A reading whose valid-sample bit is clear was transmitted as 0 and is not a
  // measurement. Showing the 0 would be showing a number the sensor never read.
  if (!isReadingValid(row, field)) {
    return <span className="text-xs text-muted-foreground">no reading</span>;
  }

  switch (field.kind) {
    case "errorMask": {
      const mask = toMask(value as number);
      return (
        <Badge variant={mask === 0n ? "secondary" : "destructive"}>
          {formatMaskHex(mask)}
        </Badge>
      );
    }
    case "sampleMask":
      return (
        <span className="font-mono text-xs">
          {formatSampleMask(Number(value))}
        </span>
      );
    case "sampleTime":
      return <span className="font-mono text-xs">{String(value)}</span>;
    case "timestamp":
      return (
        <span className="font-mono text-xs">{cellText(row, field)}</span>
      );
    case "mono":
      return <span className="font-mono text-xs">{String(value)}</span>;
    case "number":
      return <span className="font-mono">{cellText(row, field)}</span>;
    case "integer":
      return <span className="font-mono">{String(value)}</span>;
    case "boolean":
      return <span>{cellText(row, field)}</span>;
    default:
      return <span>{String(value)}</span>;
  }
}
