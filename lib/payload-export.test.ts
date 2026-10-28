import { describe, expect, it } from "vitest";

import { exportRange, type ExportPageRequest, type ExportRow } from "@/lib/payload-export";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-28T10:00:00.000Z");

// In-memory table + the endpoint's semantics: inclusive from/to, newest first,
// cursor = (created_at, id), optional failure injection.
function fakeTable(times: string[], failWhenLimitAbove = Infinity) {
  const rows: ExportRow[] = times.map((t, i) => ({ id: String(i).padStart(6, "0"), created_at: t }));
  const calls: ExportPageRequest[] = [];
  const fetchPage = async (req: ExportPageRequest) => {
    calls.push(req);
    if (req.limit > failWhenLimitAbove) throw new Error("canceling statement due to statement timeout");
    const ms = (r: ExportRow) => new Date(String(r.created_at)).getTime();
    const sorted = rows
      .filter((r) => (req.from === null || ms(r) >= new Date(req.from).getTime()) && ms(r) <= new Date(req.to).getTime())
      .filter((r) => !req.cursor || String(r.created_at) < req.cursor.before ||
        (String(r.created_at) === req.cursor.before && String(r.id) < req.cursor.beforeId))
      .sort((a, b) => (String(a.created_at) === String(b.created_at)
        ? (String(a.id) < String(b.id) ? 1 : -1)
        : (String(a.created_at) < String(b.created_at) ? 1 : -1)));
    const data = sorted.slice(0, req.limit);
    const last = data[data.length - 1];
    return {
      data,
      next_cursor: data.length === req.limit && last
        ? { before: String(last.created_at), beforeId: String(last.id) }
        : null,
    };
  };
  return { rows, calls, fetchPage };
}

const base = { receivedKey: "created_at", primaryKey: "id", now: () => NOW, sleep: async () => {} };

function minutes(startIso: string, count: number, stepMin = 1): string[] {
  const t0 = new Date(startIso).getTime();
  return Array.from({ length: count }, (_, i) => new Date(t0 + i * stepMin * 60_000).toISOString().replace("Z", "123+00:00"));
}

describe("exportRange", () => {
  it("returns every row once, newest first, across many windows and pages", async () => {
    const times = minutes("2026-10-20T00:00:00Z", 3 * 1440); // 3 days, 1/min
    const t = fakeTable(times);
    const out = await exportRange({ ...base, from: null, to: null, fetchPage: t.fetchPage });
    expect(out).toHaveLength(times.length);
    expect(new Set(out.map((r) => r.id)).size).toBe(times.length);
    expect(String(out[0].created_at) > String(out[out.length - 1].created_at)).toBe(true);
  });

  it("skips a long empty gap with one probe instead of one request per day", async () => {
    const times = [...minutes("2026-09-01T00:00:00Z", 10), ...minutes("2026-10-27T12:00:00Z", 10)];
    const t = fakeTable(times);
    const out = await exportRange({ ...base, from: null, to: null, fetchPage: t.fetchPage });
    expect(out).toHaveLength(20);
    expect(t.calls.length).toBeLessThan(10);
  });

  it("shrinks the page after a timeout and still completes", async () => {
    const times = minutes("2026-10-27T00:00:00Z", 1440);
    const t = fakeTable(times, 60); // any page above 60 rows times out
    const out = await exportRange({ ...base, from: null, to: null, fetchPage: t.fetchPage });
    expect(out).toHaveLength(1440);
  });

  it("respects the user's from/to range", async () => {
    const times = minutes("2026-10-25T00:00:00Z", 3 * 1440, 10);
    const t = fakeTable(times);
    const from = new Date("2026-10-26T00:00:00Z");
    const to = new Date("2026-10-26T23:59:59Z");
    const out = await exportRange({ ...base, from, to, fetchPage: t.fetchPage });
    expect(out).toHaveLength(144);
    expect(out.every((r) => String(r.created_at).startsWith("2026-10-26"))).toBe(true);
  });

  it("gives up after the retries when even the minimum page fails", async () => {
    const t = fakeTable(minutes("2026-10-27T00:00:00Z", 100), 0);
    await expect(
      exportRange({ ...base, from: null, to: null, fetchPage: t.fetchPage, retries: 1 }),
    ).rejects.toThrow("statement timeout");
  });

  it("handles an empty range", async () => {
    const t = fakeTable([]);
    expect(await exportRange({ ...base, from: null, to: null, fetchPage: t.fetchPage, windowMs: DAY })).toEqual([]);
  });
});
