// GET /api/config against an in-memory stand-in for the two Supabase tables,
// so the device-facing contract (status, headers, exact bytes) is pinned down
// without a database.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashDeviceToken } from "@/lib/device-auth";
import { CONFIG_V0_TEMPLATE, buildConfigFileV0 } from "@/lib/remote-config";

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
let failWith: string | null = null;

// Just the query-builder calls lib/device-auth and lib/device-config-store make.
function fakeClient() {
  return {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return query;
        },
        maybeSingle: async () => {
          if (failWith) return { data: null, error: { message: failWith } };
          const row = (tables[table] ?? []).find((r) =>
            filters.every(([c, v]) => r[c] === v),
          );
          return { data: row ?? null, error: null };
        },
      };
      return query;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => fakeClient(),
}));

const { GET } = await import("@/app/api/config/route");

const UID = "00124B0038A83BF0";
const TOKEN = "device-secret-token";

function request(authorization?: string) {
  return new Request("https://onehop-data.vercel.app/api/config", {
    headers: authorization ? { Authorization: authorization } : {},
  });
}

beforeEach(() => {
  failWith = null;
  tables.device_api_key = [{ token_sha256: hashDeviceToken(TOKEN), device_uid: UID }];
  tables.device_config = [];
});

describe("GET /api/config", () => {
  it("answers 401 without an Authorization header", async () => {
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("answers 401 for a token no report has been seen with", async () => {
    const response = await GET(request("Bearer someone-else"));
    expect(response.status).toBe(401);
  });

  it("answers 204 for a known device with no saved config", async () => {
    const response = await GET(request(`Bearer ${TOKEN}`));
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("serves the exact file bytes, as us-ascii text, uncached", async () => {
    const file = buildConfigFileV0(CONFIG_V0_TEMPLATE);
    tables.device_config = [{ device_uid: UID, file: file.text, crc32: file.crc32Hex }];

    const response = await GET(request(`Bearer ${TOKEN}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=us-ascii");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBeNull();

    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.length).toBe(105);
    expect(Array.from(body)).toEqual(Array.from(file.bytes));
    expect(response.headers.get("content-length")).toBe("105");
  });

  it("answers 500, not 401, when the database fails", async () => {
    failWith = "connection refused";
    const response = await GET(request(`Bearer ${TOKEN}`));
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
