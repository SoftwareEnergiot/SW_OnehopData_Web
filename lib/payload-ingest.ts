// Storing a device report without making the device wait for the database.
//
// Devices report every 5 minutes, several at the same instant, and the
// firmware does not retry: a report that times out on the device is lost. So
// the endpoint answers once the report has decoded, and storage runs on its own
// terms:
//
// 1. **In-process queue.** Writes go through a small per-environment limiter,
//    so a burst of reports on one server instance waits its turn instead of
//    opening a dozen database requests at once. REE and Development have
//    separate limiters: a Development burst never delays a REE write.
// 2. **Inline when possible, background otherwise.** The endpoint waits up to
//    `INLINE_STORE_BUDGET_MS` for the write, then answers the device anyway
//    and lets the write finish in `after()`.
// 3. **Durable retry queue.** A write the database rejects or does not answer
//    in time is parked in `payload_ingest_queue` with its rows ready to insert.
//    A pg_cron job in Supabase (`drain_payload_ingest_queue`) retries it, REE
//    first, and never moves it to another table.
// 4. **Last resort.** If even the queue cannot be reached, the rows are logged
//    in full on one `INGEST_LOST` line, so they can be recovered from the
//    runtime logs by hand.
//
// Nothing here ever throws: every outcome is a value the caller may log.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Created by the ingest-queue SQL (Supabase scripts). */
export const INGEST_QUEUE_TABLE = "payload_ingest_queue";

/** How long the device's request waits for its own write before answering. */
export const INLINE_STORE_BUDGET_MS = 2_000;

/** Ceiling on one database write, so a hung request ends up in the queue. */
export const STORE_TIMEOUT_MS = 15_000;

/** Concurrent writes per environment and server instance. */
export const MAX_CONCURRENT_WRITES = 4;

/* ----------------------------------------------------------------- limiter */

export interface Limiter {
  <T>(task: () => Promise<T>): Promise<T>;
  /** Tasks running now. */
  readonly active: number;
  /** Tasks waiting for a slot. */
  readonly waiting: number;
}

/**
 * A FIFO concurrency limiter: at most `max` tasks run at once, the rest wait
 * in arrival order. A finishing task hands its slot straight to the next one,
 * so a newcomer can never jump the queue.
 */
export function createLimiter(max: number): Limiter {
  let active = 0;
  const queue: (() => void)[] = [];

  const run = async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) {
      active += 1;
    } else {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active -= 1;
    }
  };

  return Object.defineProperties(run, {
    active: { get: () => active },
    waiting: { get: () => queue.length },
  }) as Limiter;
}

const limiters = new Map<string, Limiter>();

/** The limiter of one environment, shared by every request of this instance. */
export function limiterFor(environment: string): Limiter {
  let limiter = limiters.get(environment);
  if (!limiter) {
    limiter = createLimiter(MAX_CONCURRENT_WRITES);
    limiters.set(environment, limiter);
  }
  return limiter;
}

/** True when `promise` settles within `ms`, false when the time runs out. */
export async function settleWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ ingest */

export interface DeviceReportJob {
  environment: string;
  /** Exact PostgREST identifier of the table the rows belong in. */
  table: string;
  rows: Record<string, unknown>[];
  deviceUid: string | null;
  /** When the request arrived; becomes `created_at` if the rows are queued. */
  receivedAt: Date;
}

export type IngestOutcome =
  | { status: "stored" }
  | { status: "queued"; reason: string }
  | { status: "lost"; reason: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Store a device report in its environment's table, or park it in the retry
 * queue when that fails. Never rejects.
 */
export async function ingestDeviceReport(
  supabase: SupabaseClient,
  job: DeviceReportJob,
  limiter: Limiter = limiterFor(job.environment),
): Promise<IngestOutcome> {
  let reason: string;
  try {
    const { error } = await limiter(async () =>
      supabase
        .from(job.table)
        .insert(job.rows)
        .abortSignal(AbortSignal.timeout(STORE_TIMEOUT_MS)),
    );
    if (!error) return { status: "stored" };
    reason = error.message;
  } catch (error) {
    reason = messageOf(error);
  }

  console.error(`Payload not stored in ${job.table}, queuing it for retry:`, reason);
  return enqueueDeviceReport(supabase, job, reason);
}

/**
 * The rows as the retry queue keeps them: each one carries the reception time,
 * so a report inserted minutes later still sorts where it arrived.
 */
export function queuedRows(job: DeviceReportJob): Record<string, unknown>[] {
  const createdAt = job.receivedAt.toISOString();
  return job.rows.map((row) => ({ created_at: createdAt, ...row }));
}

async function enqueueDeviceReport(
  supabase: SupabaseClient,
  job: DeviceReportJob,
  reason: string,
): Promise<IngestOutcome> {
  const rows = queuedRows(job);
  let lostReason: string;
  try {
    const { error } = await supabase
      .from(INGEST_QUEUE_TABLE)
      .insert({
        environment: job.environment,
        target_table: job.table,
        device_uid: job.deviceUid,
        rows,
        last_error: reason,
      })
      .abortSignal(AbortSignal.timeout(STORE_TIMEOUT_MS));
    if (!error) return { status: "queued", reason };
    lostReason = error.message;
  } catch (error) {
    lostReason = messageOf(error);
  }

  // Nothing durable is left. One self-contained line, so the report can be
  // re-inserted by hand from the runtime logs.
  console.error(
    `INGEST_LOST ${JSON.stringify({
      table: job.table,
      device_uid: job.deviceUid,
      store_error: reason,
      queue_error: lostReason,
      rows,
    })}`,
  );
  return { status: "lost", reason: `${reason}; queue: ${lostReason}` };
}
