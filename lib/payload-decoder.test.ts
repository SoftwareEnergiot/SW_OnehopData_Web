import { describe, it, expect } from "vitest";
import {
  analyzePayload,
  decodePayload,
  hexToBytes,
  bytesToHex,
  PayloadDecodeError,
  expectedLength,
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
