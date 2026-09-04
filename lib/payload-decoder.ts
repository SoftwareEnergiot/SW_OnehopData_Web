// Reusable decoder for the Onehop binary uplink payloads.
//
// Two formats are supported, dispatched on the version byte at offset 0:
//
//   V0 ("Payload Encode - LoraWAN V0")
//     Header  :  2 bytes       -> payload id/version (uint8), sample count (uint8)
//     Samples : 28 * N bytes   -> N consecutive 28-byte samples
//     Context :  8 bytes       -> error mask (uint32), reporting counter (uint32)
//     Total   = 10 + 28*N bytes
//
//   V1 (Confluence "V1", space WSNFD)
//     Header  : 14 bytes       -> version (uint8), device UID (uint8[8]),
//                                 sample count (uint8), reporting counter (uint32)
//     Samples : 32 * N bytes   -> N consecutive 32-byte samples (N is always 1)
//     Context : 36 bytes       -> error mask plus battery / modem diagnostics
//     Total   = 82 bytes for N = 1
//
// In both formats every multi-byte integer is little-endian and int8/int16
// fields are two's complement. The device UID is a raw byte array sent in
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

// --- V1 geometry -----------------------------------------------------------
export const V1_HEADER_SIZE = 14;
export const V1_SAMPLE_SIZE = 32;
export const V1_CONTEXT_SIZE = 36;

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

// The 15 channels of a 32-byte V1 sample. Field ids 1-15 in the V1 document.
export const V1_SAMPLE_FIELDS: SampleFieldDef[] = [
  { key: "thermocouple_1",       label: "Thermocouple 1",                 offset: 0,  type: "int16",  factor: 10, unit: "C" },
  { key: "thermocouple_2",       label: "Thermocouple 2",                 offset: 2,  type: "int16",  factor: 10, unit: "C" },
  { key: "current_1_int_temp",   label: "Current 1 internal temperature", offset: 4,  type: "int16",  factor: 10, unit: "C" },
  { key: "current_2_int_temp",   label: "Current 2 internal temperature", offset: 6,  type: "int16",  factor: 10, unit: "C" },
  { key: "ambient_temperature",  label: "Ambient temperature",            offset: 8,  type: "int16",  factor: 10, unit: "C" },
  { key: "ambient_humidity",     label: "Ambient humidity",               offset: 10, type: "uint16", factor: 10, unit: "%RH" },
  { key: "internal_temperature", label: "Internal temperature",           offset: 12, type: "int16",  factor: 10, unit: "C" },
  { key: "internal_humidity",    label: "Internal humidity",              offset: 14, type: "uint16", factor: 10, unit: "%RH" },
  { key: "luminosity",           label: "Luminosity",                     offset: 16, type: "uint32", factor: 1,  unit: "lux" },
  { key: "acceleration_x",       label: "Acceleration X",                 offset: 20, type: "int16",  factor: 1,  unit: "mg" },
  { key: "acceleration_y",       label: "Acceleration Y",                 offset: 22, type: "int16",  factor: 1,  unit: "mg" },
  { key: "acceleration_z",       label: "Acceleration Z",                 offset: 24, type: "int16",  factor: 1,  unit: "mg" },
  { key: "magnetic_field_1",     label: "Magnetic field 1",               offset: 26, type: "uint16", factor: 1,  unit: "uT" },
  { key: "magnetic_field_2",     label: "Magnetic field 2",               offset: 28, type: "uint16", factor: 1,  unit: "uT" },
  { key: "valid_sample_mask",    label: "Valid sample mask",              offset: 30, type: "uint16", factor: 1,  unit: "" },
];

export const V0_CONTEXT_FIELDS: ContextFieldDef[] = [
  { key: "error_mask",        label: "Error mask",        offset: 0, type: "uint32", unit: "" },
  { key: "reporting_counter", label: "Reporting counter", offset: 4, type: "uint32", unit: "" },
];

// The 14 fields of the fixed 36-byte V1 context. Fields 8-14 are refreshed by
// the modem only while it registers on the network, so they describe the
// *previous* transmission cycle, not the instant the report was built.
export const V1_CONTEXT_FIELDS: ContextFieldDef[] = [
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

// Kept for callers written against the single-format decoder. New code should
// use sampleFieldsFor(version), since the channel set is version-specific.
export const SAMPLE_FIELDS = V0_SAMPLE_FIELDS;

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

export interface PayloadLayout {
  version: number;
  headerSize: number;
  sampleSize: number;
  contextSize: number;
  sampleFields: SampleFieldDef[];
  contextFields: ContextFieldDef[];
  /** V1 carries a device UID in the header; V0 does not. */
  hasDeviceUid: boolean;
  /** Set when the format allows exactly one sample count (V1: always 1). */
  requiredSampleCount: number | null;
}

export const LAYOUTS: Record<number, PayloadLayout> = {
  0: {
    version: 0,
    headerSize: V0_HEADER_SIZE,
    sampleSize: V0_SAMPLE_SIZE,
    contextSize: V0_CONTEXT_SIZE,
    sampleFields: V0_SAMPLE_FIELDS,
    contextFields: V0_CONTEXT_FIELDS,
    hasDeviceUid: false,
    requiredSampleCount: null,
  },
  1: {
    version: 1,
    headerSize: V1_HEADER_SIZE,
    sampleSize: V1_SAMPLE_SIZE,
    contextSize: V1_CONTEXT_SIZE,
    sampleFields: V1_SAMPLE_FIELDS,
    contextFields: V1_CONTEXT_FIELDS,
    hasDeviceUid: true,
    // v1 always carries a single sample: the format keeps the field for v2,
    // which will add the timestamping needed to place several samples in time.
    requiredSampleCount: 1,
  },
};

// The layout for a version, or undefined when the version is unknown.
export function layoutFor(version: number): PayloadLayout | undefined {
  return LAYOUTS[version];
}

// Sample channels for a version, falling back to V0 for unknown versions so a
// caller rendering a legacy stored row never crashes.
export function sampleFieldsFor(version: number): SampleFieldDef[] {
  return (layoutFor(version) ?? LAYOUTS[0]).sampleFields;
}

export function contextFieldsFor(version: number): ContextFieldDef[] {
  return (layoutFor(version) ?? LAYOUTS[0]).contextFields;
}

// Total payload length for a given sample count. `version` defaults to 0 for
// callers written before the format became version-dependent.
export function expectedLength(sampleCount: number, version = 0): number {
  const layout = layoutFor(version) ?? LAYOUTS[0];
  return layout.headerSize + layout.sampleSize * sampleCount + layout.contextSize;
}

// ---------------------------------------------------------------------------
// Decoded shapes
// ---------------------------------------------------------------------------

// A decoded sample. The channel set depends on the payload version (see
// V0_SAMPLE_FIELDS / V1_SAMPLE_FIELDS), so the value is keyed by channel name;
// iterate sampleFieldsFor(version) to walk the channels a payload actually has.
export type DecodedSample = Record<string, number>;

// The decoded batch context. error_mask and reporting_counter are always
// present — in V1 the reporting counter lives in the header and is mirrored
// here so both formats expose it in the same place.
export type DecodedContext = {
  error_mask: number;
  reporting_counter: number;
} & Record<string, number>;

export interface DecodedPayload {
  payload_version: number;
  /** Colon-separated uppercase UID ("00:12:4B:…"), null for V0 payloads. */
  device_uid: string | null;
  sample_count: number;
  samples: DecodedSample[];
  context: DecodedContext;
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
    // Section sizes for this payload's version, so the UI can label the
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
// uppercase hex, colon separated, in wire order (never byte-swapped).
export function formatDeviceUid(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(":");
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
  // the layout used to read the rest.
  const payloadVersion = view.getUint8(0);
  const layout = layoutFor(payloadVersion);

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
      `Header declares ${sampleCount} sample(s) but the payload length implies ${derivedCount}. Expected ${expectedLength(
        sampleCount,
        payloadVersion,
      )} bytes, got ${bytes.length}.`,
    );
  }

  // V1 receivers must reject any payload that does not carry exactly one
  // sample, even when the header and the length agree with each other.
  if (
    layout.requiredSampleCount !== null &&
    sampleCount !== layout.requiredSampleCount
  ) {
    throw new PayloadDecodeError(
      "SAMPLE_COUNT_MISMATCH",
      `Version ${payloadVersion} carries exactly ${layout.requiredSampleCount} sample, got ${sampleCount}.`,
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
  // both formats expose it in the same place (the stored column, the charts and
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
    device_uid: deviceUid,
    sample_count: sampleCount,
    samples,
    context,
    error_mask: errorMask,
    error_mask_hex: formatErrorMask(errorMask),
    reporting_counter: reportingCounter,
    errors: resolveErrorMask(errorMask),
  };
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
  const layout = layoutFor(decoded.payload_version) ?? LAYOUTS[0];

  return {
    meta: {
      byteLength: bytes.length,
      expectedLength: expectedLength(decoded.sample_count, decoded.payload_version),
      sampleCount: decoded.sample_count,
      version: decoded.payload_version,
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
