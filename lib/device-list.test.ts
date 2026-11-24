import { describe, expect, it } from "vitest";

import { listDevices } from "@/lib/device-list";
import { DEVELOPMENT_SCHEMA, REE_SCHEMA } from "@/lib/payload-schemas";

type Row = Record<string, string | null>;

/**
 * Just enough of the PostgREST query builder for listDevices, evaluated over
 * in-memory tables. A table listed in `failing` answers every query with an
 * error, as a missing table or a timeout would.
 */
function fakeClient(tables: Record<string, Row[]>, failing: string[] = []) {
  const client = {
    from(table: string) {
      const filters: ((row: Row) => boolean)[] = [];
      let orderKey: string | null = null;
      let descending = false;
      let start = 0;
      let end = Infinity;
      const builder = {
        select: () => builder,
        eq: (key: string, value: string) => {
          filters.push((row) => row[key] === value);
          return builder;
        },
        order: (key: string, opts: { ascending: boolean }) => {
          orderKey = key;
          descending = !opts.ascending;
          return builder;
        },
        limit: (n: number) => {
          end = n - 1;
          return builder;
        },
        range: (from: number, to: number) => {
          start = from;
          end = to;
          return builder;
        },
        then(resolve: (r: { data: Row[] | null; error: { message: string } | null }) => void) {
          if (failing.includes(table)) {
            return resolve({ data: null, error: { message: "boom" } });
          }
          const rows = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
          if (orderKey) {
            const key = orderKey;
            rows.sort((a, b) => {
              const cmp = String(a[key]).localeCompare(String(b[key]));
              return descending ? -cmp : cmp;
            });
          }
          return resolve({ data: rows.slice(start, end + 1), error: null });
        },
      };
      return builder;
    },
  };
  return client as unknown as Parameters<typeof listDevices>[0];
}

const at = (minutes: number) =>
  new Date(Date.UTC(2026, 10, 24) - minutes * 60_000).toISOString();

function reports(device: string | null, count: number, startMinutesAgo: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    device_uid: device,
    created_at: at(startMinutesAgo + i),
  }));
}

const FIVE_DAYS = 5 * 24 * 60;

describe("listDevices", () => {
  it("offers a known device silent for days, behind thousands of newer rows", async () => {
    const supabase = fakeClient({
      device_api_key: [
        { token_sha256: "a", device_uid: "00124B0038A83BF0" },
        { token_sha256: "b", device_uid: "00124B0038A83CA7" },
        { token_sha256: "c", device_uid: "00124B0038A83C84" },
        // A second token for the same device is listed once.
        { token_sha256: "d", device_uid: "00124B0038A83C84" },
      ],
      payloads: [
        ...reports("00:12:4B:00:38:A8:3B:F0", 3000, 0),
        ...reports("00:12:4B:00:38:A8:3C:A7", 10, FIVE_DAYS),
        ...reports("00:12:4B:00:38:A8:3C:84", 10, FIVE_DAYS + 3),
      ],
    });
    const list = await listDevices(supabase, "Development", "payloads", DEVELOPMENT_SCHEMA);
    expect(list.devices).toEqual([
      { device_uid: "00:12:4B:00:38:A8:3B:F0", last_seen: at(0) },
      { device_uid: "00:12:4B:00:38:A8:3C:A7", last_seen: at(FIVE_DAYS) },
      { device_uid: "00:12:4B:00:38:A8:3C:84", last_seen: at(FIVE_DAYS + 3) },
    ]);
    expect(list.withoutUid).toBe(false);
  });

  it("splits known devices between environments by the ingest routing", async () => {
    const tables = {
      device_api_key: [
        { token_sha256: "a", device_uid: "00124B0038A83D90" }, // the REE device
        { token_sha256: "b", device_uid: "00124B0038A83BF0" },
      ],
      payloads: reports("00:12:4B:00:38:A8:3B:F0", 1, 0),
      payloads_REE: reports("00124B0038A83D90", 1, 0),
    };
    const dev = await listDevices(fakeClient(tables), "Development", "payloads", DEVELOPMENT_SCHEMA);
    expect(dev.devices.map((d) => d.device_uid)).toEqual(["00:12:4B:00:38:A8:3B:F0"]);
    const ree = await listDevices(fakeClient(tables), "REE", "payloads_REE", REE_SCHEMA);
    // REE stores UIDs as continuous hex.
    expect(ree.devices.map((d) => d.device_uid)).toEqual(["00124B0038A83D90"]);
  });

  it("lists a known device with no payload yet last, with no last-seen time", async () => {
    const supabase = fakeClient({
      device_api_key: [
        { token_sha256: "a", device_uid: "00124B0038A83BF0" },
        { token_sha256: "b", device_uid: "00124B0038A83C00" },
      ],
      payloads: reports("00:12:4B:00:38:A8:3B:F0", 1, 0),
    });
    const list = await listDevices(supabase, "Development", "payloads", DEVELOPMENT_SCHEMA);
    expect(list.devices).toEqual([
      { device_uid: "00:12:4B:00:38:A8:3B:F0", last_seen: at(0) },
      { device_uid: "00:12:4B:00:38:A8:3C:00", last_seen: null },
    ]);
  });

  it("keeps a recently reporting device that has no key, and notices V0 payloads", async () => {
    const supabase = fakeClient({
      device_api_key: [],
      payloads: [...reports("00:12:4B:00:38:A8:3B:F0", 2, 0), ...reports(null, 1, 5)],
    });
    const list = await listDevices(supabase, "Development", "payloads", DEVELOPMENT_SCHEMA);
    expect(list.devices.map((d) => d.device_uid)).toEqual(["00:12:4B:00:38:A8:3B:F0"]);
    expect(list.withoutUid).toBe(true);
  });

  it("fails when the device table cannot be read", async () => {
    const supabase = fakeClient({ payloads: [] }, ["device_api_key"]);
    await expect(
      listDevices(supabase, "Development", "payloads", DEVELOPMENT_SCHEMA),
    ).rejects.toThrow("device_api_key: boom");
  });
});
