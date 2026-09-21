import { formatCreatedAt } from "@/lib/utils";
import { describeCommError, formatErrorMask } from "@/lib/payload-errors";
import { STATUS_FLAG_TIME_UTC } from "@/lib/payload-decoder";
import type { PayloadRecord, PayloadRow } from "@/lib/types";

// Render a nullable numeric column: an absent reading is an empty cell, never a
// zero, so a spreadsheet never averages "no data" in with real measurements.
function numeric(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

// The first sample's read time, in the current V1 revision. Status flags bit 5
// decides what it is: a UTC epoch (written as ISO 8601, so a spreadsheet sorts
// it) or seconds since boot, which has no absolute meaning and is written as
// such. Empty for formats whose samples carry no time.
function sampleTimeCell(r: PayloadRecord): string {
  const seconds = r.samples?.[0]?.time;
  if (typeof seconds !== "number") return "";
  if (((r.context?.status_flags ?? 0) & STATUS_FLAG_TIME_UTC) !== 0) {
    return new Date(seconds * 1000).toISOString();
  }
  return `uptime ${seconds} s`;
}

// A single exportable CSV column: a stable key, the header shown in the file
// and the column-picker, and how to render a row's value as a string.
//
// The row is the active environment's row shape; each schema supplies the
// column set that matches it (see lib/payload-schemas), so the export always
// describes the table it was read from.
export interface CsvColumn {
  key: string;
  label: string;
  value: (row: PayloadRow) => string;
}

// Narrow a generic row to the Development record the columns below read. The
// Development columns are only ever paired with Development rows, by the
// schema that owns them.
const dev = (row: PayloadRow) => row as PayloadRecord;

// Every column the CSV can carry, in export order. The first seven mirror the
// on-screen table; the rest expose the raw decoded payload fields (complex
// values are serialised as JSON so a single cell round-trips them). Request
// metadata unrelated to the payload data (row id, source IP, user agent) is
// deliberately left out.
export const CSV_COLUMNS: CsvColumn[] = [
  { key: "created_at", label: "Received", value: (row) => formatCreatedAt(dev(row).created_at) },
  { key: "device_uid", label: "Device UID", value: (row) => dev(row).device_uid ?? "" },
  { key: "sample_time", label: "Sample time", value: (row) => sampleTimeCell(dev(row)) },
  { key: "payload_version", label: "Version", value: (row) => String(dev(row).payload_version) },
  { key: "sample_count", label: "Samples", value: (row) => String(dev(row).sample_count) },
  { key: "error_mask", label: "Error mask", value: (row) => formatErrorMask(dev(row).error_mask) },
  { key: "reporting_counter", label: "Counter", value: (row) => String(dev(row).reporting_counter) },
  { key: "byte_length", label: "Bytes", value: (row) => String(dev(row).byte_length) },
  // V1 diagnostics, generated from `context` by scripts/004. Empty for V0 rows
  // and for any row stored before that migration — never "0", which would read
  // as a flat battery or a lost signal rather than as "no reading".
  { key: "battery_soc", label: "Battery SoC (%)", value: (row) => numeric(dev(row).battery_soc) },
  { key: "battery_voltage", label: "Battery voltage (mV)", value: (row) => numeric(dev(row).battery_voltage) },
  { key: "rsrp", label: "RSRP (dBm)", value: (row) => numeric(dev(row).rsrp) },
  { key: "snr", label: "SNR (dB)", value: (row) => numeric(dev(row).snr) },
  { key: "reporting_lost_counter", label: "Reports lost (since boot)", value: (row) => numeric(dev(row).reporting_lost_counter) },
  { key: "tx_failed", label: "Tx failed (since boot)", value: (row) => numeric(dev(row).tx_failed) },
  {
    key: "last_communication_error",
    label: "Last comm. error",
    value: (row) =>
      dev(row).last_communication_error === null ||
      dev(row).last_communication_error === undefined
        ? ""
        : describeCommError(dev(row).last_communication_error as number),
  },
  { key: "payload_hex", label: "Payload hex", value: (row) => dev(row).payload_hex },
  { key: "payload_binary", label: "Payload binary", value: (row) => dev(row).payload_binary ?? "" },
  { key: "samples", label: "Samples (JSON)", value: (row) => JSON.stringify(dev(row).samples ?? []) },
  { key: "context", label: "Context (JSON)", value: (row) => JSON.stringify(dev(row).context ?? {}) },
  { key: "errors", label: "Errors (JSON)", value: (row) => JSON.stringify(dev(row).errors ?? []) },
];

// Escape a single CSV field per RFC 4180: wrap in quotes when it contains a
// comma, quote, or newline, doubling any embedded quotes.
function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// Build a CSV document from the given rows using only the selected columns, in
// the order the column set declares them. `columns` comes from the active
// environment's schema and defaults to the Development set, so existing callers
// are unaffected. Rows are emitted CRLF-terminated for Excel.
export function buildCsv(
  rows: PayloadRow[],
  selectedKeys: ReadonlySet<string>,
  columns: readonly CsvColumn[] = CSV_COLUMNS,
): string {
  const selected = columns.filter((column) => selectedKeys.has(column.key));
  const header = selected.map((column) => escapeCsvField(column.label));
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(selected.map((column) => escapeCsvField(column.value(row))).join(","));
  }
  return lines.join("\r\n");
}

// Trigger a browser download of `content` as a file named `filename`.
export function downloadCsv(content: string, filename: string): void {
  // Prepend a UTF-8 BOM so Excel reads accented characters correctly.
  const blob = new Blob(["﻿", content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
