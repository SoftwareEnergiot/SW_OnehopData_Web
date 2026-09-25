import { describe, it, expect } from "vitest";
import {
  analyzePayload,
  decodePayload,
  hexToBytes,
  bytesToHex,
  PayloadDecodeError,
  expectedLength,
  sampleFieldsFor,
  sampleInstant,
  normalizeDeviceUid,
} from "@/lib/payload-decoder";

// The canonical example from "Payload Encode - LoraWAN V0.md".
const EXAMPLE_HEX =
  "0005BB00DA00D700BC008C020000000000000000C60016FD100200000000" +
  "BB00BA00D700BC008C020000000000000000C60016FD110200000000" +
  "BB00DA00D700BC008C020000000000000000C70016FD100200000000" +
  "BA00DA00D700BC008C020000000000000000C60016FD110200000000" +
  "BA00DA00D700BC008B020000000000000000C60016FD110200000000" +
  "1800000000000000";

describe("decodePayload — protocol example", () => {
  const decoded = decodePayload(hexToBytes(EXAMPLE_HEX));

  it("decodes the header", () => {
    expect(decoded.payload_version).toBe(0);
    expect(decoded.sample_count).toBe(5);
    expect(decoded.samples).toHaveLength(5);
  });

  it("decodes sample[0] exactly as documented", () => {
    expect(decoded.samples[0]).toEqual({
      temp1_x10: 187,
      temp2_x10: 218,
      temp3_x10: 215,
      amb_temp_x10: 188,
      amb_hum_x10: 652,
      int_temp_x10: 0,
      int_hum_x10: 0,
      lux: 0,
      accel_x: 198,
      accel_y: -746, // int16 two's complement (0xFD16)
      accel_z: 528,
      current1: 0,
      current2: 0,
    });
  });

  it("decodes the signed accel_z variations across samples", () => {
    expect(decoded.samples.map((s) => s.accel_z)).toEqual([528, 529, 528, 529, 529]);
    expect(decoded.samples[1].temp2_x10).toBe(186);
    expect(decoded.samples[4].amb_hum_x10).toBe(651);
  });

  it("decodes the batch context and error mask", () => {
    expect(decoded.context.error_mask).toBe(0x18);
    expect(decoded.error_mask_hex).toBe("0x00000018");
    expect(decoded.context.reporting_counter).toBe(0);
  });

  it("resolves error mask 0x18 to hall effect sensors 1 and 2", () => {
    const names = decoded.errors.map((e) => e.name);
    expect(names).toEqual([
      "ERR_RSN_SENSOR_HALL_EFFECT_1",
      "ERR_RSN_SENSOR_HALL_EFFECT_2",
    ]);
  });
});

describe("analyzePayload", () => {
  it("produces round-trippable hex and correct metadata", () => {
    const bytes = hexToBytes(EXAMPLE_HEX);
    const analysis = analyzePayload(bytes);
    expect(analysis.hex).toBe(EXAMPLE_HEX.toLowerCase());
    expect(bytesToHex(bytes)).toBe(EXAMPLE_HEX.toLowerCase());
    expect(analysis.meta.byteLength).toBe(150); // 10 + 28*5
    expect(analysis.meta.expectedLength).toBe(expectedLength(5));
    expect(analysis.bytes).toHaveLength(150);
    expect(analysis.bytes[0].section).toBe("header");
    expect(analysis.bytes[2].section).toBe("sample");
    expect(analysis.bytes[149].section).toBe("context");
  });
});

describe("input types", () => {
  it("accepts ArrayBuffer, Uint8Array and Buffer alike", () => {
    const u8 = hexToBytes(EXAMPLE_HEX);
    const ab = u8.buffer.slice(
      u8.byteOffset,
      u8.byteOffset + u8.byteLength,
    ) as ArrayBuffer;
    const buf = Buffer.from(u8);
    expect(decodePayload(ab).sample_count).toBe(5);
    expect(decodePayload(u8).sample_count).toBe(5);
    expect(decodePayload(buf).sample_count).toBe(5);
  });
});

describe("validation", () => {
  it("rejects an empty payload", () => {
    expect(() => decodePayload(new Uint8Array(0))).toThrowError(PayloadDecodeError);
    try {
      decodePayload(new Uint8Array(0));
    } catch (e) {
      expect((e as PayloadDecodeError).code).toBe("EMPTY_PAYLOAD");
    }
  });

  it("rejects a too-short payload", () => {
    try {
      decodePayload(new Uint8Array(4));
    } catch (e) {
      expect((e as PayloadDecodeError).code).toBe("INVALID_LENGTH");
    }
  });

  it("rejects an unsupported version", () => {
    const bytes = hexToBytes(EXAMPLE_HEX);
    bytes[0] = 9; // bogus version
    try {
      decodePayload(bytes);
    } catch (e) {
      expect((e as PayloadDecodeError).code).toBe("UNSUPPORTED_VERSION");
    }
  });

  it("rejects a sample-count mismatch", () => {
    const bytes = hexToBytes(EXAMPLE_HEX);
    bytes[1] = 4; // header says 4 but body still holds 5 samples
    try {
      decodePayload(bytes);
    } catch (e) {
      expect((e as PayloadDecodeError).code).toBe("SAMPLE_COUNT_MISMATCH");
    }
  });

  it("rejects a malformed (non-28-multiple) body", () => {
    const bytes = hexToBytes(EXAMPLE_HEX + "ff"); // one stray byte
    try {
      decodePayload(bytes);
    } catch (e) {
      expect((e as PayloadDecodeError).code).toBe("INVALID_LENGTH");
    }
  });
});

// The canonical example from the V1 protocol page (Confluence, space WSNFD),
// current revision: 93 bytes, with the per-sample time.
const V1_HEADER_HEX = "0100124B001A2B3C4D012A000000";
const V1_SAMPLE_HEX =
  "A068AA6AEB00F100DC00DF00BC008C02D7009001E2040000C60016FD1002DC05C8057F01";
const V1_CONTEXT_HEX =
  "180000000057AC0FEFCDAB890C00000002000000A1FF08B7C0A80000020008200000941100000200050000";
const V1_EXAMPLE_HEX = V1_HEADER_HEX + V1_SAMPLE_HEX + V1_CONTEXT_HEX;

// The same document's example in its two earlier revisions. The version byte
// never changed, so devices on older firmware send these under version 1, and
// payloads in these shapes are already stored.
const V1_LEGACY_SAMPLE_HEX =
  "EB00F100DC00DF00BC008C02D7009001E2040000C60016FD1002DC05C8057F01";
const V1_REV_86_HEX =
  V1_HEADER_HEX +
  V1_LEGACY_SAMPLE_HEX +
  "180000000057AC0F030000000C0002000000A1FF0817C0A800000200082000009411000002000500";
const V1_REV_82_HEX =
  V1_HEADER_HEX +
  V1_LEGACY_SAMPLE_HEX +
  "180000000057AC0F030000000C0002000000A1FF0817C0A8000002000820000094110000";

describe("decodePayload — V1 protocol example", () => {
  const decoded = decodePayload(hexToBytes(V1_EXAMPLE_HEX));

  it("reads the current 93-byte revision", () => {
    expect(hexToBytes(V1_EXAMPLE_HEX)).toHaveLength(93);
    expect(decoded.layout_revision).toBe("v1");
  });

  it("decodes the header, including the device UID", () => {
    expect(decoded.payload_version).toBe(1);
    expect(decoded.device_uid).toBe("00:12:4B:00:1A:2B:3C:4D");
    expect(decoded.sample_count).toBe(1);
    expect(decoded.reporting_counter).toBe(42);
  });

  it("decodes sample[0] exactly as documented, time included", () => {
    expect(decoded.samples).toHaveLength(1);
    expect(decoded.samples[0]).toEqual({
      time: 1789552800, // 2026-09-16 10:00:00 UTC
      thermocouple_1: 235, // 23.5 C
      thermocouple_2: 241, // 24.1 C
      current_1_int_temp: 220, // 22.0 C
      current_2_int_temp: 223, // 22.3 C
      ambient_temperature: 188, // 18.8 C
      ambient_humidity: 652, // 65.2 %RH
      internal_temperature: 215, // 21.5 C
      internal_humidity: 400, // 40.0 %RH
      luminosity: 1250,
      acceleration_x: 198,
      acceleration_y: -746, // int16 two's complement (0xFD16)
      acceleration_z: 528,
      magnetic_field_1: 1500,
      magnetic_field_2: 1480,
      valid_sample_mask: 0x017f,
    });
  });

  it("reads the sample time as UTC when status flags bit 5 is set", () => {
    expect(decoded.sample_time_utc).toBe(true);
    expect(sampleInstant(decoded, decoded.samples[0])?.toISOString()).toBe(
      "2026-09-16T10:00:00.000Z",
    );
  });

  it("decodes the full 43-byte context", () => {
    expect(decoded.context).toEqual({
      error_mask: 0x18,
      last_communication_error: 0,
      battery_soc: 87,
      battery_voltage: 4012,
      config_crc32: 0x89abcdef,
      boot_count: 12, // uint32 in this revision
      reset_source: 0x02,
      rsrp: -95, // int16, negative
      snr: 8, // int8
      status_flags: 0xb7, // PSM granted + acceptable, attached, NB-IoT, UTC, NTP
      tau: 43200,
      active_time: 2,
      last_attach_duration_ms: 8200,
      last_tx_duration_ms: 4500,
      reporting_lost_counter: 2,
      tx_failed: 5,
      last_poll_status: 0,
      // Mirrored from the header so every format exposes it in one place.
      reporting_counter: 42,
    });
  });

  it("resolves the error mask with the same catalog as V0", () => {
    expect(decoded.error_mask_hex).toBe("0x00000018");
    expect(decoded.errors.map((e) => e.name)).toEqual([
      "ERR_RSN_SENSOR_HALL_EFFECT_1",
      "ERR_RSN_SENSOR_HALL_EFFECT_2",
    ]);
  });

  it("annotates the 93 bytes into 14/36/43 sections", () => {
    const analysis = analyzePayload(hexToBytes(V1_EXAMPLE_HEX));
    expect(analysis.meta.byteLength).toBe(93);
    expect(analysis.meta.expectedLength).toBe(expectedLength(1, 1));
    expect(analysis.meta.revision).toBe("v1");
    expect(analysis.meta.headerSize).toBe(14);
    expect(analysis.meta.sampleSize).toBe(36);
    expect(analysis.meta.contextSize).toBe(43);
    expect(analysis.bytes[13].section).toBe("header");
    expect(analysis.bytes[14].section).toBe("sample");
    expect(analysis.bytes[49].section).toBe("sample");
    expect(analysis.bytes[50].section).toBe("context");
    expect(analysis.bytes[92].section).toBe("context");
  });
});

describe("sample time", () => {
  it("is seconds since boot when status flags bit 5 is clear", () => {
    const bytes = hexToBytes(V1_EXAMPLE_HEX);
    // status_flags sits at context offset 23 = byte 14 + 36 + 23.
    const at = 14 + 36 + 23;
    bytes[at] = bytes[at] & ~0x20;
    const decoded = decodePayload(bytes);
    expect(decoded.sample_time_utc).toBe(false);
    // No absolute time: the document says to use the reception time instead.
    expect(sampleInstant(decoded, decoded.samples[0])).toBeNull();
  });

  it("does not exist in formats that carry no sample time", () => {
    expect(decodePayload(hexToBytes(V1_REV_86_HEX)).sample_time_utc).toBeNull();
    expect(decodePayload(hexToBytes(EXAMPLE_HEX)).sample_time_utc).toBeNull();
  });
});

describe("earlier V1 revisions", () => {
  it("still decodes the 86-byte revision", () => {
    const decoded = decodePayload(hexToBytes(V1_REV_86_HEX));
    expect(decoded.layout_revision).toBe("v1-86");
    expect(decoded.device_uid).toBe("00:12:4B:00:1A:2B:3C:4D");
    expect(decoded.samples[0].thermocouple_1).toBe(235);
    expect(decoded.samples[0].time).toBeUndefined();
    expect(decoded.context.config_version).toBe(3);
    expect(decoded.context.boot_count).toBe(12);
    expect(decoded.context.reset_source).toBe(0x02);
    expect(decoded.context.reporting_lost_counter).toBe(2);
    expect(decoded.context.tx_failed).toBe(5);
  });

  it("still decodes the original 82-byte revision", () => {
    const decoded = decodePayload(hexToBytes(V1_REV_82_HEX));
    expect(decoded.layout_revision).toBe("v1-82");
    expect(decoded.samples[0].valid_sample_mask).toBe(0x017f);
    expect(decoded.context.last_tx_duration_ms).toBe(4500);
    expect(decoded.context.reporting_lost_counter).toBeUndefined();
  });

  it("keeps requiring a single sample in the earlier revisions", () => {
    const twoSamples =
      "0100124B001A2B3C4D022A000000" +
      V1_LEGACY_SAMPLE_HEX +
      V1_LEGACY_SAMPLE_HEX +
      "180000000057AC0F030000000C0002000000A1FF0817C0A800000200082000009411000002000500";
    try {
      decodePayload(hexToBytes(twoSamples));
      expect.unreachable();
    } catch (e) {
      expect((e as PayloadDecodeError).code).toBe("SAMPLE_COUNT_MISMATCH");
    }
  });
});

describe("V1 validation", () => {
  it("rejects a V1 payload matching no revision", () => {
    const bytes = hexToBytes(V1_EXAMPLE_HEX + "ff");
    try {
      decodePayload(bytes);
      expect.unreachable();
    } catch (e) {
      expect((e as PayloadDecodeError).code).toBe("INVALID_LENGTH");
    }
  });

  it("accepts several samples in the current revision", () => {
    // The document no longer requires rejecting sample_count != 1.
    const twoSamples =
      "0100124B001A2B3C4D022A000000" +
      V1_SAMPLE_HEX +
      V1_SAMPLE_HEX +
      V1_CONTEXT_HEX;
    const decoded = decodePayload(hexToBytes(twoSamples));
    expect(decoded.layout_revision).toBe("v1");
    expect(decoded.samples).toHaveLength(2);
  });

  it("still rejects an unknown version", () => {
    const bytes = hexToBytes(V1_EXAMPLE_HEX);
    bytes[0] = 3;
    try {
      decodePayload(bytes);
      expect.unreachable();
    } catch (e) {
      expect((e as PayloadDecodeError).code).toBe("UNSUPPORTED_VERSION");
    }
  });
});

// The V2 reference vector (N = 1, 97 bytes): the V1 example with version 2 and
// the power stage appended to the context.
const V2_HEADER_HEX = "0200124B001A2B3C4D012A000000";
const V2_POWER_HEX = "D4300803"; // vin_mv 12500, uvlos_mask 8, power_flags 0x03
const V2_EXAMPLE_HEX = V2_HEADER_HEX + V1_SAMPLE_HEX + V1_CONTEXT_HEX + V2_POWER_HEX;

// Context offset of the power stage bytes in a one-sample V2 frame.
const V2_UVLOS_AT = 14 + 36 + 45;
const V2_POWER_FLAGS_AT = 14 + 36 + 46;

function decodeCode(bytes: Uint8Array): string {
  try {
    decodePayload(bytes);
  } catch (e) {
    return (e as PayloadDecodeError).code;
  }
  return "decoded";
}

describe("decodePayload — V2 reference vector", () => {
  const bytes = hexToBytes(V2_EXAMPLE_HEX);
  const decoded = decodePayload(bytes);

  it("is 97 bytes and reads as V2", () => {
    expect(bytes).toHaveLength(97);
    expect(decoded.payload_version).toBe(2);
    expect(decoded.layout_revision).toBe("v2");
  });

  it("decodes the header", () => {
    expect(decoded.device_uid).toBe("00:12:4B:00:1A:2B:3C:4D");
    expect(decoded.sample_count).toBe(1);
    expect(decoded.reporting_counter).toBe(42);
  });

  it("decodes the sample exactly as V1 does", () => {
    const v1 = decodePayload(hexToBytes(V1_EXAMPLE_HEX));
    expect(decoded.samples).toEqual(v1.samples);
    expect(decoded.samples[0]).toMatchObject({
      time: 1789552800,
      thermocouple_1: 235,
      thermocouple_2: 241,
      current_1_int_temp: 220,
      current_2_int_temp: 223,
      ambient_temperature: 188,
      ambient_humidity: 652,
      internal_temperature: 215,
      internal_humidity: 400,
      luminosity: 1250,
      acceleration_x: 198,
      acceleration_y: -746,
      acceleration_z: 528,
      magnetic_field_1: 1500,
      magnetic_field_2: 1480,
      valid_sample_mask: 0x017f,
    });
    expect(sampleInstant(decoded, decoded.samples[0])?.toISOString()).toBe(
      "2026-09-16T10:00:00.000Z",
    );
  });

  it("decodes C+0..C+42 as V1, then the three power-stage bytes raw", () => {
    expect(decoded.context).toEqual({
      error_mask: 0x18,
      last_communication_error: 0,
      battery_soc: 87,
      battery_voltage: 4012,
      config_crc32: 0x89abcdef,
      boot_count: 12,
      reset_source: 2,
      rsrp: -95,
      snr: 8,
      status_flags: 0xb7,
      tau: 43200,
      active_time: 2,
      last_attach_duration_ms: 8200,
      last_tx_duration_ms: 4500,
      reporting_lost_counter: 2,
      tx_failed: 5,
      last_poll_status: 0,
      vin_mv: 12500,
      uvlos_mask: 8,
      power_flags: 0x03,
      reporting_counter: 42,
    });
    expect(decoded.sample_time_utc).toBe(true);
    expect(decoded.errors.map((e) => e.name)).toEqual([
      "ERR_RSN_SENSOR_HALL_EFFECT_1",
      "ERR_RSN_SENSOR_HALL_EFFECT_2",
    ]);
  });

  it("decodes the power stage", () => {
    expect(decoded.power).toEqual({
      vin_mv: 12500,
      uvlos_mask: 8,
      uvlos_rising_v: 12,
      uvlos_window: "short",
      supercaps_connected: true,
      eh_active: true,
    });
  });

  it("annotates the 97 bytes into 14/36/47 sections", () => {
    const analysis = analyzePayload(bytes);
    expect(analysis.meta.expectedLength).toBe(97);
    expect(expectedLength(1, 2)).toBe(97);
    expect(expectedLength(5, 2)).toBe(241);
    expect(analysis.meta.contextSize).toBe(47);
    expect(analysis.bytes[49].section).toBe("sample");
    expect(analysis.bytes[50].section).toBe("context");
    expect(analysis.bytes[96].section).toBe("context");
  });
});

describe("V2 validation", () => {
  it("rejects 96 and 98 bytes with N = 1", () => {
    expect(decodeCode(hexToBytes(V2_EXAMPLE_HEX.slice(0, -2)))).toBe("INVALID_LENGTH");
    expect(decodeCode(hexToBytes(V2_EXAMPLE_HEX + "00"))).toBe("INVALID_LENGTH");
  });

  it("rejects a V1-length frame carrying version 2", () => {
    expect(decodeCode(hexToBytes("02" + V1_EXAMPLE_HEX.slice(2)))).toBe("INVALID_LENGTH");
  });

  it("accepts N from 1 to 5, at exactly 61 + 36N bytes", () => {
    for (let n = 1; n <= 5; n++) {
      const hex =
        "0200124B001A2B3C4D" +
        n.toString(16).padStart(2, "0") +
        "2A000000" +
        V1_SAMPLE_HEX.repeat(n) +
        V1_CONTEXT_HEX +
        V2_POWER_HEX;
      const decoded = decodePayload(hexToBytes(hex));
      expect(hexToBytes(hex)).toHaveLength(61 + 36 * n);
      expect(decoded.samples).toHaveLength(n);
      expect(decoded.power?.vin_mv).toBe(12500);
    }
  });

  it("rejects N = 0 and N = 6 even when the length agrees", () => {
    const frame = (n: number) =>
      hexToBytes(
        "0200124B001A2B3C4D" +
          n.toString(16).padStart(2, "0") +
          "2A000000" +
          V1_SAMPLE_HEX.repeat(n) +
          V1_CONTEXT_HEX +
          V2_POWER_HEX,
      );
    expect(decodeCode(frame(0))).toBe("SAMPLE_COUNT_MISMATCH");
    expect(decodeCode(frame(6))).toBe("SAMPLE_COUNT_MISMATCH");
  });

  it("rejects a header N that disagrees with the length", () => {
    const bytes = hexToBytes(V2_EXAMPLE_HEX);
    bytes[9] = 2;
    expect(decodeCode(bytes)).toBe("SAMPLE_COUNT_MISMATCH");
  });
});

describe("V2 power stage", () => {
  const withByte = (at: number, value: number) => {
    const bytes = hexToBytes(V2_EXAMPLE_HEX);
    bytes[at] = value;
    return decodePayload(bytes);
  };

  it("reads uvlos_mask 0xFF as unknown, raw byte kept in the context", () => {
    const decoded = withByte(V2_UVLOS_AT, 0xff);
    expect(decoded.context.uvlos_mask).toBe(0xff);
    expect(decoded.power).toMatchObject({
      uvlos_mask: null,
      uvlos_rising_v: null,
      uvlos_window: null,
    });
    // The other readings are unaffected.
    expect(decoded.power?.vin_mv).toBe(12500);
    expect(decoded.power?.supercaps_connected).toBe(true);
  });

  it("reads power_flags 0xC0 as both states unknown, not false", () => {
    const decoded = withByte(V2_POWER_FLAGS_AT, 0xc0);
    expect(decoded.power?.supercaps_connected).toBeNull();
    expect(decoded.power?.eh_active).toBeNull();
  });

  it("keeps each power_flags state independent of the other's failure", () => {
    expect(withByte(V2_POWER_FLAGS_AT, 0x40 | 0x03).power).toMatchObject({
      supercaps_connected: null,
      eh_active: true,
    });
    expect(withByte(V2_POWER_FLAGS_AT, 0x80 | 0x01).power).toMatchObject({
      supercaps_connected: true,
      eh_active: null,
    });
    // A clear bit with no failure is a real "no".
    expect(withByte(V2_POWER_FLAGS_AT, 0x00).power).toMatchObject({
      supercaps_connected: false,
      eh_active: false,
    });
  });

  it("ignores the reserved power_flags bits 2-5", () => {
    expect(withByte(V2_POWER_FLAGS_AT, 0x3c | 0x03).power).toMatchObject({
      supercaps_connected: true,
      eh_active: true,
    });
  });

  it("reads vin_mv 0 as a failed read", () => {
    const bytes = hexToBytes(V2_EXAMPLE_HEX);
    bytes[14 + 36 + 43] = 0;
    bytes[14 + 36 + 44] = 0;
    expect(decodePayload(bytes).power?.vin_mv).toBeNull();
  });

  it("does not decode a uvlos_mask with the always-zero bits set", () => {
    const decoded = withByte(V2_UVLOS_AT, 0x18);
    expect(decoded.power?.uvlos_mask).toBe(0x18);
    expect(decoded.power?.uvlos_rising_v).toBeNull();
    expect(decoded.power?.uvlos_window).toBeNull();
  });

  it("is absent from V1 and V0 payloads", () => {
    expect(decodePayload(hexToBytes(V1_EXAMPLE_HEX)).power).toBeNull();
    expect(decodePayload(hexToBytes(EXAMPLE_HEX)).power).toBeNull();
  });
});

describe("V1 alongside V2", () => {
  it("decodes the V1 example exactly as before", () => {
    const decoded = decodePayload(hexToBytes(V1_EXAMPLE_HEX));
    expect(decoded.layout_revision).toBe("v1");
    expect(decoded.context).not.toHaveProperty("vin_mv");
    expect(Object.keys(decoded.context)).toHaveLength(18);
  });

  it("still accepts a V1 frame of more than five samples", () => {
    // The 1..5 bound is V2's; V1 is left as it was.
    const sixSamples =
      "0100124B001A2B3C4D062A000000" + V1_SAMPLE_HEX.repeat(6) + V1_CONTEXT_HEX;
    expect(decodePayload(hexToBytes(sixSamples)).samples).toHaveLength(6);
  });
});

describe("version dispatch", () => {
  it("keeps V0 payloads free of a device UID", () => {
    expect(decodePayload(hexToBytes(EXAMPLE_HEX)).device_uid).toBeNull();
  });

  it("gives each version its own channel set", () => {
    expect(sampleFieldsFor(0).map((f) => f.key)).toContain("temp1_x10");
    expect(sampleFieldsFor(1).map((f) => f.key)).toContain("thermocouple_1");
    expect(sampleFieldsFor(0)).toHaveLength(13);
    expect(sampleFieldsFor(1)).toHaveLength(16);
  });

  it("sizes each version correctly", () => {
    expect(expectedLength(5, 0)).toBe(150);
    expect(expectedLength(1, 1)).toBe(93);
    expect(expectedLength(1, 2)).toBe(97);
    // Callers written before the format became version-dependent still get V0.
    expect(expectedLength(5)).toBe(150);
  });
});

describe("normalizeDeviceUid", () => {
  it("accepts any separator and case", () => {
    const canonical = "00:12:4B:00:1A:2B:3C:4D";
    expect(normalizeDeviceUid(canonical)).toBe(canonical);
    expect(normalizeDeviceUid("00124b001a2b3c4d")).toBe(canonical);
    expect(normalizeDeviceUid("00-12-4B-00-1A-2B-3C-4D")).toBe(canonical);
    expect(normalizeDeviceUid(" 00 12 4b 00 1a 2b 3c 4d ")).toBe(canonical);
  });

  it("rejects anything that is not exactly 8 bytes", () => {
    expect(normalizeDeviceUid("00:12:4B")).toBeNull();
    expect(normalizeDeviceUid("00124b001a2b3c4d00")).toBeNull();
    expect(normalizeDeviceUid("")).toBeNull();
  });
});

describe("hexToBytes", () => {
  it("strips 0x prefixes and separators", () => {
    expect(Array.from(hexToBytes("0x00 05"))).toEqual([0, 5]);
    expect(Array.from(hexToBytes("00:05"))).toEqual([0, 5]);
  });

  it("throws on odd length and non-hex characters", () => {
    expect(() => hexToBytes("abc")).toThrowError(PayloadDecodeError);
    expect(() => hexToBytes("zz")).toThrowError(PayloadDecodeError);
  });
});
