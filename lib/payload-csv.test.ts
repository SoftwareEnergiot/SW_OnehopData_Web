import { describe, expect, it } from "vitest";

import { buildCsv } from "@/lib/payload-csv";
import { PAYLOAD_SCHEMAS, DEVELOPMENT_SCHEMA, REE_SCHEMA } from "@/lib/payload-schemas";
import type { PayloadRow } from "@/lib/types";

const row = (values: Record<string, unknown>) => values as unknown as PayloadRow;

function cell(schema = DEVELOPMENT_SCHEMA, key: string, values: Record<string, unknown>) {
  const column = schema.csvColumns.find((c) => c.key === key);
  if (!column) throw new Error(`no CSV column ${key}`);
  return column.value(row(values));
}

describe("CSV columns", () => {
  it("offers exactly one column per table field, in field order, in both environments", () => {
    for (const schema of Object.values(PAYLOAD_SCHEMAS)) {
      expect(schema.csvColumns.map((c) => c.key)).toEqual(schema.fields.map((f) => f.key));
    }
  });

  it("labels a column like the table header, unit included", () => {
    const column = REE_SCHEMA.csvColumns.find((c) => c.key === "ambient_temperature");
    expect(column?.label).toBe("Ambient Temperature (°C)");
  });

  it("exports a missing value or an unread sensor as empty, never as 0", () => {
    expect(cell(DEVELOPMENT_SCHEMA, "battery_soc", { battery_soc: null })).toBe("");
    // valid_sample_mask bit 0 (ambient) clear: the 0 on the wire is no reading.
    expect(
      cell(DEVELOPMENT_SCHEMA, "ambient_temperature", { ambient_temperature: 0, valid_sample_mask: 0 }),
    ).toBe("");
    expect(
      cell(DEVELOPMENT_SCHEMA, "ambient_temperature", { ambient_temperature: 21.5, valid_sample_mask: 1 }),
    ).toBe("21.5");
  });

  it("writes the error mask in hex and the sample time as UTC or uptime", () => {
    expect(cell(REE_SCHEMA, "error_mask", { error_mask: 24 })).toBe("0x00000018");
    expect(cell(REE_SCHEMA, "sample_time", { sample_time: 1789552800, status_flags: 0x20 })).toBe(
      "2026-09-16T10:00:00.000Z",
    );
    expect(cell(REE_SCHEMA, "sample_time", { sample_time: 42, status_flags: 0 })).toBe("uptime 42 s");
  });

  it("builds only the given columns, quoting as RFC 4180 needs", () => {
    const columns = DEVELOPMENT_SCHEMA.csvColumns.filter((c) =>
      ["device_uid", "reporting_counter"].includes(c.key),
    );
    const csv = buildCsv(
      [row({ device_uid: "00:12:4B:00:38:A8:3D:92", reporting_counter: 7, payload_hex: "01" })],
      columns,
    );
    expect(csv).toBe("Device UID,Counter\r\n00:12:4B:00:38:A8:3D:92,7");
  });
});
