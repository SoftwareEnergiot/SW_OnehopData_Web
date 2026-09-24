import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  CONFIG_V0_TEMPLATE,
  buildConfigFileV0,
  crc32,
  deriveConfigState,
  describePollStatus,
  formatCrc32,
  parseConfigJson,
  pollingTargetWarnings,
  validateConfigV0,
  type RemoteConfigV0,
} from "@/lib/remote-config";

// The firmware's test vector, byte for byte: 105 bytes with the trailing LF.
const VECTOR_V0 =
  "0\n" +
  "onehop-data.vercel.app\n" +
  "/api/payloads\n" +
  "onehop-data.vercel.app\n" +
  "/api/config\n" +
  "auto\n" +
  "\n" +
  "600000\n" +
  "21600000\n" +
  "2442F46C\n";

function fieldsWithErrors(input: unknown, labLimits = false): string[] {
  const result = validateConfigV0(input, { labLimits });
  return result.ok ? [] : result.errors.map((e) => e.field ?? "(object)");
}

describe("buildConfigFileV0", () => {
  it("reproduces the firmware test vector byte for byte", () => {
    const file = buildConfigFileV0(CONFIG_V0_TEMPLATE);
    expect(file.text).toBe(VECTOR_V0);
    expect(file.bytes.length).toBe(105);
    expect(Array.from(file.bytes)).toEqual(Array.from(Buffer.from(VECTOR_V0, "ascii")));
    expect(file.crc32Hex).toBe("2442F46C");
    expect(file.crc32).toBe(0x2442f46c);
  });

  it("reproduces the lab-limits vector", () => {
    const file = buildConfigFileV0({
      ...CONFIG_V0_TEMPLATE,
      reporting_interval_ms: 120000,
      polling_interval_ms: 180000,
    });
    expect(file.crc32Hex).toBe("D135B846");
    expect(file.text.endsWith("120000\n180000\nD135B846\n")).toBe(true);
  });

  it("uses LF only, no CR, no BOM, and 10 lines", () => {
    const { bytes, text } = buildConfigFileV0(CONFIG_V0_TEMPLATE);
    expect(bytes.includes(0x0d)).toBe(false);
    expect(bytes[0]).toBe(0x30); // "0", not a BOM
    expect(text.split("\n")).toHaveLength(11); // 10 lines + the empty tail
    expect(text.split("\n")[6]).toBe(""); // api_key, always empty
  });

  it("computes the CRC over lines 1-9 including the LF closing line 9", () => {
    const { text, crc32: crc } = buildConfigFileV0(CONFIG_V0_TEMPLATE);
    const body = text.slice(0, text.lastIndexOf("2442F46C"));
    expect(body.endsWith("21600000\n")).toBe(true);
    expect(crc).toBe(zlibCrc32(Buffer.from(body, "ascii")));
  });
});

describe("crc32", () => {
  it("is CRC-32/ISO-HDLC (zlib)", () => {
    // The standard check value.
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
    expect(formatCrc32(0x1a)).toBe("0000001A");
  });
});

describe("validateConfigV0", () => {
  it("accepts the template", () => {
    const result = validateConfigV0(CONFIG_V0_TEMPLATE, { labLimits: false });
    expect(result.ok).toBe(true);
  });

  it("requires exactly the seven keys, none null", () => {
    const { apn: _apn, ...missing } = CONFIG_V0_TEMPLATE;
    void _apn;
    expect(fieldsWithErrors(missing)).toEqual(["apn"]);
    expect(fieldsWithErrors({ ...CONFIG_V0_TEMPLATE, api_key: "x" })).toEqual(["api_key"]);
    expect(fieldsWithErrors({ ...CONFIG_V0_TEMPLATE, apn: null })).toEqual(["apn"]);
    expect(fieldsWithErrors([])).toEqual(["(object)"]);
    expect(fieldsWithErrors(null)).toEqual(["(object)"]);
  });

  it("takes host names without scheme, port or path", () => {
    for (const bad of [
      "https://onehop-data.vercel.app",
      "onehop-data.vercel.app:443",
      "onehop-data.vercel.app/api",
      "",
      "under_score.example",
      "a".repeat(256),
    ]) {
      expect(fieldsWithErrors({ ...CONFIG_V0_TEMPLATE, reporting_url: bad })).toEqual([
        "reporting_url",
      ]);
    }
    expect(fieldsWithErrors({ ...CONFIG_V0_TEMPLATE, polling_url: "a".repeat(255) })).toEqual([]);
  });

  it("takes paths of 1-127 printable characters starting with /", () => {
    for (const bad of ["", "api/config", "/api config", "/api#x", "/x://y", "/é", "/" + "a".repeat(127)]) {
      expect(fieldsWithErrors({ ...CONFIG_V0_TEMPLATE, polling_path: bad })).toEqual([
        "polling_path",
      ]);
    }
    expect(fieldsWithErrors({ ...CONFIG_V0_TEMPLATE, polling_path: "/" })).toEqual([]);
    expect(
      fieldsWithErrors({ ...CONFIG_V0_TEMPLATE, polling_path: "/" + "a".repeat(126) }),
    ).toEqual([]);
    expect(fieldsWithErrors({ ...CONFIG_V0_TEMPLATE, polling_path: "/a?b=c&d" })).toEqual([]);
  });

  it("takes auto or an APN of 1-63 characters", () => {
    expect(fieldsWithErrors({ ...CONFIG_V0_TEMPLATE, apn: "iot.1nce.net" })).toEqual([]);
    expect(fieldsWithErrors({ ...CONFIG_V0_TEMPLATE, apn: "" })).toEqual(["apn"]);
    expect(fieldsWithErrors({ ...CONFIG_V0_TEMPLATE, apn: "a b" })).toEqual(["apn"]);
    expect(fieldsWithErrors({ ...CONFIG_V0_TEMPLATE, apn: "a".repeat(64) })).toEqual(["apn"]);
  });

  it("enforces the release interval limits", () => {
    const at = (reporting: unknown, polling: unknown) =>
      fieldsWithErrors({
        ...CONFIG_V0_TEMPLATE,
        reporting_interval_ms: reporting,
        polling_interval_ms: polling,
      });
    expect(at(60000, 10800000)).toEqual([]);
    expect(at(21600000, 86400000)).toEqual([]);
    expect(at(59999, 10799999)).toEqual(["reporting_interval_ms", "polling_interval_ms"]);
    expect(at(21600001, 86400001)).toEqual(["reporting_interval_ms", "polling_interval_ms"]);
    expect(at(600000.5, "21600000")).toEqual(["reporting_interval_ms", "polling_interval_ms"]);
  });

  it("relaxes both intervals to 1 s - 24 h with lab limits", () => {
    const lab: RemoteConfigV0 = {
      ...CONFIG_V0_TEMPLATE,
      reporting_interval_ms: 120000,
      polling_interval_ms: 180000,
    };
    expect(fieldsWithErrors(lab, false)).toEqual(["polling_interval_ms"]);
    expect(fieldsWithErrors(lab, true)).toEqual([]);
    expect(
      fieldsWithErrors({ ...lab, reporting_interval_ms: 999, polling_interval_ms: 86400001 }, true),
    ).toEqual(["reporting_interval_ms", "polling_interval_ms"]);
  });

  it("returns only the seven keys, in file order", () => {
    const result = validateConfigV0(
      JSON.parse(JSON.stringify({ ...CONFIG_V0_TEMPLATE })),
      { labLimits: false },
    );
    expect(result.ok && Object.keys(result.config)).toEqual([
      "reporting_url",
      "reporting_path",
      "polling_url",
      "polling_path",
      "apn",
      "reporting_interval_ms",
      "polling_interval_ms",
    ]);
  });
});

describe("parseConfigJson", () => {
  it("reports syntax errors instead of throwing", () => {
    expect(parseConfigJson("{").ok).toBe(false);
    expect(parseConfigJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });
});

describe("pollingTargetWarnings", () => {
  it("warns when the device would poll somewhere else", () => {
    expect(pollingTargetWarnings(CONFIG_V0_TEMPLATE, "onehop-data.vercel.app")).toEqual([]);
    expect(pollingTargetWarnings(CONFIG_V0_TEMPLATE, "localhost")).toHaveLength(1);
    expect(
      pollingTargetWarnings(
        { polling_url: "onehop-data.vercel.app", polling_path: "/api/payloads" },
        "onehop-data.vercel.app",
      ),
    ).toHaveLength(1);
  });
});

describe("deriveConfigState", () => {
  it("compares the last payload's CRC with the saved file's", () => {
    expect(deriveConfigState(null, 0x2442f46c)).toBe("none");
    expect(deriveConfigState("2442F46C", 0x2442f46c)).toBe("applied");
    expect(deriveConfigState("2442F46C", 0xd135b846)).toBe("pending");
    expect(deriveConfigState("2442F46C", null)).toBe("pending");
  });
});

describe("describePollStatus", () => {
  it("names every defined status", () => {
    expect(describePollStatus(0)).toBe("no poll since boot");
    expect(describePollStatus(8)).toMatch(/reverted/);
    expect(describePollStatus(10)).toBe("value not defined");
  });
});
