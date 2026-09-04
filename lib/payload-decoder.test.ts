import { describe, it, expect } from "vitest";
import {
  analyzePayload,
  decodePayload,
  hexToBytes,
  bytesToHex,
  PayloadDecodeError,
  expectedLength,
  sampleFieldsFor,
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
// asserted byte for byte by test/core/test_telemetry_encode_v1.c in the
// firmware repository.
const V1_HEADER_HEX = "0100124B001A2B3C4D012A000000";
const V1_SAMPLE_HEX =
  "EB00F100DC00DF00BC008C02D7009001E2040000C60016FD1002DC05C8057F01";
const V1_CONTEXT_HEX =
  "180000000057AC0F030000000C0002000000A1FF0817C0A8000002000820000094110000";
const V1_EXAMPLE_HEX = V1_HEADER_HEX + V1_SAMPLE_HEX + V1_CONTEXT_HEX;

describe("decodePayload — V1 protocol example", () => {
  const decoded = decodePayload(hexToBytes(V1_EXAMPLE_HEX));

  it("decodes the header, including the device UID", () => {
    expect(decoded.payload_version).toBe(1);
    expect(decoded.device_uid).toBe("00:12:4B:00:1A:2B:3C:4D");
    expect(decoded.sample_count).toBe(1);
    expect(decoded.reporting_counter).toBe(42);
  });

  it("decodes sample[0] exactly as documented", () => {
    expect(decoded.samples).toHaveLength(1);
    expect(decoded.samples[0]).toEqual({
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

  it("decodes the full 36-byte context", () => {
    expect(decoded.context).toEqual({
      error_mask: 0x18,
      last_communication_error: 0,
      battery_soc: 87,
      battery_voltage: 4012,
      config_version: 3,
      boot_count: 12,
      reset_source: 0x02,
      rsrp: -95, // int16, negative
      snr: 8, // int8
      status_flags: 0x17,
      tau: 43200,
      active_time: 2,
      last_attach_duration_ms: 8200,
      last_tx_duration_ms: 4500,
      // Mirrored from the header so both formats expose it in one place.
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

  it("annotates the 82 bytes into 14/32/36 sections", () => {
    const analysis = analyzePayload(hexToBytes(V1_EXAMPLE_HEX));
    expect(analysis.meta.byteLength).toBe(82);
    expect(analysis.meta.expectedLength).toBe(expectedLength(1, 1));
    expect(analysis.meta.headerSize).toBe(14);
    expect(analysis.meta.sampleSize).toBe(32);
    expect(analysis.meta.contextSize).toBe(36);
    expect(analysis.bytes[13].section).toBe("header");
    expect(analysis.bytes[14].section).toBe("sample");
    expect(analysis.bytes[45].section).toBe("sample");
    expect(analysis.bytes[46].section).toBe("context");
    expect(analysis.bytes[81].section).toBe("context");
  });
});

describe("V1 validation", () => {
  it("rejects a V1 payload that is not 82 bytes", () => {
    const bytes = hexToBytes(V1_EXAMPLE_HEX + "ff");
    try {
      decodePayload(bytes);
      expect.unreachable();
    } catch (e) {
      expect((e as PayloadDecodeError).code).toBe("INVALID_LENGTH");
    }
  });

  it("rejects a V1 payload declaring more than one sample", () => {
    // Header says 2 samples and the body carries 2, so the geometry is
    // self-consistent — the spec still requires exactly one.
    const twoSamples =
      "0100124B001A2B3C4D022A000000" +
      V1_SAMPLE_HEX +
      V1_SAMPLE_HEX +
      V1_CONTEXT_HEX;
    const bytes = hexToBytes(twoSamples);
    expect(bytes.length).toBe(14 + 64 + 36);
    try {
      decodePayload(bytes);
      expect.unreachable();
    } catch (e) {
      expect((e as PayloadDecodeError).code).toBe("SAMPLE_COUNT_MISMATCH");
    }
  });

  it("still rejects an unknown version", () => {
    const bytes = hexToBytes(V1_EXAMPLE_HEX);
    bytes[0] = 2; // v2 is documented but not implemented yet
    try {
      decodePayload(bytes);
      expect.unreachable();
    } catch (e) {
      expect((e as PayloadDecodeError).code).toBe("UNSUPPORTED_VERSION");
    }
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
    expect(sampleFieldsFor(1)).toHaveLength(15);
  });

  it("sizes each version correctly", () => {
    expect(expectedLength(5, 0)).toBe(150);
    expect(expectedLength(1, 1)).toBe(82);
    // Callers written before the format became version-dependent still get V0.
    expect(expectedLength(5)).toBe(150);
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
