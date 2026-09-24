import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT_CONFIG,
  INGEST_DEFAULT_ENVIRONMENT,
  REE_ENVIRONMENT,
  configForEnvironment,
  environmentStatusLabel,
  getPayloadTable,
  isSupportedEnvironment,
} from "@/lib/environments";
import {
  DEVELOPMENT_SCHEMA,
  REE_SCHEMA,
  fieldOf,
  isReadingValid,
  schemaForEnvironment,
} from "@/lib/payload-schemas";
import { parseDeviceUidFilter } from "@/lib/payload-filters";
import { V1_CONTEXT_FIELDS } from "@/lib/payload-decoder";
import type { ReePayloadRecord } from "@/lib/types";

describe("environment -> payload table", () => {
  it("maps each environment to its own table", () => {
    expect(getPayloadTable("Development")).toBe("payloads");
    expect(getPayloadTable("REE")).toBe("payloads_REE");
  });

  it("keeps the REE table's uppercase identifier intact", () => {
    // `payloads_REE` was created quoted; `payloads_ree` is a different name
    // and PostgREST rejects it outright.
    expect(ENVIRONMENT_CONFIG.REE.payloadTable).toBe("payloads_REE");
    expect(ENVIRONMENT_CONFIG.REE.payloadTable).not.toBe("payloads_ree");
  });

  it("refuses to guess for an environment it has no mapping for", () => {
    expect(getPayloadTable("Staging")).toBeNull();
    expect(getPayloadTable("")).toBeNull();
    expect(getPayloadTable(null)).toBeNull();
    expect(configForEnvironment("Staging")).toBeNull();
    expect(isSupportedEnvironment("Staging")).toBe(false);
  });

  it("names the environments the ingestion endpoint routes between", () => {
    expect(getPayloadTable(INGEST_DEFAULT_ENVIRONMENT)).toBe("payloads");
    expect(getPayloadTable(REE_ENVIRONMENT)).toBe("payloads_REE");
  });

  it("renders the production flag as a word, never as a boolean", () => {
    expect(environmentStatusLabel(true)).toBe("Production");
    expect(environmentStatusLabel(false)).toBe("Development");
  });
});

describe("schema selection", () => {
  it("gives each environment the schema for its table", () => {
    expect(schemaForEnvironment("Development")).toBe(DEVELOPMENT_SCHEMA);
    expect(schemaForEnvironment("REE")).toBe(REE_SCHEMA);
    expect(schemaForEnvironment("Staging")).toBeNull();
  });

  it("only offers a feature the dataset can actually support", () => {
    // payloads_REE has no raw frame and no byte length...
    expect(REE_SCHEMA.capabilities.rawPayloadInspector).toBe(false);
    expect(REE_SCHEMA.capabilities.byteSizeChart).toBe(false);
    // ...but stores the batch context, error mask included, one column each.
    expect(REE_SCHEMA.capabilities.errorMask).toBe(true);
    expect(REE_SCHEMA.capabilities.diagnosticsCharts).toBe(true);
    // payloads has all of them.
    expect(DEVELOPMENT_SCHEMA.capabilities.rawPayloadInspector).toBe(true);
    expect(DEVELOPMENT_SCHEMA.capabilities.errorMask).toBe(true);
  });

  it("offers remote config in Development only", () => {
    expect(DEVELOPMENT_SCHEMA.capabilities.remoteConfig).toBe(true);
    expect(REE_SCHEMA.capabilities.remoteConfig).toBe(false);
  });

  it("declares a REE column for every V1 context field", () => {
    for (const { key, type } of V1_CONTEXT_FIELDS) {
      const field = fieldOf(REE_SCHEMA, key);
      expect(field, key).toBeDefined();
      expect(field!.group).toBe("Context");
      expect(field!.protocolType).toBe(type);
    }
    expect(fieldOf(REE_SCHEMA, "error_mask")!.kind).toBe("errorMask");
    expect(fieldOf(REE_SCHEMA, "last_tx_duration_ms")!.unit).toBe("ms");
  });

  it("describes every REE column with a label, and a unit where it has one", () => {
    const labelled = (key: string, label: string, unit?: string) => {
      const field = fieldOf(REE_SCHEMA, key);
      expect(field, key).toBeDefined();
      expect(field!.label).toBe(label);
      expect(field!.unit).toBe(unit);
    };

    labelled("thermocouple_1", "Thermocouple 1", "°C");
    labelled("thermocouple_2", "Thermocouple 2", "°C");
    labelled(
      "current_1_internal_temperature",
      "Current Sensor 1 Internal Temperature",
      "°C",
    );
    labelled(
      "current_2_internal_temperature",
      "Current Sensor 2 Internal Temperature",
      "°C",
    );
    labelled("ambient_temperature", "Ambient Temperature", "°C");
    labelled("internal_temperature", "Internal Temperature", "°C");
    labelled("ambient_humidity", "Ambient Humidity", "%RH");
    labelled("internal_humidity", "Internal Humidity", "%RH");
    labelled("luminosity", "Luminosity", "lux");
    labelled("acceleration_x", "Acceleration X", "mg");
    labelled("acceleration_y", "Acceleration Y", "mg");
    labelled("acceleration_z", "Acceleration Z", "mg");
    labelled("magnetic_field_1", "Magnetic Field 1", "µT");
    labelled("magnetic_field_2", "Magnetic Field 2", "µT");
    labelled("valid_sample_mask", "Valid Sample Mask", undefined);
  });

  it("selects every summary column from columns the REE table has", () => {
    const known = new Set(REE_SCHEMA.fields.map((field) => field.key));
    for (const tier of REE_SCHEMA.summaryColumnTiers) {
      for (const column of tier.split(",")) {
        expect(known.has(column), column).toBe(true);
      }
    }
  });

  it("charts REE diagnostics, and falls back to the sensors without them", () => {
    const [full, fallback] = REE_SCHEMA.summaryColumnTiers.map((tier) =>
      tier.split(","),
    );
    for (const column of ["battery_soc", "rsrp", "snr", "error_mask"]) {
      expect(full).toContain(column);
      expect(fallback).not.toContain(column);
    }
    expect(fallback).toContain("ambient_temperature");
  });
});

describe("valid sample mask", () => {
  const row = (mask: number | null) =>
    ({ valid_sample_mask: mask }) as unknown as ReePayloadRecord;

  it("discards a channel whose sensor bit is clear", () => {
    const ambient = fieldOf(REE_SCHEMA, "ambient_temperature")!;
    // Bit 0 governs the external ambient sensor.
    expect(isReadingValid(row(0b1), ambient)).toBe(true);
    expect(isReadingValid(row(0b0), ambient)).toBe(false);
  });

  it("maps each channel to the bit the protocol governs it with", () => {
    const bitOf = (key: string) => fieldOf(REE_SCHEMA, key)!.validBit;
    expect(bitOf("ambient_temperature")).toBe(0);
    expect(bitOf("ambient_humidity")).toBe(0);
    expect(bitOf("luminosity")).toBe(1);
    expect(bitOf("acceleration_x")).toBe(2);
    expect(bitOf("current_1_internal_temperature")).toBe(3);
    expect(bitOf("magnetic_field_1")).toBe(3);
    expect(bitOf("current_2_internal_temperature")).toBe(4);
    expect(bitOf("magnetic_field_2")).toBe(4);
    expect(bitOf("thermocouple_1")).toBe(5);
    expect(bitOf("thermocouple_2")).toBe(6);
    expect(bitOf("internal_temperature")).toBe(8);
    expect(bitOf("internal_humidity")).toBe(8);
  });

  it("treats a field with no governing bit, or a row with no mask, as read", () => {
    const counter = fieldOf(REE_SCHEMA, "reporting_counter")!;
    expect(isReadingValid(row(0), counter)).toBe(true);
    const ambient = fieldOf(REE_SCHEMA, "ambient_temperature")!;
    expect(isReadingValid(row(null), ambient)).toBe(true);
  });
});

describe("device UID filters per schema", () => {
  it("normalises a typed UID to the form each table stores", () => {
    expect(
      parseDeviceUidFilter("00124b0038a83d90", DEVELOPMENT_SCHEMA.deviceUidFormat),
    ).toEqual({ kind: "uid", uid: "00:12:4B:00:38:A8:3D:90" });

    expect(
      parseDeviceUidFilter("00:12:4B:00:38:A8:3D:90", REE_SCHEMA.deviceUidFormat),
    ).toEqual({ kind: "uid", uid: "00124B0038A83D90" });
  });

  it("still rejects a malformed UID rather than matching everything", () => {
    expect(parseDeviceUidFilter("00:12:4B", "plain")).toEqual({
      kind: "invalid",
      raw: "00:12:4B",
    });
  });
});
