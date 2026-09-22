import { describe, expect, it } from "vitest";

import {
  V1_CONTEXT_FIELDS,
  analyzePayload,
  hexToBytes,
} from "@/lib/payload-decoder";
import { PayloadInsertError, rowsForSchema } from "@/lib/payload-insert";
import { DEVELOPMENT_SCHEMA, REE_SCHEMA } from "@/lib/payload-schemas";
import { canonicalUid } from "@/lib/payload-repository";

// The canonical V1 example from the protocol document, as the Playground ships
// it. One sample, device UID 00:12:4B:00:1A:2B:3C:4D.
const V1_EXAMPLE_HEX =
  "0100124B001A2B3C4D012A000000" +
  "A068AA6AEB00F100DC00DF00BC008C02D7009001E2040000C60016FD1002DC05C8057F01" +
  "180000000057AC0FEFCDAB890C00000002000000A1FF08B7C0A80000020008200000941100000200050000";

// The canonical V0 example: five samples, and no device UID at all.
const V0_EXAMPLE_HEX =
  "0005BB00DA00D700BC008C020000000000000000C60016FD100200000000BB00BA00D700BC008C020000000000000000C60016FD110200000000BB00DA00D700BC008C020000000000000000C70016FD100200000000BA00DA00D700BC008C020000000000000000C60016FD110200000000BA00DA00D700BC008B020000000000000000C60016FD1102000000001800000000000000";

const analyse = (hex: string) => analyzePayload(hexToBytes(hex));
const source = { ip: null, userAgent: null };

describe("rowsForSchema — Development", () => {
  it("stores the whole frame as one row, raw bytes included", () => {
    const analysis = analyse(V1_EXAMPLE_HEX);
    const rows = rowsForSchema(DEVELOPMENT_SCHEMA, analysis, source);

    expect(rows).toHaveLength(1);
    expect(rows[0].payload_hex).toBe(analysis.hex);
    expect(rows[0].byte_length).toBe(analysis.meta.byteLength);
    expect(rows[0].device_uid).toBe("00:12:4B:00:1A:2B:3C:4D");
    expect(rows[0].error_mask).toBe(analysis.decoded.error_mask);
    expect(rows[0].context).toEqual(analysis.decoded.context);
  });

  it("keeps storing a V0 payload, which has no UID", () => {
    const rows = rowsForSchema(DEVELOPMENT_SCHEMA, analyse(V0_EXAMPLE_HEX), source);
    expect(rows).toHaveLength(1);
    expect(rows[0].device_uid).toBeNull();
    expect(rows[0].sample_count).toBe(5);
  });
});

describe("rowsForSchema — REE", () => {
  it("stores one row per sample, with the report's header on each", () => {
    const analysis = analyse(V1_EXAMPLE_HEX);
    const rows = rowsForSchema(REE_SCHEMA, analysis, source);

    expect(rows).toHaveLength(analysis.decoded.sample_count);
    expect(rows[0].payload_version).toBe(analysis.decoded.payload_version);
    expect(rows[0].sample_count).toBe(analysis.decoded.sample_count);
    expect(rows[0].reporting_counter).toBe(analysis.decoded.reporting_counter);
  });

  it("stores the device UID in the unseparated form the REE table uses", () => {
    const rows = rowsForSchema(REE_SCHEMA, analyse(V1_EXAMPLE_HEX), source);
    expect(rows[0].device_uid).toBe("00124B001A2B3C4D");
  });

  it("writes engineering values into the float columns, raw counts elsewhere", () => {
    const analysis = analyse(V1_EXAMPLE_HEX);
    const sample = analysis.decoded.samples[0];
    const row = rowsForSchema(REE_SCHEMA, analysis, source)[0];

    // Scaled by the decoder's own factor of 10.
    expect(row.ambient_temperature).toBe(sample.ambient_temperature / 10);
    expect(row.thermocouple_1).toBe(sample.thermocouple_1 / 10);
    expect(row.internal_humidity).toBe(sample.internal_humidity / 10);
    // Factor 1 channels pass through untouched.
    expect(row.luminosity).toBe(sample.luminosity);
    expect(row.acceleration_x).toBe(sample.acceleration_x);
    expect(row.magnetic_field_1).toBe(sample.magnetic_field_1);
    expect(row.valid_sample_mask).toBe(sample.valid_sample_mask);
    expect(row.sample_time).toBe(sample.time);
  });

  it("names only columns that exist in payloads_REE", () => {
    const known = new Set(REE_SCHEMA.fields.map((field) => field.key));
    for (const row of rowsForSchema(REE_SCHEMA, analyse(V1_EXAMPLE_HEX), source)) {
      for (const column of Object.keys(row)) {
        expect(known.has(column), column).toBe(true);
      }
    }
  });

  it("stores every V1 context field in its own column, raw", () => {
    const analysis = analyse(V1_EXAMPLE_HEX);
    const row = rowsForSchema(REE_SCHEMA, analysis, source)[0];

    for (const { key } of V1_CONTEXT_FIELDS) {
      expect(row[key], key).toBe(analysis.decoded.context[key]);
    }
    // Spot-check against the document's example values.
    expect(row.error_mask).toBe(24);
    expect(row.boot_count).toBe(12);
    expect(row.rsrp).toBe(-95);
    expect(row.last_tx_duration_ms).toBe(4500);
    expect(row.last_poll_status).toBe(0);
  });

  it("never writes the resolved error list, only the mask", () => {
    const row = rowsForSchema(REE_SCHEMA, analyse(V1_EXAMPLE_HEX), source)[0];
    expect(row).not.toHaveProperty("errors");
    expect(row).not.toHaveProperty("context");
  });

  it("refuses a V0 payload rather than writing a UID it does not have", () => {
    expect(() =>
      rowsForSchema(REE_SCHEMA, analyse(V0_EXAMPLE_HEX), source),
    ).toThrow(PayloadInsertError);
  });
});

describe("canonicalUid", () => {
  it("reads any separator and case as the same device", () => {
    expect(canonicalUid("00:12:4B:00:38:A8:3D:90")).toBe("00124B0038A83D90");
    expect(canonicalUid("00124b0038a83d90")).toBe("00124B0038A83D90");
    expect(canonicalUid("00-12-4b-00-38-a8-3d-90")).toBe("00124B0038A83D90");
  });

  it("rejects anything that is not 8 bytes of hex", () => {
    expect(canonicalUid("00:12:4B")).toBeNull();
    expect(canonicalUid("")).toBeNull();
    expect(canonicalUid(null)).toBeNull();
    expect(canonicalUid(undefined)).toBeNull();
  });
});
