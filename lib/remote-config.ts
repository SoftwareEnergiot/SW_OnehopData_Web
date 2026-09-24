// Remote configuration of OneHop devices: the JSON the dashboard edits, the
// rules the firmware applies to it, and the plain-text file the device actually
// downloads from GET /api/config.
//
// Framework-free and shared by the editor (live validation and preview) and by
// the server (which re-validates every save and never trusts the client). The
// rules below mirror the firmware's: a file the firmware would reject must never
// be saved, because the device can only report the rejection on its next
// payload.

/** Config file versions the editor can produce. Only v0 exists so far. */
export const CONFIG_VERSIONS = ["v0"] as const;
export type ConfigVersion = (typeof CONFIG_VERSIONS)[number];

/** The seven keys of a v0 config, in the order their lines appear in the file. */
export const CONFIG_V0_KEYS = [
  "reporting_url",
  "reporting_path",
  "polling_url",
  "polling_path",
  "apn",
  "reporting_interval_ms",
  "polling_interval_ms",
] as const;

export type ConfigV0Key = (typeof CONFIG_V0_KEYS)[number];

export interface RemoteConfigV0 {
  reporting_url: string;
  reporting_path: string;
  polling_url: string;
  polling_path: string;
  apn: string;
  reporting_interval_ms: number;
  polling_interval_ms: number;
}

/**
 * What the editor starts from for a device with no saved config. It only fills
 * the editor: it is never served. A device without a saved config gets 204 and
 * keeps its own.
 */
export const CONFIG_V0_TEMPLATE: RemoteConfigV0 = {
  reporting_url: "onehop-data.vercel.app",
  reporting_path: "/api/payloads",
  polling_url: "onehop-data.vercel.app",
  polling_path: "/api/config",
  apn: "auto",
  reporting_interval_ms: 600000,
  polling_interval_ms: 21600000,
};

/** The path this application serves device configs on. */
export const CONFIG_POLLING_PATH = "/api/config";

export interface IntervalLimits {
  reporting: { min: number; max: number };
  polling: { min: number; max: number };
}

/** Release firmware: reporting 1 min – 6 h, polling 3 h – 24 h. */
export const PRODUCTION_INTERVAL_LIMITS: IntervalLimits = {
  reporting: { min: 60_000, max: 21_600_000 },
  polling: { min: 10_800_000, max: 86_400_000 },
};

/** Debug firmware on the bench: both intervals 1 s – 24 h. */
export const LAB_INTERVAL_LIMITS: IntervalLimits = {
  reporting: { min: 1_000, max: 86_400_000 },
  polling: { min: 1_000, max: 86_400_000 },
};

export function intervalLimits(labLimits: boolean): IntervalLimits {
  return labLimits ? LAB_INTERVAL_LIMITS : PRODUCTION_INTERVAL_LIMITS;
}

/** Largest file the firmware accepts, in bytes. */
export const MAX_CONFIG_FILE_BYTES = 994;

/* ------------------------------------------------------------------- CRC-32 */

// CRC-32/ISO-HDLC (zlib's crc32): reflected polynomial 0xEDB88320, initial
// value and final XOR 0xFFFFFFFF. Implemented here rather than taken from
// node:zlib so the browser preview computes exactly what the server stores.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A CRC as the file's last line carries it: 8 uppercase hex digits. */
export function formatCrc32(crc: number): string {
  return (crc >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

/** The numeric value of a stored "2442F46C", for comparing with a payload's uint32. */
export function parseCrc32(hex: string | null | undefined): number | null {
  if (!hex || !/^[0-9A-Fa-f]{8}$/.test(hex)) return null;
  return parseInt(hex, 16) >>> 0;
}

/* --------------------------------------------------------------- validation */

export interface ConfigFieldError {
  /** The offending key, or null for an error about the object as a whole. */
  field: string | null;
  message: string;
}

export type ConfigValidation =
  | { ok: true; config: RemoteConfigV0 }
  | { ok: false; errors: ConfigFieldError[] };

const HOST_RE = /^[A-Za-z0-9.-]{1,255}$/;
const APN_RE = /^[A-Za-z0-9.-]{1,63}$/;
// Printable ASCII without the space: 0x21–0x7E.
const PATH_RE = /^\/[\x21-\x7E]{0,126}$/;

function hostError(value: string): string | null {
  if (value.length === 0) return "must not be empty";
  if (value.length > 255) return "must be at most 255 characters";
  if (value.includes("://")) return "is a host name only: drop the scheme (https://)";
  if (value.includes("/")) return "is a host name only: move the path to its own field";
  if (value.includes(":")) return "is a host name only: no port (it is always 443, HTTPS)";
  if (!HOST_RE.test(value)) return "may only contain letters, digits, '.' and '-'";
  return null;
}

function pathError(value: string): string | null {
  if (value.length === 0) return "must not be empty";
  if (value.length > 127) return "must be at most 127 characters";
  if (!value.startsWith("/")) return "must start with '/'";
  if (value.includes("://")) return "must not contain '://'";
  if (value.includes("#")) return "must not contain '#'";
  if (!PATH_RE.test(value)) return "must be printable ASCII with no spaces";
  return null;
}

function apnError(value: string): string | null {
  if (value.length === 0) return 'must not be empty (use "auto" for the automatic APN)';
  if (value === "auto") return null;
  if (value.length > 63) return "must be at most 63 characters";
  if (!APN_RE.test(value)) return "may only contain letters, digits, '.' and '-'";
  return null;
}

function intervalError(
  value: number,
  { min, max }: { min: number; max: number },
): string | null {
  if (!Number.isSafeInteger(value)) return "must be a whole number";
  if (value < min || value > max) {
    return `must be between ${min} and ${max} (${formatDuration(min)} – ${formatDuration(max)})`;
  }
  return null;
}

/**
 * Validate an edited v0 config exactly as the firmware will.
 *
 * Exactly the seven keys, no more and no fewer, none null; hosts, paths and APN
 * restricted to what the firmware accepts; intervals within the release limits,
 * or the lab limits when `labLimits` is set; and the resulting file within the
 * firmware's size limit.
 */
export function validateConfigV0(
  input: unknown,
  { labLimits }: { labLimits: boolean },
): ConfigValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      errors: [{ field: null, message: "The config must be a JSON object." }],
    };
  }

  const record = input as Record<string, unknown>;
  const errors: ConfigFieldError[] = [];
  const allowed = new Set<string>(CONFIG_V0_KEYS);

  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      errors.push({ field: key, message: "is not a config key; remove it" });
    }
  }

  const limits = intervalLimits(labLimits);

  for (const key of CONFIG_V0_KEYS) {
    if (!(key in record)) {
      errors.push({ field: key, message: "is missing" });
      continue;
    }
    const value = record[key];
    if (value === null) {
      errors.push({ field: key, message: "must not be null" });
      continue;
    }

    let error: string | null;
    switch (key) {
      case "reporting_url":
      case "polling_url":
        error = typeof value === "string" ? hostError(value) : "must be a string";
        break;
      case "reporting_path":
      case "polling_path":
        error = typeof value === "string" ? pathError(value) : "must be a string";
        break;
      case "apn":
        error = typeof value === "string" ? apnError(value) : "must be a string";
        break;
      case "reporting_interval_ms":
        error =
          typeof value === "number"
            ? intervalError(value, limits.reporting)
            : "must be a number, not a string";
        break;
      case "polling_interval_ms":
        error =
          typeof value === "number"
            ? intervalError(value, limits.polling)
            : "must be a number, not a string";
        break;
    }
    if (error) errors.push({ field: key, message: error });
  }

  if (errors.length > 0) return { ok: false, errors };

  const config = Object.fromEntries(
    CONFIG_V0_KEYS.map((key) => [key, record[key]]),
  ) as unknown as RemoteConfigV0;

  const { bytes } = buildConfigFileV0(config);
  if (bytes.length > MAX_CONFIG_FILE_BYTES) {
    return {
      ok: false,
      errors: [
        {
          field: null,
          message: `The file would be ${bytes.length} bytes; the firmware accepts at most ${MAX_CONFIG_FILE_BYTES}.`,
        },
      ],
    };
  }

  return { ok: true, config };
}

/**
 * Parse the editor's text. A syntax error is reported as a single whole-object
 * error, with the parser's own message.
 */
export function parseConfigJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Invalid JSON",
    };
  }
}

/* --------------------------------------------------------------------- file */

export interface ConfigFile {
  /** The exact file the device downloads: ASCII, LF line endings, trailing LF. */
  text: string;
  /** The same file as bytes — what GET /api/config sends. */
  bytes: Uint8Array;
  /** CRC-32 of lines 1–9, the LF closing line 9 included. */
  crc32: number;
  /** `crc32` as line 10 spells it. */
  crc32Hex: string;
}

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/**
 * Build the v0 file for an already-validated config.
 *
 *   1 version "0" · 2 reporting_url · 3 reporting_path · 4 polling_url
 *   5 polling_path · 6 apn · 7 api_key (always empty: "do not change the key")
 *   8 reporting_interval_ms · 9 polling_interval_ms · 10 CRC32
 *
 * Lines end in LF, never CRLF. Integers are plain decimal. The CRC covers every
 * byte of lines 1–9 including the LF that closes line 9, and the file ends with
 * a LF after the CRC.
 */
export function buildConfigFileV0(config: RemoteConfigV0): ConfigFile {
  const body = [
    "0",
    config.reporting_url,
    config.reporting_path,
    config.polling_url,
    config.polling_path,
    config.apn,
    "", // api_key: key rotation is not done from here
    String(config.reporting_interval_ms),
    String(config.polling_interval_ms),
  ]
    .map((line) => `${line}\n`)
    .join("");

  const crc = crc32(asciiBytes(body));
  const crc32Hex = formatCrc32(crc);
  const text = `${body}${crc32Hex}\n`;
  return { text, bytes: asciiBytes(text), crc32: crc, crc32Hex };
}

/**
 * Warnings about where the device will poll from now on. Not errors — pointing
 * a device elsewhere can be intentional — but a wrong value leaves the device
 * without polling until it reverts, so the editor says so.
 */
export function pollingTargetWarnings(
  config: Pick<RemoteConfigV0, "polling_url" | "polling_path">,
  appHostname: string,
): string[] {
  const warnings: string[] = [];
  if (config.polling_url.toLowerCase() !== appHostname.toLowerCase()) {
    warnings.push(
      `polling_url "${config.polling_url}" is not this application (${appHostname}).`,
    );
  }
  if (config.polling_path !== CONFIG_POLLING_PATH) {
    warnings.push(
      `polling_path "${config.polling_path}" is not ${CONFIG_POLLING_PATH}, where this application serves configs.`,
    );
  }
  return warnings;
}

/* ------------------------------------------------------ device-side status */

/** `last_poll_status` of a V1 payload: what the device's last poll did. */
export const POLL_STATUS_MEANINGS: Record<number, string> = {
  0: "no poll since boot",
  1: "OK, nothing to do (204 or file identical to the active one)",
  2: "file applied, on trial",
  3: "no answer from the server (attach, DNS, TLS, timeout)",
  4: "HTTP 401/403",
  5: "other unusable answer (another non-2xx, body > 994 B)",
  6: "file rejected by format (version, lines, CRC, field)",
  7: "file rejected by validation (e.g. interval out of range)",
  8: "file reverted after failing its trial; blocked until reboot",
  9: "ignored: another file was on trial",
};

export function describePollStatus(value: number): string {
  return POLL_STATUS_MEANINGS[value] ?? "value not defined";
}

/** Poll results that mean the device is not getting the saved config. */
export function isPollStatusProblem(value: number): boolean {
  return value >= 3 && value <= 8;
}

export type ConfigState = "applied" | "pending" | "none";

/**
 * Where a device stands against its saved config.
 *
 * - `none`: nothing saved — the device keeps (and gets 204 for) its own config.
 * - `applied`: the last payload's `config_crc32` is the saved file's CRC.
 * - `pending`: a config is saved and the device does not run it (yet, or any
 *   more: a file that fails its trial is reverted, status 8).
 */
export function deriveConfigState(
  savedCrc32Hex: string | null | undefined,
  lastPayloadCrc32: number | null | undefined,
): ConfigState {
  const saved = parseCrc32(savedCrc32Hex);
  if (saved === null) return "none";
  if (lastPayloadCrc32 != null && lastPayloadCrc32 >>> 0 === saved) {
    return "applied";
  }
  return "pending";
}

/* ------------------------------------------------------------------ helpers */

/** "10 min", "6 h", "1.5 s" — for the interval limits and the save prompt. */
export function formatDuration(ms: number): string {
  const units: [number, string][] = [
    [3_600_000, "h"],
    [60_000, "min"],
    [1_000, "s"],
  ];
  for (const [size, unit] of units) {
    if (ms >= size) {
      const value = ms / size;
      return `${Number.isInteger(value) ? value : value.toFixed(1)} ${unit}`;
    }
  }
  return `${ms} ms`;
}
