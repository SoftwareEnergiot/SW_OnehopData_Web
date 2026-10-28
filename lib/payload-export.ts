import type { PayloadCursor } from "@/lib/payload-cursor";

/**
 * Export of a large range in time windows, merged into one result.
 *
 * Measured on production (Development, one device, 26k rows): a page's cost
 * grows with the rows it returns, not with how deep it is, and a 500-row page
 * takes 1.1–3.5 s against a ~3 s statement timeout. So a fixed page size fails
 * at random. Here the range is walked newest → oldest in windows; each window
 * is read with cursor pages whose size adapts (halved after a failure, grown
 * back after successes); empty periods are skipped with a one-row probe; rows
 * are de-duplicated on their primary key (window bounds are inclusive) and
 * returned newest first, ready for a single CSV.
 */

export interface ExportRow {
  [key: string]: unknown;
}

export interface ExportPageResult<T = ExportRow> {
  data: T[];
  next_cursor: PayloadCursor | null;
}

export interface ExportPageRequest {
  /** Inclusive lower bound (ISO), or null for no bound. */
  from: string | null;
  /** Inclusive upper bound (ISO). */
  to: string;
  limit: number;
  cursor: PayloadCursor | null;
}

export interface ExportProgress {
  rows: number;
  /** Oldest instant reached so far. */
  reached: Date;
  pageSize: number;
}

export interface ExportOptions<T = ExportRow> {
  /** User range; null = from the oldest row / up to now. */
  from: Date | null;
  to: Date | null;
  receivedKey: string;
  primaryKey: string;
  fetchPage: (request: ExportPageRequest) => Promise<ExportPageResult<T>>;
  onProgress?: (progress: ExportProgress) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  windowMs?: number;
  startPageSize?: number;
  minPageSize?: number;
  maxPageSize?: number;
  /** Attempts at the minimum page size before giving up. */
  retries?: number;
}

export const EXPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const EXPORT_PAGE = { start: 200, min: 25, max: 500 } as const;
const GROW_AFTER = 3;

const iso = (date: Date) => date.toISOString();

export async function exportRange<T>(options: ExportOptions<T>): Promise<T[]> {
  const field = (row: T, key: string) =>
    (row as unknown as Record<string, unknown>)[key];
  const {
    from,
    receivedKey,
    primaryKey,
    fetchPage,
    onProgress,
    now = () => new Date(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    windowMs = EXPORT_WINDOW_MS,
    minPageSize = EXPORT_PAGE.min,
    maxPageSize = EXPORT_PAGE.max,
    retries = 3,
  } = options;

  let pageSize = Math.min(
    maxPageSize,
    Math.max(minPageSize, options.startPageSize ?? EXPORT_PAGE.start),
  );
  let streak = 0;
  const seen = new Set<string>();
  const rows: T[] = [];

  // One page, adapting its size: a failure halves it (down to the minimum,
  // then a few retries with back-off); a run of successes doubles it again.
  async function page(request: Omit<ExportPageRequest, "limit">, size?: number) {
    let failures = 0;
    for (;;) {
      const limit = size ?? pageSize;
      try {
        const result = await fetchPage({ ...request, limit });
        if (size === undefined && ++streak >= GROW_AFTER) {
          pageSize = Math.min(maxPageSize, pageSize * 2);
          streak = 0;
        }
        return { result, limit };
      } catch (error) {
        streak = 0;
        if (size === undefined && pageSize > minPageSize) {
          pageSize = Math.max(minPageSize, Math.floor(pageSize / 2));
          continue;
        }
        if (++failures > retries) throw error;
        await sleep(1000 * failures);
      }
    }
  }

  const add = (batch: T[]) => {
    for (const row of batch) {
      const id = String(field(row, primaryKey));
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
    }
  };

  let end = options.to ?? now();
  for (;;) {
    const startMs = end.getTime() - windowMs;
    const start = from && from.getTime() >= startMs ? from : new Date(startMs);

    // The window [start, end], newest first, in cursor pages.
    let cursor: PayloadCursor | null = null;
    for (;;) {
      const { result, limit } = await page({ from: iso(start), to: iso(end), cursor });
      add(result.data);
      onProgress?.({ rows: rows.length, reached: start, pageSize });
      cursor = result.next_cursor;
      if (!cursor || result.data.length < limit) break;
    }

    if (from && start.getTime() <= from.getTime()) break;

    // Newest row at or before the window start that is not exported yet: none
    // means the export is complete; otherwise the next window ends there, so a
    // gap of days or weeks costs one request.
    const { result } = await page({ from: null, to: iso(start), cursor: null }, 2);
    const older = result.data.find((row) => !seen.has(String(field(row, primaryKey))));
    if (!older) break;
    const olderAt = new Date(String(field(older, receivedKey)));
    if (Number.isNaN(olderAt.getTime())) break;
    if (from && olderAt.getTime() < from.getTime()) break;
    // Kept now, so every round adds at least one row and the walk always ends.
    add([older]);
    // +1 ms: the stored timestamp has microseconds the Date drops.
    end = new Date(Math.min(olderAt.getTime() + 1, start.getTime()));
  }

  // Newest first, ties on the primary key — the table's order.
  const key = (row: T) => String(field(row, receivedKey));
  return rows.sort((a, b) => {
    const ta = new Date(key(a)).getTime();
    const tb = new Date(key(b)).getTime();
    if (ta !== tb) return tb - ta;
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return ka < kb ? 1 : -1;
    return String(field(a, primaryKey)) < String(field(b, primaryKey)) ? 1 : -1;
  });
}
