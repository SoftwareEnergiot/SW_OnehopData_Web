/**
 * Keyset ("cursor") pagination for GET /api/payloads.
 *
 * Paging with `offset` makes PostgreSQL read and discard every earlier row on
 * each page, and `count: "exact"` re-counts the whole filtered range on every
 * request. On a large range (tens of thousands of rows) that exceeds the
 * database statement timeout from the second page on, and an export stops
 * after its first page.
 *
 * A cursor names the last row already returned — its received timestamp and
 * its primary key — and the next page is "rows strictly older than that row",
 * in the same (received desc, id desc) order. Each page then costs the same,
 * however deep the export goes. The primary key breaks ties between rows that
 * share a received timestamp (one payload stored as several rows).
 */

export interface PayloadCursor {
  /** Received timestamp exactly as stored (keeps microseconds). */
  before: string;
  /** Primary key of that row (UUID or integer), as text. */
  beforeId: string;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;
const ROW_ID = /^[0-9A-Za-z-]{1,64}$/;

/**
 * Reads `before` / `before_id` from the query string. Returns null when absent,
 * and "invalid" when present but malformed (never silently ignored: that would
 * restart the export from the first page).
 */
export function parseCursor(
  before: string | null,
  beforeId: string | null,
): PayloadCursor | null | "invalid" {
  if (before === null && beforeId === null) return null;
  if (
    before === null ||
    beforeId === null ||
    !TIMESTAMP.test(before) ||
    Number.isNaN(new Date(before).getTime()) ||
    !ROW_ID.test(beforeId)
  ) {
    return "invalid";
  }
  return { before, beforeId };
}

/**
 * PostgREST `or` filter for "strictly after the cursor" in descending order:
 * received < before, or received = before and id < beforeId.
 */
export function cursorFilter(
  cursor: PayloadCursor,
  receivedKey: string,
  primaryKey: string,
): string {
  const ts = `"${cursor.before}"`;
  const id = `"${cursor.beforeId}"`;
  return `${receivedKey}.lt.${ts},and(${receivedKey}.eq.${ts},${primaryKey}.lt.${id})`;
}

/** The cursor that follows a full page, or null when the page was the last. */
export function nextCursor(
  rows: readonly Record<string, unknown>[],
  limit: number,
  receivedKey: string,
  primaryKey: string,
): PayloadCursor | null {
  if (rows.length < limit || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  const before = last[receivedKey];
  const beforeId = last[primaryKey];
  if (before === null || before === undefined || beforeId === null || beforeId === undefined) {
    return null;
  }
  return { before: String(before), beforeId: String(beforeId) };
}
