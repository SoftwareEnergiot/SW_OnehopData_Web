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
  // Added by the V1 revision that introduced the sample time.
  { bit: 0x00100000, code: "0x00100000", name: "ERR_RSN_BOOT_COUNT_NOT_STORED",  description: "This boot's boot count could not be persisted and may repeat on the next boot.", color: "#6d28d9" },
  { bit: 0x00200000, code: "0x00200000", name: "ERR_RSN_CLOCK_JUMP",             description: "A clock sync moved the clock by more than 120 s; sample times around it may be off by that much.", color: "#be185d" },
  { bit: 0x00400000, code: "0x00400000", name: "ERR_RSN_CLOCK_SYNC_FAILED",      description: "No valid clock in a cycle: modem clock invalid and NTP failed. That cycle's report was most likely lost too.", color: "#9f1239" },
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

// ---------------------------------------------------------------------------
// V1 additions
//
// The V1 payload carries three further bit/enum fields that the V0 format did
// not have: the per-sample "valid sample mask", the modem status flags, and the
// last communication error enum. They are resolved here, next to the error
// catalog, so every lookup table for the protocol lives in one module.
// ---------------------------------------------------------------------------

export interface ValidSampleBitDef {
  bit: number;
  label: string;
  /** Sample channels whose values are only meaningful when this bit is set. */
  fields: string[];
}

// Bit positions match the firmware sensor mask (V1 spec, "Valid sample mask").
// A set bit means the sensor was read successfully; a clear bit means its
// fields were transmitted as 0 and must be discarded, not read as a measurement.
export const VALID_SAMPLE_BITS: ValidSampleBitDef[] = [
  { bit: 0, label: "Ambient (external)",  fields: ["ambient_temperature", "ambient_humidity"] },
  { bit: 1, label: "Luminosity",          fields: ["luminosity"] },
  { bit: 2, label: "Accelerometer",       fields: ["acceleration_x", "acceleration_y", "acceleration_z"] },
  { bit: 3, label: "Current 1",           fields: ["current_1_int_temp", "magnetic_field_1"] },
  { bit: 4, label: "Current 2",           fields: ["current_2_int_temp", "magnetic_field_2"] },
  { bit: 5, label: "Cable temperature 1", fields: ["thermocouple_1"] },
  { bit: 6, label: "Cable temperature 2", fields: ["thermocouple_2"] },
  { bit: 7, label: "Cable temperature 3", fields: [] }, // not used in v1, always 0
  { bit: 8, label: "Ambient (internal)",  fields: ["internal_temperature", "internal_humidity"] },
];

export interface ResolvedValidSampleBit extends ValidSampleBitDef {
  valid: boolean;
}

// Expand a valid-sample mask into one entry per known sensor bit, each marked
// valid or not. Bits 9-15 are reserved and are not reported.
export function resolveValidSampleMask(mask: number): ResolvedValidSampleBit[] {
  const normalized = mask >>> 0;
  return VALID_SAMPLE_BITS.map((def) => ({
    ...def,
    valid: (normalized & (1 << def.bit)) !== 0,
  }));
}

// The set of sample channels that were NOT read successfully, so the UI can
// mark their (zero) values as "no measurement" instead of showing a reading.
export function invalidSampleFields(mask: number): Set<string> {
  const invalid = new Set<string>();
  for (const def of resolveValidSampleMask(mask)) {
    if (!def.valid) {
      for (const field of def.fields) invalid.add(field);
    }
  }
  return invalid;
}

// Canonical "0x017f" form of a 16-bit mask.
export function formatSampleMask(mask: number): string {
  return `0x${(mask >>> 0).toString(16).padStart(4, "0")}`;
}

// Context field 2: last cellular error.
export const COMM_ERRORS: Record<number, string> = {
  0: "None",
  1: "Attach",
  2: "HTTP connect",
  3: "HTTP request",
  4: "Sleep",
  5: "Clock",
  6: "Unknown",
  7: "Payload not sent: it contains the modem data-mode terminator (+++)",
};

export function describeCommError(value: number): string {
  return COMM_ERRORS[value] ?? `Unspecified (${value})`;
}

// Context field 10: modem status flags. bit0 PSM granted, bit1 PSM acceptable,
// bit2 is attached, bits3-4 radio access technology, bits5-7 reserved.
const RAT_NAMES: Record<number, string> = {
  0: "RAT unknown",
  1: "LTE-M",
  2: "NB-IoT",
};

// ERR_RSN_BAT_STATUS_UNKNOWN. The V1 document defines a special case around it:
// a battery_soc of 0 with this bit set means the fuel gauge failed, NOT an empty
// battery. Charting that 0 as a reading would draw a cliff to zero every time
// the gauge misbehaves.
export const ERR_BIT_BAT_STATUS_UNKNOWN = 0x00040000;

/**
 * Whether a reported battery state of charge is an actual measurement.
 *
 * Returns false only for the documented fuel-gauge failure: a 0 accompanied by
 * ERR_RSN_BAT_STATUS_UNKNOWN in the same report. A 0 on its own is a genuinely
 * flat battery and stays a reading. The firmware does not clamp the gauge, so
 * values above 100 are transmitted as-is and are also kept.
 */
export function isBatterySocValid(
  soc: number | null | undefined,
  errorMask: number | null | undefined,
): boolean {
  if (typeof soc !== "number" || !Number.isFinite(soc)) return false;
  if (soc !== 0) return true;
  return ((errorMask ?? 0) & ERR_BIT_BAT_STATUS_UNKNOWN) === 0;
}

// Context field 7: reset source.
//
// The V1 document only says "MCU reset source register of the last boot" and
// does not define the values. The MCU is a TI CC1352R (the payload UID is the
// factory IEEE 802.15.4 MAC read from FCFG1, and the part datasheet is attached
// to the same Confluence space), so these are the CC13x2/CC26x2 reset sources
// as returned by driverlib SysCtrlResetSourceGet() — the AON_PMCTL:RESETCTL
// RESET_SRC field, already shifted down to 0-7.
//
// UNVERIFIED AGAINST THE FIRMWARE: the mapping is inferred from the part, not
// from the protocol document. Confirm it against the firmware before relying on
// it operationally. The raw value is always shown alongside the label, and an
// unrecognised value is reported as such instead of being guessed at.
export interface ResetSourceDef {
  value: number;
  name: string;
  description: string;
}

export const RESET_SOURCES: ResetSourceDef[] = [
  { value: 0, name: "PWR_ON",               description: "Power-on reset — the device was powered up" },
  { value: 1, name: "PIN_RESET",            description: "External reset pin asserted" },
  { value: 2, name: "VDDS_LOSS",            description: "Brown-out: the VDDS supply dropped out" },
  { value: 3, name: "VDDR_LOSS",            description: "Brown-out: the VDDR supply dropped out" },
  { value: 4, name: "CLK_LOSS",             description: "Clock loss detected" },
  { value: 5, name: "SYSRESET",             description: "Software reset requested by the firmware" },
  { value: 6, name: "WARMRESET",            description: "Warm reset" },
  { value: 7, name: "WAKEUP_FROM_SHUTDOWN", description: "Woke from shutdown mode" },
];

export interface ResolvedResetSource extends ResetSourceDef {
  /** False when the value is outside the documented range and was not decoded. */
  recognised: boolean;
}

export function resolveResetSource(value: number): ResolvedResetSource {
  const raw = value >>> 0;
  const def = RESET_SOURCES.find((d) => d.value === raw);
  if (def) return { ...def, recognised: true };

  // Anything above 7 is not a reset source in this encoding. The likeliest
  // explanation is that the firmware sends the whole RESETCTL register rather
  // than the extracted field — say so rather than decode the low bits and
  // present a guess as a fact.
  return {
    value: raw,
    name: "UNKNOWN",
    description:
      "Outside the documented range. The firmware may be sending the raw RESETCTL register instead of the decoded source.",
    recognised: false,
  };
}

/** "0x00000002 — VDDS_LOSS (brown-out…)", for a table cell. */
export function describeResetSource(value: number): string {
  const resolved = resolveResetSource(value);
  const hex = `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
  return resolved.recognised
    ? `${hex} — ${resolved.name}: ${resolved.description}`
    : `${hex} — ${resolved.description}`;
}

// Status flags bits 6-7: where the last clock sync came from.
export const TIME_SOURCES: Record<number, string> = {
  0: "no clock sync",
  1: "modem clock",
  2: "NTP",
  3: "manual",
};

// ---------------------------------------------------------------------------
// V2 additions: the power stage
//
// V2 appends three context fields, read once per report when it is built: the
// input voltage, the UVLO threshold the LTC3331 is strapped to, and whether the
// supercapacitors are connected and energy harvesting is active. Each has its
// own "read failed" encoding, and a failed read must be stored as unknown
// (null) rather than as a 0 or a false that looks like a measurement.
// ---------------------------------------------------------------------------

/** vin_mv value the firmware sends when the input voltage could not be read. */
export const VIN_READ_FAILED = 0;
/** uvlos_mask value the firmware sends when the UV pins could not be read. */
export const UVLOS_READ_FAILED = 0xff;

export type UvloWindow = "short" | "wide";

export interface UvloThresholdDef {
  /** UV3..UV0 as a number, 0-15. */
  value: number;
  /** Rising UVLO threshold, in volts. */
  risingV: number;
  window: UvloWindow;
}

// The LTC3331 UVLO selection table, as the V2 document gives it.
export const UVLO_THRESHOLDS: UvloThresholdDef[] = [
  { value: 0,  risingV: 4,  window: "short" },
  { value: 1,  risingV: 5,  window: "short" },
  { value: 2,  risingV: 6,  window: "short" },
  { value: 3,  risingV: 7,  window: "short" },
  { value: 4,  risingV: 8,  window: "short" },
  { value: 5,  risingV: 8,  window: "wide" },
  { value: 6,  risingV: 10, window: "short" },
  { value: 7,  risingV: 10, window: "wide" },
  { value: 8,  risingV: 12, window: "short" },
  { value: 9,  risingV: 12, window: "wide" },
  { value: 10, risingV: 14, window: "short" },
  { value: 11, risingV: 14, window: "wide" },
  { value: 12, risingV: 16, window: "short" },
  { value: 13, risingV: 16, window: "wide" },
  { value: 14, risingV: 18, window: "short" },
  { value: 15, risingV: 18, window: "wide" },
];

// power_flags. Bits 2-5 are reserved and ignored.
export const POWER_FLAG_SUPERCAPS_CONNECTED = 0x01;
export const POWER_FLAG_EH_ACTIVE = 0x02;
/** Set when the supercapacitor state could not be read: bit 0 is not valid. */
export const POWER_FLAG_SUPERCAPS_READ_FAILED = 0x40;
/** Set when the energy harvesting state could not be read: bit 1 is not valid. */
export const POWER_FLAG_EH_READ_FAILED = 0x80;

/**
 * The V2 power-stage fields, read for storage: each one null when its read
 * failed, so it is never mistaken for a measurement.
 */
export interface PowerStatus {
  /** Input voltage in mV; null when the read failed (sent as 0). */
  vin_mv: number | null;
  /** UV3..UV0 as sent; null when the read failed (sent as 0xFF). */
  uvlos_mask: number | null;
  /** Rising UVLO threshold in volts; null when unknown. */
  uvlos_rising_v: number | null;
  uvlos_window: UvloWindow | null;
  supercaps_connected: boolean | null;
  eh_active: boolean | null;
}

/**
 * The UVLO threshold a uvlos_mask selects, or null when it selects none: a
 * failed read (0xFF), or a value with any of the always-zero bits 4-7 set,
 * which is malformed and is not decoded by guessing at its low bits.
 */
export function resolveUvlos(value: number): UvloThresholdDef | null {
  return UVLO_THRESHOLDS.find((def) => def.value === value) ?? null;
}

/**
 * The two states power_flags carries. A state whose read-failed bit is set is
 * unknown (null), not false: its own bit is not valid then.
 */
export function resolvePowerFlags(
  value: number,
): Pick<PowerStatus, "supercaps_connected" | "eh_active"> {
  return {
    supercaps_connected:
      value & POWER_FLAG_SUPERCAPS_READ_FAILED
        ? null
        : (value & POWER_FLAG_SUPERCAPS_CONNECTED) !== 0,
    eh_active:
      value & POWER_FLAG_EH_READ_FAILED ? null : (value & POWER_FLAG_EH_ACTIVE) !== 0,
  };
}

export function resolvePowerStatus(
  vinMv: number,
  uvlosMask: number,
  powerFlags: number,
): PowerStatus {
  const uvlo = resolveUvlos(uvlosMask);
  return {
    vin_mv: vinMv === VIN_READ_FAILED ? null : vinMv,
    uvlos_mask: uvlosMask === UVLOS_READ_FAILED ? null : uvlosMask,
    uvlos_rising_v: uvlo?.risingV ?? null,
    uvlos_window: uvlo?.window ?? null,
    ...resolvePowerFlags(powerFlags),
  };
}

/** "12 V rising, short window", for a table cell. */
export function describeUvlos(value: number): string {
  if (value === UVLOS_READ_FAILED) return "read failed";
  const uvlo = resolveUvlos(value);
  return uvlo
    ? `${uvlo.risingV} V rising, ${uvlo.window} window`
    : "not a UVLO selection: bits 4-7 should always be 0";
}

/** "supercaps connected, EH active", for a table cell. */
export function describePowerFlags(value: number): string {
  const { supercaps_connected, eh_active } = resolvePowerFlags(value);
  const supercaps =
    supercaps_connected === null
      ? "supercaps read failed"
      : supercaps_connected
        ? "supercaps connected"
        : "supercaps disconnected";
  const eh =
    eh_active === null ? "EH read failed" : eh_active ? "EH active" : "EH inactive";
  return `${supercaps}, ${eh}`;
}

// Bits 5-7 were reserved in the earlier V1 revisions and are always 0 there, so
// decoding them unconditionally is safe: an old payload simply reads as
// "uptime, no clock sync". Pass describeTime = false to leave them out for a
// format that has no sample time and where they would only be noise.
export function resolveStatusFlags(value: number, describeTime = true): string[] {
  const flags: string[] = [];
  if (value & 0x01) flags.push("PSM granted");
  if (value & 0x02) flags.push("PSM acceptable");
  if (value & 0x04) flags.push("Attached");
  const rat = (value >> 3) & 0x03;
  flags.push(RAT_NAMES[rat] ?? `RAT ${rat}`);
  if (describeTime) {
    flags.push(value & 0x20 ? "time UTC" : "time since boot");
    flags.push(`source ${TIME_SOURCES[(value >> 6) & 0x03]}`);
  }
  return flags;
}
