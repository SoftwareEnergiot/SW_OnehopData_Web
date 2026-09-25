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
  V2_CONTEXT_FIELDS,
  V2_CONTEXT_SIZE,
  V2_HEADER_SIZE,
  V2_SAMPLE_SIZE,
  expectedLength,
  layoutFor,
} from "@/lib/payload-decoder";
import {
  COMM_ERRORS,
  ERR_BIT_BAT_STATUS_UNKNOWN,
  PAYLOAD_ERRORS,
  POWER_FLAG_EH_ACTIVE,
  POWER_FLAG_EH_READ_FAILED,
  POWER_FLAG_SUPERCAPS_CONNECTED,
  POWER_FLAG_SUPERCAPS_READ_FAILED,
  RESET_SOURCES,
  TIME_SOURCES,
  UVLOS_READ_FAILED,
  UVLO_THRESHOLDS,
  VALID_SAMPLE_BITS,
  describeResetSource,
  isBatterySocValid,
  resolveErrorMask,
  resolvePowerFlags,
  resolvePowerStatus,
  resolveResetSource,
  resolveStatusFlags,
  resolveUvlos,
} from "@/lib/payload-errors";

// Bytes each field type occupies, used to prove the tables tile their section
// exactly with no gap and no overlap.
const WIDTH = { int8: 1, uint8: 1, int16: 2, uint16: 2, uint32: 4 } as const;

describe("V1 section sizes", () => {
  it("matches the Overview table", () => {
    expect(V1_HEADER_SIZE).toBe(14);
    expect(V1_SAMPLE_SIZE).toBe(36);
    expect(V1_CONTEXT_SIZE).toBe(43);
    expect(expectedLength(1, 1)).toBe(93);
  });

  it("leaves V0 untouched", () => {
    expect(V0_HEADER_SIZE).toBe(2);
    expect(V0_SAMPLE_SIZE).toBe(28);
    expect(V0_CONTEXT_SIZE).toBe(8);
    expect(expectedLength(5, 0)).toBe(150);
  });

  it("no longer requires exactly one sample in the current V1 revision", () => {
    expect(layoutFor(1)!.requiredSampleCount).toBeNull();
    expect(layoutFor(0)!.requiredSampleCount).toBeNull();
  });
});

describe("V1 sample table", () => {
  // Ids 1-16 of the "Sample" table: [key, type, factor, unit].
  const SPEC = [
    ["time",                 "uint32", 1,  "s"],
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

  it("carries all 16 channels, in document order", () => {
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

  it("tiles the 36 bytes exactly, with no gap or overlap", () => {
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
  // Ids 1-17 of the "Context" table: [key, type, unit].
  const SPEC = [
    ["error_mask",               "uint32", ""],
    ["last_communication_error", "uint8",  ""],
    ["battery_soc",              "uint8",  "%"],
    ["battery_voltage",          "uint16", "mV"],
    ["config_crc32",             "uint32", ""],
    ["boot_count",               "uint32", ""],
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
    ["last_poll_status",         "uint8",  ""],
  ] as const;

  it("carries all 17 fields, in document order", () => {
    expect(V1_CONTEXT_FIELDS.map((f) => f.key)).toEqual(SPEC.map(([key]) => key));
  });

  it("gives each field the documented type and unit", () => {
    for (const [key, type, unit] of SPEC) {
      const field = V1_CONTEXT_FIELDS.find((f) => f.key === key)!;
      expect({ key, type: field.type, unit: field.unit }).toEqual({ key, type, unit });
    }
  });

  it("tiles the 43 bytes exactly, with no gap or overlap", () => {
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

describe("V2 layout", () => {
  it("is V1 with 4 more bytes at the end of the context", () => {
    const v2 = layoutFor(2)!;
    expect(V2_HEADER_SIZE).toBe(V1_HEADER_SIZE);
    expect(V2_SAMPLE_SIZE).toBe(V1_SAMPLE_SIZE);
    expect(V2_CONTEXT_SIZE).toBe(47);
    expect(v2.sampleFields).toBe(V1_SAMPLE_FIELDS);
    expect(V2_CONTEXT_FIELDS.slice(0, V1_CONTEXT_FIELDS.length)).toEqual(V1_CONTEXT_FIELDS);
  });

  it("is 61 + 36N bytes, N from 1 to 5", () => {
    expect(layoutFor(2)!.sampleCountRange).toEqual({ min: 1, max: 5 });
    for (let n = 1; n <= 5; n++) expect(expectedLength(n, 2)).toBe(61 + 36 * n);
    expect(expectedLength(1, 2)).toBe(97);
    expect(expectedLength(5, 2)).toBe(241);
  });

  // The fields at C+43..C+46: [key, offset, type, unit].
  const SPEC = [
    ["vin_mv",      43, "uint16", "mV"],
    ["uvlos_mask",  45, "uint8",  ""],
    ["power_flags", 46, "uint8",  ""],
  ] as const;

  it("appends vin_mv, uvlos_mask and power_flags, and tiles the 47 bytes", () => {
    const appended = V2_CONTEXT_FIELDS.slice(V1_CONTEXT_FIELDS.length);
    expect(appended.map((f) => [f.key, f.offset, f.type, f.unit])).toEqual(
      SPEC.map((row) => [...row]),
    );
    let offset = 0;
    for (const field of V2_CONTEXT_FIELDS) {
      expect({ key: field.key, offset: field.offset }).toEqual({ key: field.key, offset });
      offset += WIDTH[field.type];
    }
    expect(offset).toBe(V2_CONTEXT_SIZE);
  });
});

describe("uvlos_mask", () => {
  // The document's table: value -> [rising threshold V, window].
  const SPEC: [number, number, "short" | "wide"][] = [
    [0, 4, "short"],
    [1, 5, "short"],
    [2, 6, "short"],
    [3, 7, "short"],
    [4, 8, "short"],
    [5, 8, "wide"],
    [6, 10, "short"],
    [7, 10, "wide"],
    [8, 12, "short"],
    [9, 12, "wide"],
    [10, 14, "short"],
    [11, 14, "wide"],
    [12, 16, "short"],
    [13, 16, "wide"],
    [14, 18, "short"],
    [15, 18, "wide"],
  ];

  it("decodes all 16 selections as documented", () => {
    expect(UVLO_THRESHOLDS.map((d) => [d.value, d.risingV, d.window])).toEqual(SPEC);
  });

  it("reads 0xFF as a failed read", () => {
    expect(UVLOS_READ_FAILED).toBe(0xff);
    expect(resolveUvlos(0xff)).toBeNull();
    expect(resolvePowerStatus(12500, 0xff, 0x03).uvlos_mask).toBeNull();
  });
});

describe("power_flags", () => {
  it("uses bits 0-1 for the states and bits 6-7 for their read failures", () => {
    expect(POWER_FLAG_SUPERCAPS_CONNECTED).toBe(0x01);
    expect(POWER_FLAG_EH_ACTIVE).toBe(0x02);
    expect(POWER_FLAG_SUPERCAPS_READ_FAILED).toBe(0x40);
    expect(POWER_FLAG_EH_READ_FAILED).toBe(0x80);
  });

  it("decodes 0xC0 as both states unknown", () => {
    expect(resolvePowerFlags(0xc0)).toEqual({ supercaps_connected: null, eh_active: null });
    // The state bits say nothing while their read failed.
    expect(resolvePowerFlags(0xc3)).toEqual({ supercaps_connected: null, eh_active: null });
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

describe("error mask", () => {
  // Every defined bit of the "Error mask" table: 0x00000001 through 0x00400000.
  // 0x00800000 and above are reserved.
  it("has a catalog entry for every documented bit, and none reserved", () => {
    const bits = PAYLOAD_ERRORS.map((e) => e.bit).filter((b) => b !== 0);
    const documented = Array.from({ length: 23 }, (_, i) => 2 ** i);
    expect(bits).toEqual(documented);
  });

  it("names the three bits added with the sample time", () => {
    expect(resolveErrorMask(0x00100000)[0].name).toBe("ERR_RSN_BOOT_COUNT_NOT_STORED");
    expect(resolveErrorMask(0x00200000)[0].name).toBe("ERR_RSN_CLOCK_JUMP");
    expect(resolveErrorMask(0x00400000)[0].name).toBe("ERR_RSN_CLOCK_SYNC_FAILED");
  });

  it("still reports a reserved bit as unknown instead of dropping it", () => {
    expect(resolveErrorMask(0x00800000)[0].name).toContain("UNKNOWN");
  });
});

describe("status flags", () => {
  it("decodes the example 0xB7 as the document describes it", () => {
    // PSM granted, PSM acceptable, attached, NB-IoT, time UTC, source NTP.
    expect(resolveStatusFlags(0xb7)).toEqual([
      "PSM granted",
      "PSM acceptable",
      "Attached",
      "NB-IoT",
      "time UTC",
      "source NTP",
    ]);
  });

  it("maps bits 6-7 to the four time sources", () => {
    expect(TIME_SOURCES).toEqual({ 0: "no clock sync", 1: "modem clock", 2: "NTP", 3: "manual" });
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
      7: "Payload not sent: it contains the modem data-mode terminator (+++)",
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
