/**
 * How the dashboard table loads the stored payloads.
 *
 * The table never asks for an exact count up front: on an unfiltered, large
 * table (`public.payloads`) the `count(*)` alone outlasts the database
 * statement timeout and the whole request fails, although reading the newest
 * rows is fast. So the table starts with a small batch, reads with
 * `count=none`, and the reader asks for more when they want it. Each further
 * batch follows the previous one by cursor (lib/payload-cursor), so it costs
 * the same however deep the reader goes, and the batches grow, so reaching
 * older rows takes few clicks.
 */

/** Rows in the first batch: enough to fill the screen, cheap to fetch. */
export const FIRST_BATCH_SIZE = 25;

/** Largest batch: kept under the Supabase default row cap of 1000. */
export const MAX_BATCH_SIZE = 200;

/**
 * Rows to request in the batch that follows `batchesLoaded` batches:
 * 25, 50, 100, 200, 200, …
 */
export function nextBatchSize(batchesLoaded: number): number {
  const n = Math.max(0, Math.floor(batchesLoaded));
  // Capped before shifting, so a large count cannot overflow the shift.
  return Math.min(FIRST_BATCH_SIZE * 2 ** Math.min(n, 16), MAX_BATCH_SIZE);
}

/**
 * Appends a batch to the rows already shown, skipping any row already there
 * (by id), so a batch that overlaps the previous one never shows a row twice.
 */
export function appendBatch<T>(
  current: readonly T[],
  batch: readonly T[],
  idOf: (row: T) => string,
): T[] {
  const seen = new Set(current.map(idOf));
  const fresh = batch.filter((row) => !seen.has(idOf(row)));
  return fresh.length === 0 ? [...current] : [...current, ...fresh];
}
