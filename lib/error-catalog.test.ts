import { describe, expect, it } from "vitest";

import {
  decodeErrorMask,
  formatMaskHex,
  noneEntry,
  toMask,
  type ErrorCodeRecord,
} from "@/lib/error-catalog";

// The catalog as `public.payload_error_codes` holds it: every entry a
// single-bit value, plus the bit_value 0 sentinel, plus the reserved bits the
// specification says are always 0.
const CATALOG: ErrorCodeRecord[] = [
  { code: "0x00000000", bit_value: 0, name: "ERR_RSN_NONE", description: "No error reason is set." },
  { code: "0x00000001", bit_value: 1, name: "ERR_RSN_SENSOR_AMBIENT", description: "A read of the external ambient sensor failed." },
  { code: "0x00000002", bit_value: 2, name: "ERR_RSN_SENSOR_LUMINOSITY", description: "A read of the luminosity sensor failed." },
  { code: "0x00000004", bit_value: 4, name: "ERR_RSN_SENSOR_ACCELEROMETER", description: "A read of the accelerometer failed." },
  { code: "0x00000008", bit_value: 8, name: "ERR_RSN_SENSOR_HALL_EFFECT_1", description: "A read of magnetic sensor 1 failed or was degraded." },
  { code: "0x00000010", bit_value: 16, name: "ERR_RSN_SENSOR_HALL_EFFECT_2", description: "A read of magnetic sensor 2 failed or was degraded." },
  { code: "0x00008000", bit_value: 32768, name: "ERR_RSN_BATTERY_BELOW_50", description: "State of charge below 50 %." },
  { code: "0x00400000", bit_value: 4194304, name: "ERR_RSN_CLOCK_SYNC_FAILED", description: "No valid clock was available during a cycle." },
  { code: "0x80000000", bit_value: 2147483648, name: "ERR_RSN_RESERVED_BIT_31", description: "Reserved. Always 0." },
];

const names = (mask: number | string | bigint | null) =>
  decodeErrorMask(mask, CATALOG).map((entry) => entry.name);

describe("toMask", () => {
  it("reads a number, a decimal string and a hex string alike", () => {
    expect(toMask(24)).toBe(24n);
    expect(toMask("24")).toBe(24n);
    expect(toMask("0x18")).toBe(24n);
    expect(toMask(2147483648)).toBe(2147483648n);
  });

  it("treats anything that is not a mask as no mask, rather than throwing", () => {
    expect(toMask(null)).toBe(0n);
    expect(toMask(undefined)).toBe(0n);
    expect(toMask("")).toBe(0n);
    expect(toMask("not a number")).toBe(0n);
    expect(toMask(Number.NaN)).toBe(0n);
  });

  it("reads back a mask that went through a 32-bit signed operator", () => {
    // 0x80000001 | 0 is -2147483647 in JavaScript. It is still that mask.
    expect(toMask(0x80000001 | 0)).toBe(2147483649n);
    expect(toMask(-1)).toBe(4294967295n);
    // Outside the 32-bit range there is nothing to reinterpret.
    expect(toMask(-1e18)).toBe(0n);
  });
});

describe("decodeErrorMask", () => {
  it("resolves a zero mask to ERR_RSN_NONE alone", () => {
    expect(names(0)).toEqual(["ERR_RSN_NONE"]);
    expect(names(null)).toEqual(["ERR_RSN_NONE"]);
  });

  it("resolves a single active bit", () => {
    expect(names(4)).toEqual(["ERR_RSN_SENSOR_ACCELEROMETER"]);
    expect(names(32768)).toEqual(["ERR_RSN_BATTERY_BELOW_50"]);
  });

  it("expands a combined mask into every flag it sets", () => {
    // 0x18 = hall effect 1 + hall effect 2.
    expect(names(0x18)).toEqual([
      "ERR_RSN_SENSOR_HALL_EFFECT_1",
      "ERR_RSN_SENSOR_HALL_EFFECT_2",
    ]);
    expect(names(1 | 2 | 4194304)).toEqual([
      "ERR_RSN_SENSOR_AMBIENT",
      "ERR_RSN_SENSOR_LUMINOSITY",
      "ERR_RSN_CLOCK_SYNC_FAILED",
    ]);
  });

  it("matches on the bit value, never on a bit index", () => {
    // Read as an index, bit_value 4 would mean 0b10000 and would not match 4.
    expect(names(4)).toContain("ERR_RSN_SENSOR_ACCELEROMETER");
    // ...and bit_value 16 would then match 0x10000, which it must not.
    expect(names(0x10000)).not.toContain("ERR_RSN_SENSOR_HALL_EFFECT_2");
  });

  it("never reports ERR_RSN_NONE next to a real error", () => {
    expect(names(1)).not.toContain("ERR_RSN_NONE");
    expect(names(0x18)).not.toContain("ERR_RSN_NONE");
  });

  it("handles the high-order bit that a 32-bit signed operator loses", () => {
    const resolved = decodeErrorMask(2147483648, CATALOG);
    expect(resolved.map((e) => e.name)).toEqual(["ERR_RSN_RESERVED_BIT_31"]);
    expect(resolved[0].reserved).toBe(true);
  });

  it("flags a reserved bit rather than reporting it as a device fault", () => {
    // Summed, not OR-ed: `1 | 2147483648` is negative in JavaScript, which is
    // the whole reason this module works in BigInt.
    const resolved = decodeErrorMask(1 + 2147483648, CATALOG);
    expect(resolved.map((e) => e.reserved)).toEqual([false, true]);
  });

  it("reports a bit the catalog does not describe instead of dropping it", () => {
    // 0x20 is not in this catalog.
    const resolved = decodeErrorMask(0x20 | 1, CATALOG);
    expect(resolved.map((e) => e.name)).toEqual([
      "ERR_RSN_SENSOR_AMBIENT",
      "ERR_RSN_UNKNOWN_0x00000020",
    ]);
    expect(resolved[1].unknown).toBe(true);
  });

  it("survives a mask wider than the catalog and wider than 32 bits", () => {
    const resolved = decodeErrorMask("0x100000000", CATALOG);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].unknown).toBe(true);
    expect(resolved[0].code).toBe("0x100000000");
  });

  it("returns nothing for a zero mask when the catalog has no sentinel", () => {
    expect(decodeErrorMask(0, CATALOG.slice(1))).toEqual([]);
  });
});

describe("formatMaskHex / noneEntry", () => {
  it("renders a canonical eight-digit mask, widening only when it must", () => {
    expect(formatMaskHex(0n)).toBe("0x00000000");
    expect(formatMaskHex(24n)).toBe("0x00000018");
    expect(formatMaskHex(2147483648n)).toBe("0x80000000");
    expect(formatMaskHex(0x100000000n)).toBe("0x100000000");
  });

  it("finds the bit_value 0 sentinel", () => {
    expect(noneEntry(CATALOG)?.name).toBe("ERR_RSN_NONE");
    expect(noneEntry(CATALOG.slice(1))).toBeNull();
  });
});
