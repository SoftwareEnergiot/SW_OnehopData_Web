// Conformance tests: the field tables of the V1 protocol document, transcribed
// literally, asserted against the implementation.
//
// Source: https://energiot.atlassian.net/wiki/spaces/WSNFD/pages/670793729/V1
// (mirrored byte for byte at spaces/DP/pages/673579012/V1).
//
// The point is not to re-test the decoder — payload-decoder.test.ts does that
// against the canonical vector. It is to make a change to the document, or a
// drift in the implementation, fail loudly instead of silently decoding one
// field into another. When the spec changes, update the tables here first; the
// failures then point at every place the code needs to follow.

import { describe, expect, it } from "vitest";
import {
  V0_CONTEXT_SIZE,
  V0_HEADER_SIZE,
  V0_SAMPLE_SIZE,
  V1_CONTEXT_FIELDS,
  V1_CONTEXT_SIZE,
  V1_HEADER_SIZE,
  V1_SAMPLE_FIELDS,
  V1_SAMPLE_SIZE,
  expectedLength,
  layoutFor,
} from "@/lib/payload-decoder";
import {
  COMM_ERRORS,
  ERR_BIT_BAT_STATUS_UNKNOWN,
  RESET_SOURCES,
  VALID_SAMPLE_BITS,
  describeResetSource,
  isBatterySocValid,
  resolveResetSource,
} from "@/lib/payload-errors";

// Bytes each field type occupies, used to prove the tables tile their section
// exactly with no gap and no overlap.
const WIDTH = { int8: 1, uint8: 1, int16: 2, uint16: 2, uint32: 4 } as const;

describe("V1 section sizes", () => {
  it("matches the Overview table", () => {
    expect(V1_HEADER_SIZE).toBe(14);
    expect(V1_SAMPLE_SIZE).toBe(32);
    expect(V1_CONTEXT_SIZE).toBe(40);
    expect(expectedLength(1, 1)).toBe(86);
  });

  it("leaves V0 untouched", () => {
    expect(V0_HEADER_SIZE).toBe(2);
    expect(V0_SAMPLE_SIZE).toBe(28);
    expect(V0_CONTEXT_SIZE).toBe(8);
    expect(expectedLength(5, 0)).toBe(150);
  });

  it("requires exactly one sample in V1 and any number in V0", () => {
    expect(layoutFor(1)!.requiredSampleCount).toBe(1);
    expect(layoutFor(0)!.requiredSampleCount).toBeNull();
  });
});

describe("V1 sample table", () => {
  // Ids 1-15 of the "Sample" table: [key, type, factor, unit].
  const SPEC = [
    ["thermocouple_1",       "int16",  10, "C"],
    ["thermocouple_2",       "int16",  10, "C"],
    ["current_1_int_temp",   "int16",  10, "C"],
    ["current_2_int_temp",   "int16",  10, "C"],
    ["ambient_temperature",  "int16",  10, "C"],
    ["ambient_humidity",     "uint16", 10, "%RH"],
    ["internal_temperature", "int16",  10, "C"],
    ["internal_humidity",    "uint16", 10, "%RH"],
    ["luminosity",           "uint32", 1,  "lux"],
    ["acceleration_x",       "int16",  1,  "mg"],
    ["acceleration_y",       "int16",  1,  "mg"],
    ["acceleration_z",       "int16",  1,  "mg"],
    ["magnetic_field_1",     "uint16", 1,  "uT"],
    ["magnetic_field_2",     "uint16", 1,  "uT"],
    ["valid_sample_mask",    "uint16", 1,  ""],
  ] as const;

  it("carries all 15 channels, in document order", () => {
    expect(V1_SAMPLE_FIELDS.map((f) => f.key)).toEqual(SPEC.map(([key]) => key));
  });

  it("gives each channel the documented type, factor and unit", () => {
    for (const [key, type, factor, unit] of SPEC) {
      const field = V1_SAMPLE_FIELDS.find((f) => f.key === key)!;
      expect({ key, type: field.type, factor: field.factor, unit: field.unit }).toEqual({
        key,
        type,
        factor,
        unit,
      });
    }
  });

  it("tiles the 32 bytes exactly, with no gap or overlap", () => {
    let offset = 0;
    for (const field of V1_SAMPLE_FIELDS) {
      expect({ key: field.key, offset: field.offset }).toEqual({
        key: field.key,
        offset,
      });
      offset += WIDTH[field.type];
    }
    expect(offset).toBe(V1_SAMPLE_SIZE);
  });
});

describe("V1 context table", () => {
  // Ids 1-16 of the "Context" table: [key, type, unit].
  const SPEC = [
    ["error_mask",               "uint32", ""],
    ["last_communication_error", "uint8",  ""],
    ["battery_soc",              "uint8",  "%"],
    ["battery_voltage",          "uint16", "mV"],
    ["config_version",           "uint32", ""],
    ["boot_count",               "uint16", ""],
    ["reset_source",             "uint32", ""],
    ["rsrp",                     "int16",  "dBm"],
    ["snr",                      "int8",   "dB"],
    ["status_flags",             "uint8",  ""],
    ["tau",                      "uint32", "s"],
    ["active_time",              "uint16", "s"],
    ["last_attach_duration_ms",  "uint32", "ms"],
    ["last_tx_duration_ms",      "uint32", "ms"],
    ["reporting_lost_counter",   "uint16", ""],
    ["tx_failed",                "uint16", ""],
  ] as const;

  it("carries all 16 fields, in document order", () => {
    expect(V1_CONTEXT_FIELDS.map((f) => f.key)).toEqual(SPEC.map(([key]) => key));
  });

  it("gives each field the documented type and unit", () => {
    for (const [key, type, unit] of SPEC) {
      const field = V1_CONTEXT_FIELDS.find((f) => f.key === key)!;
      expect({ key, type: field.type, unit: field.unit }).toEqual({ key, type, unit });
    }
  });

  it("tiles the 40 bytes exactly, with no gap or overlap", () => {
    let offset = 0;
    for (const field of V1_CONTEXT_FIELDS) {
      expect({ key: field.key, offset: field.offset }).toEqual({
        key: field.key,
        offset,
      });
      offset += WIDTH[field.type];
    }
    expect(offset).toBe(V1_CONTEXT_SIZE);
  });
});

describe("valid sample mask", () => {
  // The "Valid sample mask" table, with the field ids resolved to channel keys.
  const SPEC: Record<number, string[]> = {
    0: ["ambient_temperature", "ambient_humidity"],
    1: ["luminosity"],
    2: ["acceleration_x", "acceleration_y", "acceleration_z"],
    3: ["current_1_int_temp", "magnetic_field_1"],
    4: ["current_2_int_temp", "magnetic_field_2"],
    5: ["thermocouple_1"],
    6: ["thermocouple_2"],
    7: [], // cable temperature 3, not used in v1
    8: ["internal_temperature", "internal_humidity"],
  };

  it("covers bits 0-8 and stops there (9-15 are reserved)", () => {
    expect(VALID_SAMPLE_BITS.map((b) => b.bit)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("maps each bit to the channels the document says it covers", () => {
    for (const bit of VALID_SAMPLE_BITS) {
      expect({ bit: bit.bit, fields: bit.fields }).toEqual({
        bit: bit.bit,
        fields: SPEC[bit.bit],
      });
    }
  });

  it("never names a channel that does not exist in the sample", () => {
    const keys = new Set(V1_SAMPLE_FIELDS.map((f) => f.key));
    for (const bit of VALID_SAMPLE_BITS) {
      for (const field of bit.fields) {
        expect(keys.has(field), `bit ${bit.bit} names unknown channel ${field}`).toBe(true);
      }
    }
  });
});

describe("last communication error", () => {
  it("matches the documented enum", () => {
    expect(COMM_ERRORS).toEqual({
      0: "None",
      1: "Attach",
      2: "HTTP connect",
      3: "HTTP request",
      4: "Sleep",
      5: "Clock",
      6: "Unknown",
    });
  });
});

describe("battery state of charge", () => {
  // "A value of 0 together with bit 0x00040000 set in the error mask means the
  // fuel gauge failed, not an empty battery." — Context table, field 3.
  it("treats a plain 0 as a genuinely flat battery", () => {
    expect(isBatterySocValid(0, 0)).toBe(true);
    // Some other error being set does not change the reading.
    expect(isBatterySocValid(0, 0x00000018)).toBe(true);
  });

  it("treats 0 with ERR_RSN_BAT_STATUS_UNKNOWN as no measurement", () => {
    expect(ERR_BIT_BAT_STATUS_UNKNOWN).toBe(0x00040000);
    expect(isBatterySocValid(0, ERR_BIT_BAT_STATUS_UNKNOWN)).toBe(false);
    // The bit alongside other errors still means the gauge failed.
    expect(isBatterySocValid(0, ERR_BIT_BAT_STATUS_UNKNOWN | 0x18)).toBe(false);
  });

  it("keeps a non-zero reading even when the gauge bit is set", () => {
    expect(isBatterySocValid(87, ERR_BIT_BAT_STATUS_UNKNOWN)).toBe(true);
  });

  it("keeps a reading above 100, which the firmware does not clamp", () => {
    expect(isBatterySocValid(104, 0)).toBe(true);
  });

  it("rejects a missing reading", () => {
    expect(isBatterySocValid(null, 0)).toBe(false);
    expect(isBatterySocValid(undefined, 0)).toBe(false);
  });
});

describe("reset source", () => {
  // NOTE: the protocol document does not define these values — it only says
  // "MCU reset source register of the last boot". The mapping is inferred from
  // the part (TI CC1352R) and is pending confirmation against the firmware.
  it("covers the eight CC13x2/CC26x2 reset sources", () => {
    expect(RESET_SOURCES.map((r) => r.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(RESET_SOURCES.map((r) => r.name)).toEqual([
      "PWR_ON",
      "PIN_RESET",
      "VDDS_LOSS",
      "VDDR_LOSS",
      "CLK_LOSS",
      "SYSRESET",
      "WARMRESET",
      "WAKEUP_FROM_SHUTDOWN",
    ]);
  });

  it("decodes the value carried by the canonical example payload", () => {
    const resolved = resolveResetSource(0x02);
    expect(resolved.recognised).toBe(true);
    expect(resolved.name).toBe("VDDS_LOSS");
    expect(describeResetSource(0x02)).toContain("0x00000002");
    expect(describeResetSource(0x02)).toContain("VDDS_LOSS");
  });

  it("refuses to guess at a value outside the documented range", () => {
    const resolved = resolveResetSource(0x1234);
    expect(resolved.recognised).toBe(false);
    expect(resolved.name).toBe("UNKNOWN");
    // The raw value still reaches the reader rather than being swallowed.
    expect(describeResetSource(0x1234)).toContain("0x00001234");
  });
});
