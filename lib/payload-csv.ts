import type { PayloadRow } from "@/lib/types";

// A single exportable CSV column: a stable key, the header shown in the file,
// and how to render a row's value as a string.
//
// Each schema derives one column per field (lib/payload-schemas), and an export
// carries exactly the columns the table shows, so the CSV always describes what
// the reader is looking at.
export interface CsvColumn {
  key: string;
  label: string;
  value: (row: PayloadRow) => string;
}

// Escape a single CSV field per RFC 4180: wrap in quotes when it contains a
// comma, quote, or newline, doubling any embedded quotes.
function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// Build a CSV document from the given rows with the given columns, in that
// order. Rows are emitted CRLF-terminated for Excel.
export function buildCsv(rows: PayloadRow[], columns: readonly CsvColumn[]): string {
  const header = columns.map((column) => escapeCsvField(column.label));
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsvField(column.value(row))).join(","));
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
