import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  environmentForDeviceUid,
  reeReferenceDeviceUid,
  resolveEnvironment,
} from "@/lib/payload-repository";

/**
 * A Supabase stand-in that records the table it was asked for and answers one
 * canned result. Enough for the two reads this module makes, and it proves
 * which table each call actually named.
 */
function fakeClient(
  result: { data?: unknown[]; error?: { message: string } } = { data: [] },
) {
  const tables: string[] = [];
  const client = {
    tables,
    from(table: string) {
      tables.push(table);
      const builder = {
        select: () => builder,
        order: () => builder,
        limit: () => Promise.resolve({ data: result.data ?? null, error: result.error ?? null }),
      };
      return builder;
    },
  };
  return client as unknown as SupabaseClient & { tables: string[] };
}

describe("resolveEnvironment", () => {
  it("resolves each environment to its own table and schema", () => {
    const dev = resolveEnvironment("Development");
    expect(dev.ok && dev.value.table).toBe("payloads");
    expect(dev.ok && dev.value.schema.id).toBe("development");

    const ree = resolveEnvironment("REE");
    expect(ree.ok && ree.value.table).toBe("payloads_REE");
    expect(ree.ok && ree.value.schema.id).toBe("ree");
  });

  it("rejects an unknown environment instead of falling back to one", () => {
    for (const name of ["Staging", "payloads_ree", "ree", "development"]) {
      const resolved = resolveEnvironment(name);
      expect(resolved.ok, name).toBe(false);
      expect(!resolved.ok && resolved.error.status).toBe(404);
    }
  });

  it("rejects a missing environment rather than choosing one", () => {
    const resolved = resolveEnvironment("");
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.error.status).toBe(400);
  });

  it("trims a name before resolving it", () => {
    const resolved = resolveEnvironment("  REE  ");
    expect(resolved.ok && resolved.value.table).toBe("payloads_REE");
  });
});

describe("reeReferenceDeviceUid", () => {
  it("reads the reference UID from the REE table, and nowhere else", async () => {
    const client = fakeClient({ data: [{ device_uid: "00124B0038A83D90" }] });
    await expect(reeReferenceDeviceUid(client)).resolves.toBe("00124B0038A83D90");
    expect(client.tables).toEqual(["payloads_REE"]);
  });

  it("normalises a stored UID written with separators", async () => {
    const client = fakeClient({ data: [{ device_uid: "00:12:4b:00:38:a8:3d:90" }] });
    await expect(reeReferenceDeviceUid(client)).resolves.toBe("00124B0038A83D90");
  });

  it("has no reference when the table is empty", async () => {
    await expect(reeReferenceDeviceUid(fakeClient({ data: [] }))).resolves.toBeNull();
  });

  it("has no reference when the table cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fakeClient({ error: { message: "permission denied" } });
    await expect(reeReferenceDeviceUid(client)).resolves.toBeNull();
    warn.mockRestore();
  });
});

describe("environmentForDeviceUid", () => {
  const REFERENCE = [{ device_uid: "00124B0038A83D90" }];

  it("routes a payload from the REE device to REE", async () => {
    await expect(
      environmentForDeviceUid(fakeClient({ data: REFERENCE }), "00:12:4B:00:38:A8:3D:90"),
    ).resolves.toBe("REE");
  });

  it("matches regardless of separators or case", async () => {
    for (const uid of [
      "00124b0038a83d90",
      "00-12-4B-00-38-A8-3D-90",
      "00124B0038A83D90",
    ]) {
      await expect(
        environmentForDeviceUid(fakeClient({ data: REFERENCE }), uid),
      ).resolves.toBe("REE");
    }
  });

  it("routes any other device to Development", async () => {
    await expect(
      environmentForDeviceUid(fakeClient({ data: REFERENCE }), "00:12:4B:00:1A:2B:3C:4D"),
    ).resolves.toBe("Development");
  });

  it("routes a payload with no UID to Development without asking the REE table", async () => {
    const client = fakeClient({ data: REFERENCE });
    await expect(environmentForDeviceUid(client, null)).resolves.toBe("Development");
    // A V0 payload cannot match anything, so there is nothing to look up.
    expect(client.tables).toEqual([]);
  });

  it("routes to Development when the REE table holds no reference row", async () => {
    await expect(
      environmentForDeviceUid(fakeClient({ data: [] }), "00:12:4B:00:38:A8:3D:90"),
    ).resolves.toBe("Development");
  });

  it("keeps ingesting into Development when the REE table cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fakeClient({ error: { message: "permission denied" } });
    await expect(
      environmentForDeviceUid(client, "00:12:4B:00:38:A8:3D:90"),
    ).resolves.toBe("Development");
    warn.mockRestore();
  });
});
