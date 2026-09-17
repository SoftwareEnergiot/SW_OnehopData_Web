// Reusable decoder for the Onehop binary uplink payloads.
//
// The version byte at offset 0 selects the format:
//
//   V0 ("Payload Encode - LoraWAN V0")
//     Header  :  2 bytes       -> payload id/version (uint8), sample count (uint8)
//     Samples : 28 * N bytes   -> N consecutive 28-byte samples
//     Context :  8 bytes       -> error mask (uint32), reporting counter (uint32)
//     Total   = 10 + 28*N bytes
//
//   V1 (Confluence "V1", space WSNFD) — current revision
//     Header  : 14 bytes       -> version (uint8), device UID (uint8[8]),
//                                 sample count (uint8), reporting counter (uint32)
//     Samples : 36 * N bytes   -> N consecutive 36-byte samples, each starting
//                                 with its read time (N is 1 in practice)
//     Context : 43 bytes       -> error mask plus battery / modem diagnostics
//     Total   = 93 bytes for N = 1
//
// The V1 document has been revised twice WITHOUT changing the version byte:
// 82 bytes (32-byte sample, 36-byte context), then 86 bytes (40-byte context),
// then the current 93 bytes. Payloads of the earlier revisions are already in
// the database and may still be sent by devices on older firmware, so all three
// are decoded. Within V1 the revision is told apart by total length, which is
// unambiguous: 50 + 32a, 54 + 32b and 57 + 36c never coincide for any sample
// counts (each pairwise difference would have to be odd or a non-multiple).
//
// In every format multi-byte integers are little-endian and int8/int16 fields
// are two's complement. The device UID is a raw byte array sent in canonical
// order, not an integer, so it is never byte-swapped.
//
// The protocol documents are the source of truth; this module mirrors them and
// is pure (no Node Buffer / DOM dependency) so it runs on the server, in the
// browser, and under Vitest unchanged.

import {
  resolveErrorMask,
  formatErrorMask,
  type ResolvedError,
} from "@/lib/payload-errors";

// --- V0 geometry -----------------------------------------------------------
export const V0_HEADER_SIZE = 2;
export const V0_SAMPLE_SIZE = 28;
export const V0_CONTEXT_SIZE = 8;

// --- V1 geometry (current revision) ---------------------------------------
export const V1_HEADER_SIZE = 14;
export const V1_SAMPLE_SIZE = 36;
export const V1_CONTEXT_SIZE = 43;

// Back-compat aliases: these names date from when V0 was the only format and
// are still imported by existing callers and tests.
export const HEADER_SIZE = V0_HEADER_SIZE;
export const SAMPLE_SIZE = V0_SAMPLE_SIZE;
export const CONTEXT_SIZE = V0_CONTEXT_SIZE;

// Versions this decoder understands.
export const SUPPORTED_VERSIONS = [0, 1] as const;

export type PayloadInput = Buffer | ArrayBuffer | Uint8Array;

export type DecodeErrorCode =
  | "EMPTY_PAYLOAD"
  | "INVALID_LENGTH"
  | "UNSUPPORTED_VERSION"
  | "SAMPLE_COUNT_MISMATCH"
  | "MALFORMED_BODY";

// Thrown for every validation failure so callers can map a stable `code` to an
// HTTP status / UI message instead of string-matching.
export class PayloadDecodeError extends Error {
  readonly code: DecodeErrorCode;

  constructor(code: DecodeErrorCode, message: string) {
    super(message);
    this.name = "PayloadDecodeError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

export type FieldType = "int8" | "uint8" | "int16" | "uint16" | "uint32";

// One numeric channel inside a sample, keyed identically to the decoding
// example in the corresponding protocol document.
export interface SampleFieldDef {
  key: string;
  label: string;
  offset: number; // byte offset within the sample
  type: FieldType;
  factor: number; // scaling divisor (raw / factor = engineering value)
  unit: string;
}

// One field inside the batch context.
export interface ContextFieldDef {
  key: string;
  label: string;
  offset: number; // byte offset within the context section
  type: FieldType;
  unit: string;
}

export const V0_SAMPLE_FIELDS: SampleFieldDef[] = [
  { key: "temp1_x10",    label: "Termopar 1",           offset: 0,  type: "int16",  factor: 10, unit: "C" },
  { key: "temp2_x10",    label: "Termopar 2",           offset: 2,  type: "int16",  factor: 10, unit: "C" },
  { key: "temp3_x10",    label: "Termopar 3 / CurrSens1", offset: 4, type: "int16", factor: 10, unit: "C" },
  { key: "amb_temp_x10", label: "Ambient temperature",  offset: 6,  type: "int16",  factor: 10, unit: "C" },
  { key: "amb_hum_x10",  label: "Ambient humidity",     offset: 8,  type: "uint16", factor: 10, unit: "%" },
  { key: "int_temp_x10", label: "Internal temp / CurrSens2", offset: 10, type: "int16", factor: 10, unit: "C" },
  { key: "int_hum_x10",  label: "Internal humidity",    offset: 12, type: "uint16", factor: 10, unit: "%" },
  { key: "lux",          label: "Luminosity",           offset: 14, type: "uint32", factor: 1,  unit: "lux" },
  { key: "accel_x",      label: "Acceleration x",       offset: 18, type: "int16",  factor: 1,  unit: "mg" },
  { key: "accel_y",      label: "Acceleration y",       offset: 20, type: "int16",  factor: 1,  unit: "mg" },
  { key: "accel_z",      label: "Acceleration z",       offset: 22, type: "int16",  factor: 1,  unit: "mg" },
  { key: "current1",     label: "Current 1",            offset: 24, type: "uint16", factor: 1,  unit: "uT" },
  { key: "current2",     label: "Current 2",            offset: 26, type: "uint16", factor: 1,  unit: "uT" },
];

// The 16 channels of a 36-byte V1 sample (current revision). Field ids 1-16 in
// the V1 document. `time` comes first and shifts every measurement by 4 bytes
// relative to the earlier revisions.
export const V1_SAMPLE_FIELDS: SampleFieldDef[] = [
  { key: "time",                 label: "Time",                           offset: 0,  type: "uint32", factor: 1,  unit: "s" },
  { key: "thermocouple_1",       label: "Thermocouple 1",                 offset: 4,  type: "int16",  factor: 10, unit: "C" },
  { key: "thermocouple_2",       label: "Thermocouple 2",                 offset: 6,  type: "int16",  factor: 10, unit: "C" },
  { key: "current_1_int_temp",   label: "Current 1 internal temperature", offset: 8,  type: "int16",  factor: 10, unit: "C" },
  { key: "current_2_int_temp",   label: "Current 2 internal temperature", offset: 10, type: "int16",  factor: 10, unit: "C" },
  { key: "ambient_temperature",  label: "Ambient temperature",            offset: 12, type: "int16",  factor: 10, unit: "C" },
  { key: "ambient_humidity",     label: "Ambient humidity",               offset: 14, type: "uint16", factor: 10, unit: "%RH" },
  { key: "internal_temperature", label: "Internal temperature",           offset: 16, type: "int16",  factor: 10, unit: "C" },
  { key: "internal_humidity",    label: "Internal humidity",              offset: 18, type: "uint16", factor: 10, unit: "%RH" },
  { key: "luminosity",           label: "Luminosity",                     offset: 20, type: "uint32", factor: 1,  unit: "lux" },
  { key: "acceleration_x",       label: "Acceleration X",                 offset: 24, type: "int16",  factor: 1,  unit: "mg" },
  { key: "acceleration_y",       label: "Acceleration Y",                 offset: 26, type: "int16",  factor: 1,  unit: "mg" },
  { key: "acceleration_z",       label: "Acceleration Z",                 offset: 28, type: "int16",  factor: 1,  unit: "mg" },
  { key: "magnetic_field_1",     label: "Magnetic field 1",               offset: 30, type: "uint16", factor: 1,  unit: "uT" },
  { key: "magnetic_field_2",     label: "Magnetic field 2",               offset: 32, type: "uint16", factor: 1,  unit: "uT" },
  { key: "valid_sample_mask",    label: "Valid sample mask",              offset: 34, type: "uint16", factor: 1,  unit: "" },
];

// The 17 fields of the fixed 43-byte V1 context (current revision).
//
// Fields 8-14 are refreshed by the modem only while it registers on the
// network, so they describe the *previous* transmission cycle, not the instant
// the report was built.
//
// Fields 15 and 16 are counters since boot: read them as a delta between
// consecutive reports of the same boot session. boot_count is NOT one of them
// any more — it is a lifetime count, never cleared.
export const V1_CONTEXT_FIELDS: ContextFieldDef[] = [
  { key: "error_mask",               label: "Error mask",               offset: 0,  type: "uint32", unit: "" },
  { key: "last_communication_error", label: "Last communication error", offset: 4,  type: "uint8",  unit: "" },
  { key: "battery_soc",              label: "Battery SoC",              offset: 5,  type: "uint8",  unit: "%" },
  { key: "battery_voltage",          label: "Battery voltage",          offset: 6,  type: "uint16", unit: "mV" },
  { key: "config_crc32",             label: "Config CRC32",             offset: 8,  type: "uint32", unit: "" },
  { key: "boot_count",               label: "Boot count",               offset: 12, type: "uint32", unit: "" },
  { key: "reset_source",             label: "Reset source",             offset: 16, type: "uint32", unit: "" },
  { key: "rsrp",                     label: "RSRP",                     offset: 20, type: "int16",  unit: "dBm" },
  { key: "snr",                      label: "SNR",                      offset: 22, type: "int8",   unit: "dB" },
  { key: "status_flags",             label: "Status flags",             offset: 23, type: "uint8",  unit: "" },
  { key: "tau",                      label: "TAU",                      offset: 24, type: "uint32", unit: "s" },
  { key: "active_time",              label: "Active time",              offset: 28, type: "uint16", unit: "s" },
  { key: "last_attach_duration_ms",  label: "Last attach duration",     offset: 30, type: "uint32", unit: "ms" },
  { key: "last_tx_duration_ms",      label: "Last TX duration",         offset: 34, type: "uint32", unit: "ms" },
  { key: "reporting_lost_counter",   label: "Reporting lost counter",   offset: 38, type: "uint16", unit: "" },
  { key: "tx_failed",                label: "Tx failed",                offset: 40, type: "uint16", unit: "" },
  { key: "last_poll_status",         label: "Last poll status",         offset: 42, type: "uint8",  unit: "" },
];

// --- Earlier V1 revisions, kept so stored payloads and older firmware decode --

// The 32-byte sample of the 82- and 86-byte revisions: no time field.
export const V1_LEGACY_SAMPLE_FIELDS: SampleFieldDef[] = V1_SAMPLE_FIELDS.filter(
  (f) => f.key !== "time",
).map((f) => ({ ...f, offset: f.offset - 4 }));

// The 36-byte context of the original 82-byte revision.
const V1_REV_82_CONTEXT_FIELDS: ContextFieldDef[] = [
  { key: "error_mask",               label: "Error mask",               offset: 0,  type: "uint32", unit: "" },
  { key: "last_communication_error", label: "Last communication error", offset: 4,  type: "uint8",  unit: "" },
  { key: "battery_soc",              label: "Battery SoC",              offset: 5,  type: "uint8",  unit: "%" },
  { key: "battery_voltage",          label: "Battery voltage",          offset: 6,  type: "uint16", unit: "mV" },
  { key: "config_version",           label: "Config version",           offset: 8,  type: "uint32", unit: "" },
  { key: "boot_count",               label: "Boot count",               offset: 12, type: "uint16", unit: "" },
  { key: "reset_source",             label: "Reset source",             offset: 14, type: "uint32", unit: "" },
  { key: "rsrp",                     label: "RSRP",                     offset: 18, type: "int16",  unit: "dBm" },
  { key: "snr",                      label: "SNR",                      offset: 20, type: "int8",   unit: "dB" },
  { key: "status_flags",             label: "Status flags",             offset: 21, type: "uint8",  unit: "" },
  { key: "tau",                      label: "TAU",                      offset: 22, type: "uint32", unit: "s" },
  { key: "active_time",              label: "Active time",              offset: 26, type: "uint16", unit: "s" },
  { key: "last_attach_duration_ms",  label: "Last attach duration",     offset: 28, type: "uint32", unit: "ms" },
  { key: "last_tx_duration_ms",      label: "Last TX duration",         offset: 32, type: "uint32", unit: "ms" },
];

// The 40-byte context of the 86-byte revision: the 82-byte one plus two counters.
const V1_REV_86_CONTEXT_FIELDS: ContextFieldDef[] = [
  ...V1_REV_82_CONTEXT_FIELDS,
  { key: "reporting_lost_counter",   label: "Reporting lost counter",   offset: 36, type: "uint16", unit: "" },
  { key: "tx_failed",                label: "Tx failed",                offset: 38, type: "uint16", unit: "" },
];

// Kept for callers written against the single-format decoder. New code should
// use layoutOf(decoded) / sampleFieldsFor(version), since the channel set is
// format-specific.
export const SAMPLE_FIELDS = V0_SAMPLE_FIELDS;

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

export interface PayloadLayout {
  /** Stable identifier of this exact wire format, e.g. "v1" or "v1-86". */
  revision: string;
  /** Human-readable name for the UI. */
  label: string;
  version: number;
  headerSize: number;
  sampleSize: number;
  contextSize: number;
  sampleFields: SampleFieldDef[];
  contextFields: ContextFieldDef[];
  /** V1 carries a device UID in the header; V0 does not. */
  hasDeviceUid: boolean;
  /** Set when the format allows exactly one sample count. */
  requiredSampleCount: number | null;
  /** Whether each sample carries its read time (current V1 revision only). */
  hasSampleTime: boolean;
}

export const V0_CONTEXT_FIELDS: ContextFieldDef[] = [
  { key: "error_mask",        label: "Error mask",        offset: 0, type: "uint32", unit: "" },
  { key: "reporting_counter", label: "Reporting counter", offset: 4, type: "uint32", unit: "" },
];

export const V0_LAYOUT: PayloadLayout = {
  revision: "v0",
  label: "V0",
  version: 0,
  headerSize: V0_HEADER_SIZE,
  sampleSize: V0_SAMPLE_SIZE,
  contextSize: V0_CONTEXT_SIZE,
  sampleFields: V0_SAMPLE_FIELDS,
  contextFields: V0_CONTEXT_FIELDS,
  hasDeviceUid: false,
  requiredSampleCount: null,
  hasSampleTime: false,
};

export const V1_LAYOUT: PayloadLayout = {
  revision: "v1",
  label: "V1",
  version: 1,
  headerSize: V1_HEADER_SIZE,
  sampleSize: V1_SAMPLE_SIZE,
  contextSize: V1_CONTEXT_SIZE,
  sampleFields: V1_SAMPLE_FIELDS,
  contextFields: V1_CONTEXT_FIELDS,
  hasDeviceUid: true,
  // The document no longer requires rejecting sample_count != 1: it is 1 in
  // practice, and the per-sample time now makes several samples placeable.
  requiredSampleCount: null,
  hasSampleTime: true,
};

export const V1_REV_86_LAYOUT: PayloadLayout = {
  revision: "v1-86",
  label: "V1 (86-byte revision)",
  version: 1,
  headerSize: V1_HEADER_SIZE,
  sampleSize: 32,
  contextSize: 40,
  sampleFields: V1_LEGACY_SAMPLE_FIELDS,
  contextFields: V1_REV_86_CONTEXT_FIELDS,
  hasDeviceUid: true,
  requiredSampleCount: 1,
  hasSampleTime: false,
};

export const V1_REV_82_LAYOUT: PayloadLayout = {
  revision: "v1-82",
  label: "V1 (82-byte revision)",
  version: 1,
  headerSize: V1_HEADER_SIZE,
  sampleSize: 32,
  contextSize: 36,
  sampleFields: V1_LEGACY_SAMPLE_FIELDS,
  contextFields: V1_REV_82_CONTEXT_FIELDS,
  hasDeviceUid: true,
  requiredSampleCount: 1,
  hasSampleTime: false,
};

// Every layout of a version, current revision first.
const LAYOUTS_BY_VERSION: Record<number, PayloadLayout[]> = {
  0: [V0_LAYOUT],
  1: [V1_LAYOUT, V1_REV_86_LAYOUT, V1_REV_82_LAYOUT],
};

const LAYOUTS_BY_REVISION: Record<string, PayloadLayout> = Object.fromEntries(
  Object.values(LAYOUTS_BY_VERSION)
    .flat()
    .map((layout) => [layout.revision, layout]),
);

// The current layout of each version, keyed by version number.
export const LAYOUTS: Record<number, PayloadLayout> = {
  0: V0_LAYOUT,
  1: V1_LAYOUT,
};

// The current layout of a version, or undefined when the version is unknown.
export function layoutFor(version: number): PayloadLayout | undefined {
  return LAYOUTS[version];
}

// The exact layout a decoded payload was read with.
export function layoutOf(decoded: Pick<DecodedPayload, "layout_revision" | "payload_version">): PayloadLayout {
  return (
    LAYOUTS_BY_REVISION[decoded.layout_revision] ??
    layoutFor(decoded.payload_version) ??
    V0_LAYOUT
  );
}

// Sample channels of a version's current layout, falling back to V0 for unknown
// versions so a caller rendering a legacy stored row never crashes.
export function sampleFieldsFor(version: number): SampleFieldDef[] {
  return (layoutFor(version) ?? V0_LAYOUT).sampleFields;
}

export function contextFieldsFor(version: number): ContextFieldDef[] {
  return (layoutFor(version) ?? V0_LAYOUT).contextFields;
}

function lengthOf(layout: PayloadLayout, sampleCount: number): number {
  return layout.headerSize + layout.sampleSize * sampleCount + layout.contextSize;
}

// Total payload length for a given sample count, in the current layout of the
// version. `version` defaults to 0 for callers written before the format
// became version-dependent.
export function expectedLength(sampleCount: number, version = 0): number {
  return lengthOf(layoutFor(version) ?? V0_LAYOUT, sampleCount);
}

// Pick the layout whose geometry matches this payload: its body tiles the
// sample size exactly and the header's sample count agrees with the length.
// Falls back to the version's current layout, so a malformed payload is
// reported against the format devices are expected to send today.
function resolveLayout(
  version: number,
  byteLength: number,
  headerSampleCount: (layout: PayloadLayout) => number | null,
): PayloadLayout | undefined {
  const candidates = LAYOUTS_BY_VERSION[version];
  if (!candidates) return undefined;
  if (candidates.length === 1) return candidates[0];

  for (const layout of candidates) {
    const body = byteLength - layout.headerSize - layout.contextSize;
    if (body < 0 || body % layout.sampleSize !== 0) continue;
    if (body / layout.sampleSize === headerSampleCount(layout)) return layout;
  }
  return candidates[0];
}

// ---------------------------------------------------------------------------
// Decoded shapes
// ---------------------------------------------------------------------------

// A decoded sample. The channel set depends on the format, so the value is
// keyed by channel name; iterate layoutOf(decoded).sampleFields to walk the
// channels a payload actually has.
export type DecodedSample = Record<string, number>;

// The decoded batch context. error_mask and reporting_counter are always
// present — in V1 the reporting counter lives in the header and is mirrored
// here so every format exposes it in the same place.
export type DecodedContext = {
  error_mask: number;
  reporting_counter: number;
} & Record<string, number>;

export interface DecodedPayload {
  payload_version: number;
  /** The exact wire format the payload was read with ("v0", "v1", "v1-86", "v1-82"). */
  layout_revision: string;
  /** Colon-separated uppercase UID ("00:12:4B:…"), null for V0 payloads. */
  device_uid: string | null;
  sample_count: number;
  samples: DecodedSample[];
  context: DecodedContext;
  /**
   * What each sample's `time` means, from status flags bit 5: true = UTC epoch
   * seconds, false = seconds since boot (no absolute time; use the reception
   * time). Null for formats whose samples carry no time.
   */
  sample_time_utc: boolean | null;
  // Convenience mirrors of the context fields plus the resolved catalog.
  error_mask: number;
  error_mask_hex: string;
  reporting_counter: number;
  errors: ResolvedError[];
}

// A single byte annotated with its section, used by the binary-vs-hex UI.
export type ByteSection = "header" | "sample" | "context";

export interface AnnotatedByte {
  offset: number;
  hex: string; // two lowercase hex chars
  binary: string; // eight bits
  section: ByteSection;
  sampleIndex: number | null; // which sample the byte belongs to (section === "sample")
}

export interface PayloadAnalysis {
  meta: {
    byteLength: number;
    expectedLength: number;
    sampleCount: number;
    version: number;
    /** Layout revision and its label, e.g. "v1-86" / "V1 (86-byte revision)". */
    revision: string;
    revisionLabel: string;
    // Section sizes for this payload's format, so the UI can label the
    // binary/hex legend without re-deriving the layout.
    headerSize: number;
    sampleSize: number;
    contextSize: number;
  };
  hex: string; // continuous, lowercase
  binary: string; // space-separated bytes
  bytes: AnnotatedByte[];
  decoded: DecodedPayload;
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

// Accept Buffer, ArrayBuffer, or Uint8Array and return a Uint8Array view that
// respects any byteOffset/byteLength of the source.
export function toUint8Array(input: PayloadInput): Uint8Array {
  if (input instanceof Uint8Array) {
    return input; // Buffer is a Uint8Array subclass, so this covers it too
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  throw new PayloadDecodeError(
    "MALFORMED_BODY",
    "Unsupported input type: expected Buffer, ArrayBuffer, or Uint8Array.",
  );
}

// ---------------------------------------------------------------------------
// Hex / binary helpers
// ---------------------------------------------------------------------------

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export function bytesToBinary(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    parts.push(bytes[i].toString(2).padStart(8, "0"));
  }
  return parts.join(" ");
}

// Parse a hex string (optionally with "0x", whitespace, or ":" separators)
// into a Uint8Array. Throws MALFORMED_BODY on odd length or invalid chars.
export function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex
    .trim()
    .replace(/^0x/i, "")
    .replace(/[\s:,-]/g, "");

  if (cleaned.length === 0) {
    return new Uint8Array(0);
  }
  if (cleaned.length % 2 !== 0) {
    throw new PayloadDecodeError(
      "MALFORMED_BODY",
      "Hex string must have an even number of characters.",
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
    throw new PayloadDecodeError(
      "MALFORMED_BODY",
      "Hex string contains non-hexadecimal characters.",
    );
  }

  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Format the 8 raw UID bytes the way the protocol document prints them:
// uppercase hex, colon separated, in canonical wire order (byte 0 is the first
// byte of the OUI; never byte-swapped).
export function formatDeviceUid(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(":");
}

/**
 * Normalise a user-typed device UID to the stored "00:12:4B:…" form.
 *
 * Accepts any separator (or none) and any case, so "00124b001a2b3c4d",
 * "00-12-4B-00-1A-2B-3C-4D" and the canonical form all match the same device.
 * Returns null when the input is not exactly 8 bytes of hex.
 */
export function normalizeDeviceUid(input: string): string | null {
  const hex = input.replace(/[^0-9a-fA-F]/g, "");
  if (hex.length !== 16) return null;
  return (hex.match(/../g) as string[]).map((b) => b.toUpperCase()).join(":");
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function readField(view: DataView, at: number, type: FieldType): number {
  switch (type) {
    case "int8":
      return view.getInt8(at);
    case "uint8":
      return view.getUint8(at);
    case "int16":
      return view.getInt16(at, true); // little-endian, two's complement
    case "uint16":
      return view.getUint16(at, true);
    case "uint32":
      return view.getUint32(at, true);
  }
}

function readSample(
  view: DataView,
  base: number,
  fields: SampleFieldDef[],
): DecodedSample {
  const sample: DecodedSample = {};
  for (const field of fields) {
    sample[field.key] = readField(view, base + field.offset, field.type);
  }
  return sample;
}

function readContext(
  view: DataView,
  base: number,
  fields: ContextFieldDef[],
): Record<string, number> {
  const context: Record<string, number> = {};
  for (const field of fields) {
    context[field.key] = readField(view, base + field.offset, field.type);
  }
  return context;
}

// Status flags bit 5: sample times are UTC (set) or seconds since boot (clear).
export const STATUS_FLAG_TIME_UTC = 0x20;

// Decode a raw payload into its structured form. Throws PayloadDecodeError on
// any validation failure (empty, invalid length, unsupported version, sample
// count mismatch, malformed body).
export function decodePayload(input: PayloadInput): DecodedPayload {
  const bytes = toUint8Array(input);

  if (bytes.length === 0) {
    throw new PayloadDecodeError("EMPTY_PAYLOAD", "Payload is empty.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The version byte sits at offset 0 in every format, so it is what selects
  // the family of layouts; the length then selects the revision within it.
  const payloadVersion = view.getUint8(0);
  const layout = resolveLayout(payloadVersion, bytes.length, (candidate) => {
    const at = candidate.hasDeviceUid ? 9 : 1;
    return bytes.length > at ? view.getUint8(at) : null;
  });

  if (!layout) {
    throw new PayloadDecodeError(
      "UNSUPPORTED_VERSION",
      `Unsupported payload version ${payloadVersion}. Supported: ${SUPPORTED_VERSIONS.join(
        ", ",
      )}.`,
    );
  }

  const fixedSize = layout.headerSize + layout.contextSize;
  if (bytes.length < fixedSize) {
    throw new PayloadDecodeError(
      "INVALID_LENGTH",
      `Payload too short for version ${payloadVersion}: ${bytes.length} bytes, need at least ${fixedSize} (header + context).`,
    );
  }

  // --- Header ---
  let deviceUid: string | null = null;
  let sampleCount: number;
  let headerReportingCounter: number | null = null;

  if (layout.hasDeviceUid) {
    // V1: version(1) | device_uid(8) | sample_count(1) | reporting_counter(4)
    deviceUid = formatDeviceUid(bytes.subarray(1, 9));
    sampleCount = view.getUint8(9);
    headerReportingCounter = view.getUint32(10, true);
  } else {
    // V0: version(1) | sample_count(1)
    sampleCount = view.getUint8(1);
  }

  // --- Length / sample count consistency ---
  const bodyLength = bytes.length - fixedSize;
  if (bodyLength % layout.sampleSize !== 0) {
    throw new PayloadDecodeError(
      "INVALID_LENGTH",
      `Payload length ${bytes.length} is not valid for version ${payloadVersion}: the sample region (${bodyLength} bytes) is not a multiple of ${layout.sampleSize}.`,
    );
  }

  const derivedCount = bodyLength / layout.sampleSize;
  if (derivedCount !== sampleCount) {
    throw new PayloadDecodeError(
      "SAMPLE_COUNT_MISMATCH",
      `Header declares ${sampleCount} sample(s) but the payload length implies ${derivedCount}. Expected ${lengthOf(
        layout,
        sampleCount,
      )} bytes, got ${bytes.length}.`,
    );
  }

  // The earlier V1 revisions required exactly one sample, even when the header
  // and the length agreed with each other.
  if (
    layout.requiredSampleCount !== null &&
    sampleCount !== layout.requiredSampleCount
  ) {
    throw new PayloadDecodeError(
      "SAMPLE_COUNT_MISMATCH",
      `${layout.label} carries exactly ${layout.requiredSampleCount} sample, got ${sampleCount}.`,
    );
  }

  // --- Samples ---
  const samples: DecodedSample[] = [];
  for (let i = 0; i < sampleCount; i++) {
    samples.push(
      readSample(
        view,
        layout.headerSize + i * layout.sampleSize,
        layout.sampleFields,
      ),
    );
  }

  // --- Context ---
  const contextBase = layout.headerSize + sampleCount * layout.sampleSize;
  const rawContext = readContext(view, contextBase, layout.contextFields);

  const errorMask = rawContext.error_mask ?? 0;
  // V1 keeps the reporting counter in the header; mirror it into the context so
  // every format exposes it in the same place (the stored column, the charts and
  // the CSV all read it from there).
  const reportingCounter =
    headerReportingCounter ?? rawContext.reporting_counter ?? 0;

  const context: DecodedContext = {
    ...rawContext,
    error_mask: errorMask,
    reporting_counter: reportingCounter,
  };

  return {
    payload_version: payloadVersion,
    layout_revision: layout.revision,
    device_uid: deviceUid,
    sample_count: sampleCount,
    samples,
    context,
    sample_time_utc: layout.hasSampleTime
      ? ((rawContext.status_flags ?? 0) & STATUS_FLAG_TIME_UTC) !== 0
      : null,
    error_mask: errorMask,
    error_mask_hex: formatErrorMask(errorMask),
    reporting_counter: reportingCounter,
    errors: resolveErrorMask(errorMask),
  };
}

/**
 * The absolute time of a sample, when the payload carries one.
 *
 * Returns the UTC instant when status flags bit 5 says the sample time is UTC.
 * Returns null when the time is seconds since boot (the document says to use
 * the reception time instead) or when the format has no sample time at all.
 */
export function sampleInstant(
  decoded: Pick<DecodedPayload, "sample_time_utc">,
  sample: DecodedSample,
): Date | null {
  if (decoded.sample_time_utc !== true) return null;
  const seconds = sample.time;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}

// Annotate every byte with the section it belongs to, for the comparison view.
function annotateBytes(
  bytes: Uint8Array,
  sampleCount: number,
  layout: PayloadLayout,
): AnnotatedByte[] {
  const contextStart = layout.headerSize + sampleCount * layout.sampleSize;
  const annotated: AnnotatedByte[] = [];
  for (let offset = 0; offset < bytes.length; offset++) {
    let section: ByteSection;
    let sampleIndex: number | null = null;
    if (offset < layout.headerSize) {
      section = "header";
    } else if (offset >= contextStart) {
      section = "context";
    } else {
      section = "sample";
      sampleIndex = Math.floor((offset - layout.headerSize) / layout.sampleSize);
    }
    annotated.push({
      offset,
      hex: bytes[offset].toString(16).padStart(2, "0"),
      binary: bytes[offset].toString(2).padStart(8, "0"),
      section,
      sampleIndex,
    });
  }
  return annotated;
}

// Decode a payload and package it together with its raw representations
// (hex, binary, per-byte annotation). Used by the API and the frontend.
export function analyzePayload(input: PayloadInput): PayloadAnalysis {
  const bytes = toUint8Array(input);
  const decoded = decodePayload(bytes);
  const layout = layoutOf(decoded);

  return {
    meta: {
      byteLength: bytes.length,
      expectedLength: lengthOf(layout, decoded.sample_count),
      sampleCount: decoded.sample_count,
      version: decoded.payload_version,
      revision: layout.revision,
      revisionLabel: layout.label,
      headerSize: layout.headerSize,
      sampleSize: layout.sampleSize,
      contextSize: layout.contextSize,
    },
    hex: bytesToHex(bytes),
    binary: bytesToBinary(bytes),
    bytes: annotateBytes(bytes, decoded.sample_count, layout),
    decoded,
  };
}
