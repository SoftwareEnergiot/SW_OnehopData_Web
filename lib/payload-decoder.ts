// Reusable decoder for the "Payload Encode - LoraWAN V0" binary protocol.
//
// Layout (all multi-byte fields little-endian; int16 fields are two's
// complement signed):
//
//   Header  :  2 bytes            -> payload id/version (uint8), sample count (uint8)
//   Samples : 28 * N bytes        -> N consecutive 28-byte samples
//   Context :  8 bytes            -> error mask (uint32), reporting counter (uint32)
//
//   Total   = 2 + (28 * N) + 8 = 10 + 28*N bytes
//
// The protocol markdown is the source of truth; this module mirrors it and is
// pure (no Node Buffer / DOM dependency) so it runs on the server, in the
// browser, and under Vitest unchanged.

import {
  resolveErrorMask,
  formatErrorMask,
  type ResolvedError,
} from "@/lib/payload-errors";

export const HEADER_SIZE = 2;
export const SAMPLE_SIZE = 28;
export const CONTEXT_SIZE = 8;

// Versions this decoder understands. The protocol document describes V0.
export const SUPPORTED_VERSIONS = [0] as const;

// Total payload length for a given sample count.
export function expectedLength(sampleCount: number): number {
  return HEADER_SIZE + SAMPLE_SIZE * sampleCount + CONTEXT_SIZE;
}

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

// One numeric channel inside a 28-byte sample. Keyed identically to the
// decoding example in the protocol document.
export interface SampleFieldDef {
  key: keyof DecodedSample;
  label: string;
  offset: number; // byte offset within the sample
  type: "int16" | "uint16" | "uint32";
  factor: number; // scaling divisor (raw / factor = engineering value)
  unit: string;
}

export const SAMPLE_FIELDS: SampleFieldDef[] = [
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

export interface DecodedSample {
  temp1_x10: number;
  temp2_x10: number;
  temp3_x10: number;
  amb_temp_x10: number;
  amb_hum_x10: number;
  int_temp_x10: number;
  int_hum_x10: number;
  lux: number;
  accel_x: number;
  accel_y: number;
  accel_z: number;
  current1: number;
  current2: number;
}

export interface DecodedContext {
  error_mask: number;
  reporting_counter: number;
}

export interface DecodedPayload {
  payload_version: number;
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

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function readSample(view: DataView, base: number): DecodedSample {
  const sample = {} as DecodedSample;
  for (const field of SAMPLE_FIELDS) {
    const at = base + field.offset;
    let value: number;
    switch (field.type) {
      case "int16":
        value = view.getInt16(at, true); // little-endian, two's complement
        break;
      case "uint16":
        value = view.getUint16(at, true);
        break;
      case "uint32":
        value = view.getUint32(at, true);
        break;
    }
    sample[field.key] = value;
  }
  return sample;
}

// Decode a raw payload into its structured form. Throws PayloadDecodeError on
// any validation failure (empty, invalid length, unsupported version, sample
// count mismatch, malformed body).
export function decodePayload(input: PayloadInput): DecodedPayload {
  const bytes = toUint8Array(input);

  if (bytes.length === 0) {
    throw new PayloadDecodeError("EMPTY_PAYLOAD", "Payload is empty.");
  }

  if (bytes.length < HEADER_SIZE + CONTEXT_SIZE) {
    throw new PayloadDecodeError(
      "INVALID_LENGTH",
      `Payload too short: ${bytes.length} bytes, need at least ${
        HEADER_SIZE + CONTEXT_SIZE
      } (header + context).`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const payloadVersion = view.getUint8(0);
  const sampleCount = view.getUint8(1);

  if (!SUPPORTED_VERSIONS.includes(payloadVersion as (typeof SUPPORTED_VERSIONS)[number])) {
    throw new PayloadDecodeError(
      "UNSUPPORTED_VERSION",
      `Unsupported payload version ${payloadVersion}. Supported: ${SUPPORTED_VERSIONS.join(
        ", ",
      )}.`,
    );
  }

  const bodyLength = bytes.length - HEADER_SIZE - CONTEXT_SIZE;
  if (bodyLength % SAMPLE_SIZE !== 0) {
    throw new PayloadDecodeError(
      "INVALID_LENGTH",
      `Payload length ${bytes.length} is not valid: the sample region (${bodyLength} bytes) is not a multiple of ${SAMPLE_SIZE}.`,
    );
  }

  const derivedCount = bodyLength / SAMPLE_SIZE;
  if (derivedCount !== sampleCount) {
    throw new PayloadDecodeError(
      "SAMPLE_COUNT_MISMATCH",
      `Header declares ${sampleCount} sample(s) but the payload length implies ${derivedCount}. Expected ${expectedLength(
        sampleCount,
      )} bytes, got ${bytes.length}.`,
    );
  }

  const samples: DecodedSample[] = [];
  for (let i = 0; i < sampleCount; i++) {
    samples.push(readSample(view, HEADER_SIZE + i * SAMPLE_SIZE));
  }

  const contextBase = HEADER_SIZE + sampleCount * SAMPLE_SIZE;
  const errorMask = view.getUint32(contextBase, true);
  const reportingCounter = view.getUint32(contextBase + 4, true);

  return {
    payload_version: payloadVersion,
    sample_count: sampleCount,
    samples,
    context: {
      error_mask: errorMask,
      reporting_counter: reportingCounter,
    },
    error_mask: errorMask,
    error_mask_hex: formatErrorMask(errorMask),
    reporting_counter: reportingCounter,
    errors: resolveErrorMask(errorMask),
  };
}

// Annotate every byte with the section it belongs to, for the comparison view.
function annotateBytes(bytes: Uint8Array, sampleCount: number): AnnotatedByte[] {
  const contextStart = HEADER_SIZE + sampleCount * SAMPLE_SIZE;
  const annotated: AnnotatedByte[] = [];
  for (let offset = 0; offset < bytes.length; offset++) {
    let section: ByteSection;
    let sampleIndex: number | null = null;
    if (offset < HEADER_SIZE) {
      section = "header";
    } else if (offset >= contextStart) {
      section = "context";
    } else {
      section = "sample";
      sampleIndex = Math.floor((offset - HEADER_SIZE) / SAMPLE_SIZE);
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

  return {
    meta: {
      byteLength: bytes.length,
      expectedLength: expectedLength(decoded.sample_count),
      sampleCount: decoded.sample_count,
      version: decoded.payload_version,
    },
    hex: bytesToHex(bytes),
    binary: bytesToBinary(bytes),
    bytes: annotateBytes(bytes, decoded.sample_count),
    decoded,
  };
}
