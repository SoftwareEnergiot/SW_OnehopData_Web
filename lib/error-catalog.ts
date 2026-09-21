// Decoding of a device error mask against `public.payload_error_codes`.
//
// The lookup table is the authoritative source of `code`, `bit_value`, `name`
// and `description`; this module only does the arithmetic. Every entry is a
// single-bit flag, so a mask is the OR of the active flags and an entry is
// active when `(mask & bit_value) !== 0` — `bit_value` is the *value* of the
// bit, never its index.
//
// All of it is done in BigInt. `payloads.error_mask` is a BIGINT column and the
// catalog's top entry is 0x80000000, which does not survive JavaScript's
// 32-bit signed bitwise operators; a malformed row carrying bits above 2^32
// must also be reported rather than silently truncated.

import { PAYLOAD_ERROR_BY_BIT } from "@/lib/payload-errors";

/** One row of `public.payload_error_codes`. */
export interface ErrorCodeRecord {
  code: string;
  bit_value: number;
  name: string;
  description: string;
}

export interface ResolvedErrorCode extends ErrorCodeRecord {
  /** Documented as "Reserved. Always 0." — only ever seen on malformed data. */
  reserved: boolean;
  /** Set on a bit the catalog does not describe at all. */
  unknown: boolean;
  /** Badge colour. Presentation only; the catalog carries no colour. */
  color: string;
}

const RESERVED_NAME = /RESERVED_BIT_/i;
const UNKNOWN_COLOR = "#9ca3af";
const NONE_COLOR = "#16a34a";

/** Canonical "0x00000018" form of a mask. Widths past 32 bits are kept. */
export function formatMaskHex(mask: bigint): string {
  const hex = mask.toString(16).toUpperCase();
  return `0x${hex.padStart(Math.max(8, hex.length), "0").toLowerCase()}`;
}

/**
 * Read a mask from whatever the database/API handed back. `bigint` columns
 * arrive as numbers from PostgREST, but a value past Number.MAX_SAFE_INTEGER
 * would arrive as a string, and a null is simply "no mask".
 *
 * A negative number within the 32-bit range is read as the unsigned value it
 * would have been: the only way a mask turns negative is a round-trip through
 * a 32-bit signed bitwise operator, and 0x80000000 is a real catalog entry.
 * Anything else that is not a mask resolves to 0 rather than throwing, so one
 * malformed row cannot take the view down.
 */
export function toMask(
  value: number | string | bigint | null | undefined,
): bigint {
  try {
    if (value === null || value === undefined) return 0n;
    if (typeof value === "bigint") return value >= 0n ? value : 0n;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return 0n;
      const whole = Math.trunc(value);
      if (whole < 0) {
        return whole >= -2147483648 ? BigInt(whole >>> 0) : 0n;
      }
      return BigInt(whole);
    }
    const trimmed = value.trim();
    if (trimmed === "") return 0n;
    const parsed = /^0x/i.test(trimmed) ? BigInt(trimmed) : BigInt(trimmed);
    return parsed >= 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

function colorFor(entry: ErrorCodeRecord, reserved: boolean): string {
  if (reserved) return UNKNOWN_COLOR;
  if (entry.bit_value === 0) return NONE_COLOR;
  // The built-in catalog carries the palette the dashboard has always used.
  // Matched by bit value, so a renamed entry keeps its colour.
  return PAYLOAD_ERROR_BY_BIT.get(entry.bit_value)?.color ?? UNKNOWN_COLOR;
}

/** The catalog's ERR_RSN_NONE row (bit_value 0), when it has one. */
export function noneEntry(
  catalog: readonly ErrorCodeRecord[],
): ErrorCodeRecord | null {
  return catalog.find((entry) => entry.bit_value === 0) ?? null;
}

/**
 * Expand an error mask into the catalog entries it has set.
 *
 * - A mask of 0 resolves to ERR_RSN_NONE alone.
 * - A non-zero mask never includes ERR_RSN_NONE: the absence of errors and the
 *   presence of one are mutually exclusive.
 * - Reserved bits are documented as always 0. If malformed data sets one it is
 *   reported and flagged `reserved` rather than dropped or crashed on.
 * - A bit the catalog does not describe at all is reported as a synthetic
 *   `ERR_RSN_UNKNOWN_0x…` entry, so decoding never loses information.
 *
 * Entries come back in ascending bit order.
 */
export function decodeErrorMask(
  mask: number | string | bigint | null | undefined,
  catalog: readonly ErrorCodeRecord[],
): ResolvedErrorCode[] {
  const value = toMask(mask);

  if (value === 0n) {
    const none = noneEntry(catalog);
    return none
      ? [{ ...none, reserved: false, unknown: false, color: colorFor(none, false) }]
      : [];
  }

  const resolved: ResolvedErrorCode[] = [];
  let described = 0n;

  for (const entry of catalog) {
    const bit = toMask(entry.bit_value);
    if (bit === 0n) continue; // ERR_RSN_NONE is not a flag.
    described |= bit;
    if ((value & bit) === 0n) continue;
    const reserved = RESERVED_NAME.test(entry.name);
    resolved.push({
      ...entry,
      reserved,
      unknown: false,
      color: colorFor(entry, reserved),
    });
  }

  // Bits set in the mask that no catalog row covers.
  let rest = value & ~described;
  for (let bit = 1n; rest !== 0n && bit <= value; bit <<= 1n) {
    if ((rest & bit) === 0n) continue;
    rest &= ~bit;
    const code = formatMaskHex(bit);
    resolved.push({
      code,
      // Bits past 2^53 cannot be a Number faithfully; the code string above is
      // the exact value, and this stays ordered correctly for sorting.
      bit_value: Number(bit),
      name: `ERR_RSN_UNKNOWN_${code}`,
      description: "Not present in payload_error_codes.",
      reserved: false,
      unknown: true,
      color: UNKNOWN_COLOR,
    });
  }

  resolved.sort((a, b) => (a.bit_value < b.bit_value ? -1 : a.bit_value > b.bit_value ? 1 : 0));
  return resolved;
}
