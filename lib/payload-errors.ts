// Catalog of device error codes that may appear in the `error_mask` field of a
// decoded payload's batch context. Each code is a single-bit mask, so a
// payload's `error_mask` value can be the OR of several codes (e.g. 0x00000018
// means hall effect sensor 1 + hall effect sensor 2 errors).
//
// This is the TypeScript source of truth mirrored by the SQL seed in
// scripts/002_create_payload_error_codes.sql, and matches the "Error Codes"
// protocol document.

export interface PayloadErrorDef {
  bit: number; // 0 for ERR_RSN_NONE (sentinel), otherwise the single bit set
  code: string; // canonical "0x00000001" form
  name: string;
  description: string;
  color: string;
}

export const PAYLOAD_ERRORS: PayloadErrorDef[] = [
  { bit: 0x00000000, code: "0x00000000", name: "ERR_RSN_NONE",                   description: "No error",                                             color: "#16a34a" },
  { bit: 0x00000001, code: "0x00000001", name: "ERR_RSN_SENSOR_AMBIENT",         description: "Cannot configure/read ambient sensor",                 color: "#2563eb" },
  { bit: 0x00000002, code: "0x00000002", name: "ERR_RSN_SENSOR_LIGHT",           description: "Cannot configure/read light sensor",                   color: "#0ea5e9" },
  { bit: 0x00000004, code: "0x00000004", name: "ERR_RSN_SENSOR_ACCELEROMETER",   description: "Cannot configure/read accelerometer sensor",           color: "#7c3aed" },
  { bit: 0x00000008, code: "0x00000008", name: "ERR_RSN_SENSOR_HALL_EFFECT_1",   description: "Cannot configure/read hall effect sensor 1",           color: "#a855f7" },
  { bit: 0x00000010, code: "0x00000010", name: "ERR_RSN_SENSOR_HALL_EFFECT_2",   description: "Cannot configure/read hall effect sensor 2",           color: "#c026d3" },
  { bit: 0x00000020, code: "0x00000020", name: "ERR_RSN_SENSOR_CABLE_TEMP_1",    description: "Cannot configure/read cable temperature sensor 1",     color: "#db2777" },
  { bit: 0x00000040, code: "0x00000040", name: "ERR_RSN_SENSOR_CABLE_TEMP_2",    description: "Cannot configure/read cable temperature sensor 2",     color: "#e11d48" },
  { bit: 0x00000080, code: "0x00000080", name: "ERR_RSN_SENSOR_CABLE_TEMP_3",    description: "Cannot configure/read cable temperature sensor 3",     color: "#dc2626" },
  { bit: 0x00000100, code: "0x00000100", name: "ERR_RSN_SENSOR_BUS_ADQUISITION", description: "Sensor bus acquisition failed",                        color: "#ea580c" },
  { bit: 0x00000200, code: "0x00000200", name: "ERR_RSN_COMM_OPEN",              description: "Cannot open communication interface",                  color: "#d97706" },
  { bit: 0x00000400, code: "0x00000400", name: "ERR_RSN_COMM_SEND",              description: "Cannot send data",                                     color: "#ca8a04" },
  { bit: 0x00000800, code: "0x00000800", name: "ERR_RSN_CONFIG_INVALID",         description: "Configuration is invalid",                             color: "#65a30d" },
  { bit: 0x00001000, code: "0x00001000", name: "ERR_RSN_ENCODE_PAYLOAD",         description: "Cannot encode payload",                                color: "#0d9488" },
  { bit: 0x00002000, code: "0x00002000", name: "ERR_RSN_CONFIG_APPLY",           description: "Cannot apply configuration",                           color: "#0891b2" },
  { bit: 0x00004000, code: "0x00004000", name: "ERR_RSN_BAT_UNDER_75",           description: "Battery capacity under 75%",                           color: "#f59e0b" },
  { bit: 0x00008000, code: "0x00008000", name: "ERR_RSN_BAT_UNDER_50",           description: "Battery capacity under 50%",                           color: "#f97316" },
  { bit: 0x00010000, code: "0x00010000", name: "ERR_RSN_BAT_UNDER_25",           description: "Battery capacity under 25%",                           color: "#b91c1c" },
  { bit: 0x00020000, code: "0x00020000", name: "ERR_RSN_BAT_DISABLED",           description: "Battery disabled as a precautionary measure",          color: "#7f1d1d" },
  { bit: 0x00040000, code: "0x00040000", name: "ERR_RSN_BAT_STATUS_UNKNOWN",     description: "Can not determine the status of the battery.",         color: "#52525b" },
  { bit: 0x00080000, code: "0x00080000", name: "ERR_RSN_SCAP_UNBALANCED",        description: "Supercapacitors disconnected. Unbalanced detected.",   color: "#1e293b" },
];

export const PAYLOAD_ERROR_BY_NAME = new Map(PAYLOAD_ERRORS.map((e) => [e.name, e]));
export const PAYLOAD_ERROR_BY_BIT = new Map(PAYLOAD_ERRORS.map((e) => [e.bit, e]));
export const PAYLOAD_ERROR_NONE = PAYLOAD_ERRORS[0];

// Every single-bit flag we know about OR-ed together. Any bit set in a mask
// outside this range is reported back as an "unknown" flag so decoding never
// silently drops information.
const KNOWN_BITS = PAYLOAD_ERRORS.reduce((acc, e) => acc | e.bit, 0);

export interface ResolvedError {
  bit: number;
  code: string;
  name: string;
  description: string;
  color: string;
}

// Expand a numeric error mask into the list of active error definitions.
// A mask of 0 resolves to the single ERR_RSN_NONE sentinel. Unknown bits (not
// present in the catalog) are surfaced as synthetic "ERR_RSN_UNKNOWN_0xNN"
// entries so the caller can see them.
export function resolveErrorMask(mask: number): ResolvedError[] {
  const normalized = mask >>> 0; // force unsigned 32-bit
  if (normalized === 0) {
    return [{ ...PAYLOAD_ERROR_NONE }];
  }

  const resolved: ResolvedError[] = [];
  for (const def of PAYLOAD_ERRORS) {
    if (def.bit !== 0 && (normalized & def.bit) === def.bit) {
      resolved.push({ ...def });
    }
  }

  const unknownBits = normalized & ~KNOWN_BITS;
  if (unknownBits !== 0) {
    for (let bit = 1; bit <= unknownBits; bit <<= 1) {
      if ((unknownBits & bit) === bit) {
        const code = `0x${(bit >>> 0).toString(16).padStart(8, "0")}`;
        resolved.push({
          bit,
          code,
          name: `ERR_RSN_UNKNOWN_${code}`,
          description: "Unknown error flag (not present in the catalog).",
          color: "#9ca3af",
        });
      }
    }
  }

  return resolved;
}

// Canonical "0x00000018" form of a numeric mask.
export function formatErrorMask(mask: number): string {
  return `0x${(mask >>> 0).toString(16).padStart(8, "0")}`;
}
