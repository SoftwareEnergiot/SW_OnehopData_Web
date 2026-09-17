import { describe, expect, it } from "vitest";
import {
  NO_DEVICE_UID,
  applyDeviceUidFilter,
  parseDeviceUidFilter,
} from "@/lib/payload-filters";

describe("parseDeviceUidFilter", () => {
  it("treats a missing or blank value as no filter", () => {
    expect(parseDeviceUidFilter(null)).toEqual({ kind: "all" });
    expect(parseDeviceUidFilter("")).toEqual({ kind: "all" });
    expect(parseDeviceUidFilter("   ")).toEqual({ kind: "all" });
  });

  it("selects the payloads without a UID", () => {
    expect(parseDeviceUidFilter(NO_DEVICE_UID)).toEqual({ kind: "none" });
    expect(parseDeviceUidFilter("NONE")).toEqual({ kind: "none" });
  });

  it("normalises a UID typed with any separator or case", () => {
    const expected = { kind: "uid", uid: "00:12:4B:00:1A:2B:3C:4D" };
    expect(parseDeviceUidFilter("00:12:4B:00:1A:2B:3C:4D")).toEqual(expected);
    expect(parseDeviceUidFilter("00124b001a2b3c4d")).toEqual(expected);
    expect(parseDeviceUidFilter("00-12-4b-00-1a-2b-3c-4d")).toEqual(expected);
  });

  it("flags a malformed UID instead of silently matching everything", () => {
    expect(parseDeviceUidFilter("00:12:4B")).toEqual({ kind: "invalid", raw: "00:12:4B" });
  });
});

describe("applyDeviceUidFilter", () => {
  // A stand-in for the Supabase query builder that records what was applied.
  function fakeQuery() {
    const calls: string[] = [];
    const query = {
      calls,
      eq(column: string, value: string) {
        calls.push(`eq ${column} ${value}`);
        return query;
      },
      is(column: string, value: null) {
        calls.push(`is ${column} ${value}`);
        return query;
      },
    };
    return query;
  }

  it("matches one device exactly", () => {
    const q = applyDeviceUidFilter(fakeQuery(), parseDeviceUidFilter("00124b001a2b3c4d"));
    expect(q.calls).toEqual(["eq device_uid 00:12:4B:00:1A:2B:3C:4D"]);
  });

  it("matches the payloads without a UID with IS NULL", () => {
    const q = applyDeviceUidFilter(fakeQuery(), parseDeviceUidFilter("none"));
    expect(q.calls).toEqual(["is device_uid null"]);
  });

  it("leaves the query alone when there is no filter", () => {
    const q = applyDeviceUidFilter(fakeQuery(), parseDeviceUidFilter(null));
    expect(q.calls).toEqual([]);
  });
});
