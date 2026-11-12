import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createLimiter,
  INGEST_QUEUE_TABLE,
  ingestDeviceReport,
  limiterFor,
  queuedRows,
  settleWithin,
  type DeviceReportJob,
} from "@/lib/payload-ingest";

afterEach(() => {
  vi.restoreAllMocks();
});

const JOB: DeviceReportJob = {
  environment: "REE",
  table: "payloads_REE",
  rows: [
    { device_uid: "00124B0038A83D90", reporting_counter: 7, sample_time: 1 },
    { device_uid: "00124B0038A83D90", reporting_counter: 7, sample_time: 2 },
  ],
  deviceUid: "00:12:4B:00:38:A8:3D:90",
  receivedAt: new Date("2026-11-12T10:00:00.000Z"),
};

type Answer = { error: { message: string } | null } | Error;

/**
 * A Supabase stand-in recording every insert. `answers[table]` lists what each
 * successive insert into that table answers; an Error rejects.
 */
function fakeSupabase(answers: Record<string, Answer[]>) {
  const inserts: { table: string; values: unknown }[] = [];
  const client = {
    from(table: string) {
      return {
        insert(values: unknown) {
          inserts.push({ table, values });
          const answer = answers[table]?.shift() ?? { error: null };
          return {
            abortSignal: () =>
              answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer),
          };
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, inserts };
}

describe("createLimiter", () => {
  it("runs at most `max` tasks at once, the rest in arrival order", async () => {
    const limiter = createLimiter(2);
    const started: number[] = [];
    const release: (() => void)[] = [];
    const task = (id: number) =>
      limiter(
        () =>
          new Promise<number>((resolve) => {
            started.push(id);
            release[id] = () => resolve(id);
          }),
      );

    const all = [1, 2, 3, 4].map(task);
    await Promise.resolve();
    expect(started).toEqual([1, 2]);
    expect(limiter.active).toBe(2);
    expect(limiter.waiting).toBe(2);

    release[2]();
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
    release[1]();
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3, 4]));
    expect(limiter.active).toBe(2);
    release[3]();
    release[4]();

    expect(await Promise.all(all)).toEqual([1, 2, 3, 4]);
    expect(limiter.active).toBe(0);
    expect(limiter.waiting).toBe(0);
  });

  it("frees the slot when a task throws", async () => {
    const limiter = createLimiter(1);
    await expect(limiter(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await limiter(() => Promise.resolve("next"))).toBe("next");
    expect(limiter.active).toBe(0);
  });

  it("keeps one limiter per environment, so REE never waits behind Development", () => {
    expect(limiterFor("REE")).toBe(limiterFor("REE"));
    expect(limiterFor("REE")).not.toBe(limiterFor("Development"));
  });
});

describe("settleWithin", () => {
  it("is true when the promise settles in time, rejected or not", async () => {
    expect(await settleWithin(Promise.resolve(), 50)).toBe(true);
    expect(await settleWithin(Promise.reject(new Error("x")), 50)).toBe(true);
  });

  it("is false when the time runs out first", async () => {
    expect(await settleWithin(new Promise(() => {}), 10)).toBe(false);
  });
});

describe("ingestDeviceReport", () => {
  it("stores the rows in the job's table and queues nothing", async () => {
    const { client, inserts } = fakeSupabase({});
    expect(await ingestDeviceReport(client, JOB)).toEqual({ status: "stored" });
    expect(inserts).toEqual([{ table: "payloads_REE", values: JOB.rows }]);
  });

  it("parks a rejected write in the retry queue, for the same table", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, inserts } = fakeSupabase({
      payloads_REE: [{ error: { message: "violates check constraint" } }],
    });

    const outcome = await ingestDeviceReport(client, JOB);

    expect(outcome).toEqual({ status: "queued", reason: "violates check constraint" });
    expect(inserts).toHaveLength(2);
    expect(inserts[1]).toEqual({
      table: INGEST_QUEUE_TABLE,
      values: {
        environment: "REE",
        target_table: "payloads_REE",
        device_uid: JOB.deviceUid,
        rows: queuedRows(JOB),
        last_error: "violates check constraint",
      },
    });
    // Never retried against another environment's table.
    expect(inserts.some((i) => i.table === "payloads")).toBe(false);
  });

  it("queues a write that throws (timeout, network)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, inserts } = fakeSupabase({
      payloads_REE: [new Error("The operation was aborted due to timeout")],
    });

    const outcome = await ingestDeviceReport(client, JOB);

    expect(outcome.status).toBe("queued");
    expect(inserts.map((i) => i.table)).toEqual(["payloads_REE", INGEST_QUEUE_TABLE]);
  });

  it("logs the full rows on one INGEST_LOST line when the queue fails too", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeSupabase({
      payloads_REE: [{ error: { message: "down" } }],
      [INGEST_QUEUE_TABLE]: [new Error("still down")],
    });

    const outcome = await ingestDeviceReport(client, JOB);

    expect(outcome).toEqual({ status: "lost", reason: "down; queue: still down" });
    const line = errors.mock.calls.map((c) => String(c[0])).find((m) => m.startsWith("INGEST_LOST "));
    expect(line).toBeDefined();
    const logged = JSON.parse(line!.slice("INGEST_LOST ".length));
    expect(logged.table).toBe("payloads_REE");
    expect(logged.rows).toEqual(queuedRows(JOB));
  });

  it("never rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeSupabase({
      payloads_REE: [new Error("a")],
      [INGEST_QUEUE_TABLE]: [new Error("b")],
    });
    await expect(ingestDeviceReport(client, JOB)).resolves.toBeDefined();
  });
});

describe("queuedRows", () => {
  it("stamps every row with the reception time, keeping its own fields", () => {
    expect(queuedRows(JOB)).toEqual(
      JOB.rows.map((row) => ({ created_at: "2026-11-12T10:00:00.000Z", ...row })),
    );
  });
});
