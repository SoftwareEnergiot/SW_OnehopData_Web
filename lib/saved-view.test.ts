import { describe, expect, it } from "vitest";

import {
  clearSavedView,
  readSavedView,
  savedViewKey,
  writeSavedView,
  type ViewStorage,
} from "@/lib/saved-view";
import {
  BUILT_IN_CHARTS,
  DEVELOPMENT_SCHEMA,
  PAYLOAD_SCHEMAS,
  REE_SCHEMA,
} from "@/lib/payload-schemas";
import { V1_CONTEXT_FIELDS } from "@/lib/payload-decoder";

function memoryStorage(): ViewStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe("saved views", () => {
  const key = savedViewKey("development", "columns");
  const available = ["created_at", "device_uid", "error_mask", "reporting_counter"];

  it("keys the view by environment schema and kind", () => {
    expect(key).toBe("onehop.view.development.columns");
    expect(savedViewKey("ree", "charts")).toBe("onehop.view.ree.charts");
  });

  it("reads back what was saved, in the offered order", () => {
    const storage = memoryStorage();
    writeSavedView(storage, key, ["reporting_counter", "created_at"]);
    expect(readSavedView(storage, key, available)).toEqual(["created_at", "reporting_counter"]);
  });

  it("drops keys no longer offered, and honours an empty view", () => {
    const storage = memoryStorage();
    writeSavedView(storage, key, ["gone", "device_uid"]);
    expect(readSavedView(storage, key, available)).toEqual(["device_uid"]);
    writeSavedView(storage, key, []);
    expect(readSavedView(storage, key, available)).toEqual([]);
  });

  it("falls back (null) with nothing saved, bad data or no storage", () => {
    const storage = memoryStorage();
    expect(readSavedView(storage, key, available)).toBeNull();
    storage.setItem(key, "{not json");
    expect(readSavedView(storage, key, available)).toBeNull();
    storage.setItem(key, '{"a":1}');
    expect(readSavedView(storage, key, available)).toBeNull();
    expect(readSavedView(null, key, available)).toBeNull();
    expect(writeSavedView(null, key, available)).toBe(false);
  });

  it("forgets a view on reset", () => {
    const storage = memoryStorage();
    writeSavedView(storage, key, ["device_uid"]);
    clearSavedView(storage, key);
    expect(readSavedView(storage, key, available)).toBeNull();
  });

  it("survives a storage that throws", () => {
    const hostile: ViewStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readSavedView(hostile, key, available)).toBeNull();
    expect(writeSavedView(hostile, key, available)).toBe(false);
    expect(() => clearSavedView(hostile, key)).not.toThrow();
  });
});

describe("default views", () => {
  it("shows received, device UID, error mask and counter in both environments", () => {
    for (const schema of Object.values(PAYLOAD_SCHEMAS)) {
      expect(schema.listColumns).toEqual([
        "created_at",
        "device_uid",
        "error_mask",
        "reporting_counter",
      ]);
      const keys = new Set(schema.fields.map((field) => field.key));
      for (const column of schema.listColumns) expect(keys.has(column), column).toBe(true);
    }
  });

  it("charts the battery state of charge only, in both environments", () => {
    for (const schema of Object.values(PAYLOAD_SCHEMAS)) {
      expect(schema.defaultCharts).toEqual(["battery_soc"]);
      expect(schema.charts).toContain("battery_soc");
    }
  });

  it("offers only charts it can draw: built-in ones or chartable fields", () => {
    for (const schema of Object.values(PAYLOAD_SCHEMAS)) {
      for (const key of schema.charts) {
        const field = schema.fields.find((f) => f.key === key);
        expect(key in BUILT_IN_CHARTS || field?.chartable === true, key).toBe(true);
      }
    }
    expect(DEVELOPMENT_SCHEMA.charts).toContain("payload_size");
    expect(REE_SCHEMA.charts).not.toContain("payload_size");
  });
});

describe("Development columns", () => {
  it("declares a column for every V1 field, named like REE's", () => {
    const dev = new Set(DEVELOPMENT_SCHEMA.fields.map((field) => field.key));
    for (const { key } of V1_CONTEXT_FIELDS) expect(dev.has(key), key).toBe(true);
    for (const field of REE_SCHEMA.fields) {
      if (field.key === "id") continue;
      expect(dev.has(field.key), field.key).toBe(true);
    }
  });

  it("selects every summary column from columns the table declares", () => {
    const known = new Set(DEVELOPMENT_SCHEMA.fields.map((field) => field.key));
    for (const tier of DEVELOPMENT_SCHEMA.summaryColumnTiers) {
      for (const column of tier.split(",")) expect(known.has(column), column).toBe(true);
    }
  });

  it("falls back to the V1 columns, then the scripts/004 ones, then the original ones", () => {
    const [power, full, only004, base] = DEVELOPMENT_SCHEMA.summaryColumnTiers.map((t) =>
      t.split(","),
    );
    expect(power).toContain("vin_mv");
    expect(full).not.toContain("vin_mv");
    expect(full).toContain("ambient_temperature");
    expect(full).toContain("tx_failed");
    expect(only004).toContain("battery_soc");
    expect(only004).not.toContain("tx_failed");
    expect(base).not.toContain("battery_soc");
  });
});
