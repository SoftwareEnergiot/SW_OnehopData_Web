// Schema metadata for each environment's payload dataset.
//
// The two datasets are shaped very differently — `public.payloads` stores whole
// received frames (raw hex plus the decoded JSON), `public."payloads_REE"`
// stores one already-decoded sample per row — so rather than duplicating the
// dashboard once per environment, every view is driven by the descriptor here:
// which columns exist, what they are called, their units, how they group, which
// ones can be charted or exported, and which features the dataset can support
// at all.
//
// Nothing in this module talks to the database. lib/payload-repository.ts owns
// that, and reads the table name from here.

import type { CsvColumn } from "@/lib/payload-csv";
import { STATUS_FLAG_TIME_UTC, V1_CONTEXT_FIELDS } from "@/lib/payload-decoder";
import { formatErrorMask } from "@/lib/payload-errors";
import { formatCreatedAt } from "@/lib/utils";
import { ENVIRONMENT_CONFIG, configForEnvironment } from "@/lib/environments";
import type { PayloadSchemaId } from "@/lib/payload-schemas.types";
import type { PayloadRow, ReePayloadRecord } from "@/lib/types";

export type { PayloadSchemaId };

/** How a column's value is rendered, everywhere it is rendered. */
export type FieldKind =
  | "timestamp" // timestamptz, shown on the dashboard clock
  | "text"
  | "mono" // an identifier: rendered monospaced
  | "integer"
  | "number" // may carry decimals
  | "errorMask" // decoded against payload_error_codes
  | "sampleMask" // valid_sample_mask bitmask
  | "sampleTime" // uint32 seconds, UTC epoch or since boot (see below)
  | "boolean";

export interface PayloadFieldDef {
  key: string;
  label: string;
  /** Engineering unit, e.g. "°C". Absent for dimensionless fields. */
  unit?: string;
  kind: FieldKind;
  /** Heading this field sits under in the detail view. */
  group: string;
  /** What the value means, shown in the detail view. */
  description?: string;
  /** Wire type in the protocol document, when the column mirrors one. */
  protocolType?: string;
  /** Decimals used when rendering a `number`. */
  decimals?: number;
  /**
   * Bit of `valid_sample_mask` that governs this reading. When that bit is
   * clear the sensor was not read and the column holds a 0 that must be shown
   * as "no reading" and kept out of every statistic — the same rule the
   * Development inspector already applies to a decoded V1 sample.
   */
  validBit?: number;
  /** Can be plotted as a per-bucket series. */
  chartable?: boolean;
}

export interface PayloadSchemaCapabilities {
  /** The row carries the raw frame, so the byte-level inspector applies. */
  rawPayloadInspector: boolean;
  /** The row carries an error mask that payload_error_codes can decode. */
  errorMask: boolean;
  /** `byte_length` exists, so the payload-size chart applies. */
  byteSizeChart: boolean;
  /** V1 battery / radio diagnostics exist (scripts/004, scripts/005). */
  diagnosticsCharts: boolean;
  /** Rows carry a device UID that the device filter can select on. */
  deviceFilter: boolean;
  /** The UI can write rows into this table. */
  writable: boolean;
  /**
   * The Remote config tab is offered, for the devices reporting to this
   * dataset. Development only: the REE devices are not configured remotely.
   */
  remoteConfig: boolean;
}

export interface PayloadSchema {
  id: PayloadSchemaId;
  /** Exact PostgREST table identifier. */
  table: string;
  /** What one row is, for copy: "payload" / "sample". */
  rowNoun: string;
  rowNounPlural: string;
  primaryKey: string;
  /** Column holding the database insertion time. */
  receivedKey: string;
  /** Column holding the device identifier, when there is one. */
  deviceKey: string | null;
  /**
   * How a device UID is stored in this table. `payloads` keeps the protocol
   * document's printed form ("00:12:4B:…"); `payloads_REE` keeps continuous
   * uppercase hex. A filter must be normalised to the right one or it matches
   * nothing.
   */
  deviceUidFormat: "colon" | "plain";
  fields: PayloadFieldDef[];
  /**
   * Field keys shown as columns of the list view until the reader saves a view
   * of their own (every field in `fields` can be picked).
   */
  listColumns: string[];
  /**
   * Every chart the reception timeline offers, in order: built-in chart keys
   * (BUILT_IN_CHARTS) followed by the chartable column keys.
   */
  charts: string[];
  /** Charts shown until the reader saves a view of their own. */
  defaultCharts: string[];
  /**
   * Column sets the summary endpoint tries, richest first. A tier naming a
   * column the database does not have is rejected with PostgREST 42703 and the
   * next one is tried, so an un-migrated database still charts what it can.
   */
  summaryColumnTiers: string[];
  /** One CSV column per field; an export takes the ones the table shows. */
  csvColumns: CsvColumn[];
  /** Basename of an exported CSV. */
  csvBasename: string;
  capabilities: PayloadSchemaCapabilities;
  /**
   * Device UIDs the database accepts on insert, when it restricts them. Shown
   * to the user where the UI writes rows, and used by the ingestion endpoint to
   * route a device's unaddressed payload to this table. Never used to filter
   * reads, and never used to rewrite a UID the user typed.
   */
  writeDeviceUids?: string[];
}

/* -------------------------------------------------- V1 fields, one per column */

// Both tables store every V1 field in a column of the same name, unit and
// scale: payloads_REE natively, payloads through the generated columns of
// scripts/004, 005 and 008 (read from its `samples` / `context` JSONB). So both
// schemas share these definitions.

// Which valid_sample_mask bit governs which column. The bits themselves are
// the protocol's (VALID_SAMPLE_BITS in lib/payload-errors); only the column
// names differ, because two columns spell the protocol's abbreviation out.
const VALID_BIT = {
  ambient: 0,
  luminosity: 1,
  accelerometer: 2,
  current1: 3,
  current2: 4,
  thermocouple1: 5,
  thermocouple2: 6,
  internal: 8,
} as const;

// What each V1 context field means, for the detail view. The inspector adds a
// value-specific reading on top (an enum name, the status flags spelled out...).
const V1_CONTEXT_DESCRIPTIONS: Record<string, string> = {
  error_mask: "Active device error flags.",
  last_communication_error: "Result of the last transmission attempt.",
  battery_soc: "Fuel gauge state of charge. Not clamped: a reading above 100 is sent as-is.",
  battery_voltage: "Battery voltage.",
  config_crc32: "CRC32 of the configuration file the device runs. Matches the file CRC on the Remote config tab once a saved config is applied.",
  boot_count: "Lifetime boot count, never cleared.",
  reset_source: "MCU reset source of the last boot.",
  rsrp: "Received signal power, previous transmission cycle. 0 means not available.",
  snr: "Signal-to-noise ratio, previous transmission cycle. 0 means not available (or a genuine 0 dB).",
  status_flags: "Modem and clock status. Bit 5 says whether sample_time is UTC.",
  tau: "Periodic tracking area update timer granted by the network, previous cycle.",
  active_time: "PSM active time granted by the network, previous cycle.",
  last_attach_duration_ms: "Duration of the last network attach.",
  last_tx_duration_ms: "Duration of the last transmission.",
  reporting_lost_counter: "Reports lost since boot. Read as a delta between reports.",
  tx_failed: "Failed transmissions since boot. Read as a delta between reports.",
  last_poll_status: "Result of the last remote configuration poll (GET /api/config).",
};

// Context numbers that read sensibly as a per-bucket mean. battery_soc and rsrp
// have built-in charts of their own; bitmasks, enums and the CRC do not plot.
const CHARTABLE_CONTEXT = new Set([
  "battery_voltage",
  "boot_count",
  "tau",
  "active_time",
  "last_attach_duration_ms",
  "last_tx_duration_ms",
  "reporting_lost_counter",
  "tx_failed",
]);

// The V1 context fields, one column each, taken from the decoder's own table so
// labels, types and units cannot drift from the protocol.
const V1_CONTEXT_COLUMN_FIELDS: PayloadFieldDef[] = V1_CONTEXT_FIELDS.map((field) => ({
  key: field.key,
  label: field.label,
  unit: field.unit || undefined,
  kind: field.key === "error_mask" ? "errorMask" : "integer",
  group: "Context",
  protocolType: field.type,
  description: V1_CONTEXT_DESCRIPTIONS[field.key],
  chartable: CHARTABLE_CONTEXT.has(field.key) || undefined,
}));

// The V1 sample: its read time, the 14 sensor channels and the valid mask.
const V1_SAMPLE_COLUMN_FIELDS: PayloadFieldDef[] = [
  // Sample information.
  {
    key: "sample_time",
    label: "Sample time",
    unit: "s",
    kind: "sampleTime",
    group: "Sample",
    protocolType: "uint32",
    description:
      "Sample timestamp: UTC epoch seconds when status_flags bit 5 is set, seconds since boot otherwise. Rows stored before the context columns existed have no status flags, so both readings are shown for them.",
  },

  // Temperature.
  { key: "thermocouple_1", label: "Thermocouple 1", unit: "°C", kind: "number", decimals: 1, group: "Temperature", description: "Cable temperature, probe 1.", validBit: VALID_BIT.thermocouple1, chartable: true },
  { key: "thermocouple_2", label: "Thermocouple 2", unit: "°C", kind: "number", decimals: 1, group: "Temperature", description: "Cable temperature, probe 2.", validBit: VALID_BIT.thermocouple2, chartable: true },
  { key: "current_1_internal_temperature", label: "Current Sensor 1 Internal Temperature", unit: "°C", kind: "number", decimals: 1, group: "Temperature", description: "Die/internal temperature of magnetic sensor 1.", validBit: VALID_BIT.current1, chartable: true },
  { key: "current_2_internal_temperature", label: "Current Sensor 2 Internal Temperature", unit: "°C", kind: "number", decimals: 1, group: "Temperature", description: "Die/internal temperature of magnetic sensor 2.", validBit: VALID_BIT.current2, chartable: true },
  { key: "ambient_temperature", label: "Ambient Temperature", unit: "°C", kind: "number", decimals: 1, group: "Temperature", description: "Temperature outside the enclosure.", validBit: VALID_BIT.ambient, chartable: true },
  { key: "internal_temperature", label: "Internal Temperature", unit: "°C", kind: "number", decimals: 1, group: "Temperature", description: "Temperature inside the enclosure.", validBit: VALID_BIT.internal, chartable: true },

  // Humidity.
  { key: "ambient_humidity", label: "Ambient Humidity", unit: "%RH", kind: "number", decimals: 1, group: "Humidity", description: "Humidity outside the enclosure.", validBit: VALID_BIT.ambient, chartable: true },
  { key: "internal_humidity", label: "Internal Humidity", unit: "%RH", kind: "number", decimals: 1, group: "Humidity", description: "Humidity inside the enclosure.", validBit: VALID_BIT.internal, chartable: true },

  // Luminosity.
  { key: "luminosity", label: "Luminosity", unit: "lux", kind: "integer", group: "Luminosity", description: "Ambient light.", validBit: VALID_BIT.luminosity, chartable: true },

  // Acceleration.
  { key: "acceleration_x", label: "Acceleration X", unit: "mg", kind: "integer", group: "Acceleration", validBit: VALID_BIT.accelerometer, chartable: true },
  { key: "acceleration_y", label: "Acceleration Y", unit: "mg", kind: "integer", group: "Acceleration", validBit: VALID_BIT.accelerometer, chartable: true },
  { key: "acceleration_z", label: "Acceleration Z", unit: "mg", kind: "integer", group: "Acceleration", validBit: VALID_BIT.accelerometer, chartable: true },

  // Magnetic field.
  { key: "magnetic_field_1", label: "Magnetic Field 1", unit: "µT", kind: "integer", group: "Magnetic field", description: "RMS magnetic field from sensor 1.", validBit: VALID_BIT.current1, chartable: true },
  { key: "magnetic_field_2", label: "Magnetic Field 2", unit: "µT", kind: "integer", group: "Magnetic field", description: "RMS magnetic field from sensor 2.", validBit: VALID_BIT.current2, chartable: true },

  // Validity.
  { key: "valid_sample_mask", label: "Valid Sample Mask", kind: "sampleMask", group: "Validity", description: "Bitmask indicating which sensor measurements were successfully acquired." },
];

// The V2 power stage, read once per report. Both tables store it decoded, one
// column per reading — payloads_REE written by the insert, payloads generated
// from its `context` JSONB — and each column is empty when the device could not
// read it, never a 0 or a "no" that would pass for a measurement. V1 rows have
// no power stage, so every one of these is empty for them.
const V2_POWER_COLUMN_FIELDS: PayloadFieldDef[] = [
  { key: "vin_mv", label: "Input voltage (Vin)", unit: "mV", kind: "integer", group: "Power", protocolType: "uint16", chartable: true, description: "Input voltage of the power stage. V2 only; empty when the read failed (sent as 0)." },
  { key: "uvlos_mask", label: "UVLO select (UV3..UV0)", kind: "integer", group: "Power", protocolType: "uint8", description: "LTC3331 UV3..UV0 pins, as sent. V2 only; empty when the read failed (sent as 0xFF)." },
  { key: "uvlos_rising_v", label: "UVLO rising threshold", unit: "V", kind: "integer", group: "Power", description: "Rising UVLO threshold the UV pins select. Empty when uvlos_mask is unknown or selects no threshold." },
  { key: "uvlos_window", label: "UVLO window", kind: "text", group: "Power", description: "UVLO hysteresis window the UV pins select: short or wide." },
  { key: "supercaps_connected", label: "Supercapacitors connected", kind: "boolean", group: "Power", description: "power_flags bit 0. Empty when bit 6 says the read failed." },
  { key: "eh_active", label: "Energy harvesting active", kind: "boolean", group: "Power", description: "power_flags bit 1. Empty when bit 7 says the read failed." },
];

/** Power-stage columns the summary endpoint charts. */
const POWER_CHARTABLE = chartableKeys(V2_POWER_COLUMN_FIELDS);

/* ------------------------------------------------------------------- views */

/**
 * Charts the timeline draws with a dedicated renderer, by key. Every other
 * chart key is a column, drawn as a generic per-bucket series.
 */
export const BUILT_IN_CHARTS: Record<string, string> = {
  reception: "Reception frequency",
  payload_size: "Payload size (bytes)",
  reporting_counter: "Frame counter (reporting_counter)",
  battery_soc: "Battery state of charge (%)",
  rsrp: "Cellular coverage (RSRP / SNR)",
};

/** Table columns shown until the reader saves a view, in both environments. */
const DEFAULT_LIST_COLUMNS = ["created_at", "device_uid", "error_mask", "reporting_counter"];

/** Charts shown until the reader saves a view, in both environments. */
const DEFAULT_CHARTS = ["battery_soc"];

function chartableKeys(fields: PayloadFieldDef[]): string[] {
  return fields.filter((field) => field.chartable).map((field) => field.key);
}

// Columns the diagnostics charts read: battery, coverage and the reporting-loss
// counters, plus the error mask that tells a failed fuel gauge from a flat
// battery.
const DIAGNOSTIC_COLUMNS = [
  "error_mask",
  "battery_soc",
  "battery_voltage",
  "rsrp",
  "snr",
  "reporting_lost_counter",
  "tx_failed",
];

/**
 * Columns minus the V2 power stage, for the tier that still works against a
 * table the power-stage SQL has not reached yet.
 */
function withoutPower(columns: string[]): string[] {
  return columns.filter((column) => !POWER_CHARTABLE.includes(column));
}

/** A comma-separated select list, each column once, in first-seen order. */
function selectList(columns: string[]): string {
  return Array.from(new Set(columns)).join(",");
}

/**
 * A field's CSV cell. Missing values, and readings whose valid_sample_mask bit
 * is clear, are exported empty — never as a 0, which a spreadsheet would
 * average in with real measurements. Times are written the way the table
 * shows them.
 */
function csvCell(field: PayloadFieldDef) {
  return (row: PayloadRow): string => {
    const value = columnValue(row, field.key);
    if (value === null || value === undefined) return "";
    if (!isReadingValid(row, field)) return "";
    switch (field.kind) {
      case "timestamp":
        return formatCreatedAt(String(value));
      case "errorMask":
        return typeof value === "number" ? formatErrorMask(value) : String(value);
      case "sampleTime": {
        // Status flags bit 5: UTC epoch (written as ISO 8601, so a spreadsheet
        // sorts it) or seconds since boot, which has no absolute meaning.
        const flags = columnValue(row, "status_flags");
        if (typeof value === "number" && typeof flags === "number") {
          return (flags & STATUS_FLAG_TIME_UTC) !== 0
            ? new Date(value * 1000).toISOString()
            : `uptime ${value} s`;
        }
        return String(value);
      }
      default:
        return String(value);
    }
  };
}

/** One CSV column per field, in field order: the export follows the table. */
function csvColumnsFor(fields: PayloadFieldDef[]): CsvColumn[] {
  return fields.map((field) => ({
    key: field.key,
    label: fieldLabel(field),
    value: csvCell(field),
  }));
}

/* ------------------------------------------------------- development schema */

const DEVELOPMENT_FIELDS: PayloadFieldDef[] = [
  { key: "id", label: "Row ID", kind: "mono", group: "Report", description: "Database row ID." },
  { key: "created_at", label: "Received", kind: "timestamp", group: "Report", description: "Database insertion timestamp." },
  { key: "device_uid", label: "Device UID", kind: "mono", group: "Report", protocolType: "uint8[8]", description: "Device IEEE 802.15.4 UID. Null only for V0 payloads stored before V0 was discarded." },
  { key: "payload_version", label: "Version", kind: "integer", group: "Report", protocolType: "uint8", description: "Payload format version." },
  { key: "sample_count", label: "Samples", kind: "integer", group: "Report", protocolType: "uint8", description: "Number of samples contained in the report." },
  { key: "reporting_counter", label: "Counter", kind: "integer", group: "Report", protocolType: "uint32", description: "Monotonic report counter." },
  { key: "byte_length", label: "Bytes", kind: "integer", unit: "B", group: "Report", description: "Total received length in bytes." },
  { key: "source_ip", label: "Source IP", kind: "mono", group: "Report", description: "Address the payload was received from." },
  { key: "payload_hex", label: "Payload hex", kind: "mono", group: "Report", description: "The received frame, byte for byte, in hexadecimal." },
  // The first sample's channels (a V1 report carries one), then the context.
  ...V1_SAMPLE_COLUMN_FIELDS,
  ...V1_CONTEXT_COLUMN_FIELDS,
  ...V2_POWER_COLUMN_FIELDS,
];

const DEVELOPMENT_CHARTABLE = chartableKeys(DEVELOPMENT_FIELDS);
const BASE_SUMMARY_COLUMNS = ["created_at", "byte_length", "reporting_counter", "error_mask"];

export const DEVELOPMENT_SCHEMA: PayloadSchema = {
  id: "development",
  table: ENVIRONMENT_CONFIG.Development.payloadTable,
  rowNoun: "payload",
  rowNounPlural: "payloads",
  primaryKey: "id",
  receivedKey: "created_at",
  deviceKey: "device_uid",
  deviceUidFormat: "colon",
  fields: DEVELOPMENT_FIELDS,
  listColumns: DEFAULT_LIST_COLUMNS,
  charts: [
    "reception",
    "payload_size",
    "reporting_counter",
    "battery_soc",
    "rsrp",
    ...DEVELOPMENT_CHARTABLE,
  ],
  defaultCharts: DEFAULT_CHARTS,
  summaryColumnTiers: [
    // With the V2 power-stage columns.
    selectList([
      ...BASE_SUMMARY_COLUMNS,
      "valid_sample_mask",
      ...DIAGNOSTIC_COLUMNS,
      ...DEVELOPMENT_CHARTABLE,
    ]),
    // scripts/008: every V1 field has its column.
    selectList([
      ...BASE_SUMMARY_COLUMNS,
      "valid_sample_mask",
      ...DIAGNOSTIC_COLUMNS,
      ...withoutPower(DEVELOPMENT_CHARTABLE),
    ]),
    // scripts/004 only: battery and radio diagnostics.
    selectList([...BASE_SUMMARY_COLUMNS, "battery_soc", "battery_voltage", "rsrp", "snr"]),
    // Original schema only.
    selectList(BASE_SUMMARY_COLUMNS),
  ],
  csvColumns: csvColumnsFor(DEVELOPMENT_FIELDS),
  csvBasename: "payloads",
  capabilities: {
    rawPayloadInspector: true,
    errorMask: true,
    byteSizeChart: true,
    diagnosticsCharts: true,
    deviceFilter: true,
    writable: true,
    remoteConfig: true,
  },
};

/* --------------------------------------------------------------- REE schema */

const REE_FIELDS: PayloadFieldDef[] = [
  // Database / report information.
  { key: "id", label: "Row ID", kind: "integer", group: "Report", description: "Database row ID." },
  { key: "created_at", label: "Received", kind: "timestamp", group: "Report", description: "Database insertion timestamp." },
  { key: "payload_version", label: "Payload version", kind: "integer", group: "Report", protocolType: "uint8", description: "Payload format version." },
  { key: "device_uid", label: "Device UID", kind: "mono", group: "Report", protocolType: "text", description: "Device IEEE 802.15.4 UID." },
  { key: "sample_count", label: "Sample count", kind: "integer", group: "Report", protocolType: "uint8", description: "Number of samples contained in the report." },
  { key: "reporting_counter", label: "Reporting counter", kind: "integer", group: "Report", protocolType: "uint32", description: "Monotonic report counter." },

  ...V1_SAMPLE_COLUMN_FIELDS,
  // The report's batch context, one column per field.
  ...V1_CONTEXT_COLUMN_FIELDS,
  // The V2 power stage, decoded.
  ...V2_POWER_COLUMN_FIELDS,
];

const REE_CHARTABLE = chartableKeys(REE_FIELDS);
const REE_SENSOR_KEYS = V1_SAMPLE_COLUMN_FIELDS.filter((field) => field.chartable).map(
  (field) => field.key,
);

export const REE_SCHEMA: PayloadSchema = {
  id: "ree",
  table: ENVIRONMENT_CONFIG.REE.payloadTable,
  rowNoun: "sample",
  rowNounPlural: "samples",
  primaryKey: "id",
  receivedKey: "created_at",
  deviceKey: "device_uid",
  deviceUidFormat: "plain",
  fields: REE_FIELDS,
  listColumns: DEFAULT_LIST_COLUMNS,
  // No payload-size chart: payloads_REE keeps no byte_length.
  charts: ["reception", "reporting_counter", "battery_soc", "rsrp", ...REE_CHARTABLE],
  defaultCharts: DEFAULT_CHARTS,
  summaryColumnTiers: [
    // With the V2 power-stage columns.
    selectList([
      "created_at",
      "reporting_counter",
      "valid_sample_mask",
      ...DIAGNOSTIC_COLUMNS,
      ...REE_CHARTABLE,
    ]),
    // With the context columns.
    selectList([
      "created_at",
      "reporting_counter",
      "valid_sample_mask",
      ...DIAGNOSTIC_COLUMNS,
      ...withoutPower(REE_CHARTABLE),
    ]),
    // A table without them still charts the sensor channels.
    selectList(["created_at", "reporting_counter", "valid_sample_mask", ...REE_SENSOR_KEYS]),
  ],
  csvColumns: csvColumnsFor(REE_FIELDS),
  csvBasename: "payloads-ree",
  capabilities: {
    rawPayloadInspector: false,
    errorMask: true,
    byteSizeChart: false,
    diagnosticsCharts: true,
    deviceFilter: true,
    writable: true,
    remoteConfig: false,
  },
  // Enforced by the database, not by the frontend: an insert with any other UID
  // is rejected and the rejection is surfaced as-is. Also the list the ingestion
  // endpoint routes device payloads to REE by — keep it in step with the
  // database restriction.
  writeDeviceUids: ["00124B0038A83D90"],
};

/* ------------------------------------------------------------------ lookup */

export const PAYLOAD_SCHEMAS: Record<PayloadSchemaId, PayloadSchema> = {
  development: DEVELOPMENT_SCHEMA,
  ree: REE_SCHEMA,
};

/** The schema an environment's payload table follows, or null if unmapped. */
export function schemaForEnvironment(
  environment: string | null | undefined,
): PayloadSchema | null {
  const config = configForEnvironment(environment);
  return config ? PAYLOAD_SCHEMAS[config.schemaId] : null;
}

/** Read one column off a row of either schema, without widening its type. */
export function columnValue(row: PayloadRow, key: string): unknown {
  return (row as unknown as Record<string, unknown>)[key];
}

/** Read one column as a finite number, or null for anything missing. */
export function numericValue(row: PayloadRow, key: string): number | null {
  const value = columnValue(row, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function fieldOf(
  schema: PayloadSchema,
  key: string,
): PayloadFieldDef | undefined {
  return schema.fields.find((field) => field.key === key);
}

/** Field groups in declaration order, each with its fields. */
export function fieldGroups(
  schema: PayloadSchema,
): { group: string; fields: PayloadFieldDef[] }[] {
  const groups: { group: string; fields: PayloadFieldDef[] }[] = [];
  for (const field of schema.fields) {
    const existing = groups.find((g) => g.group === field.group);
    if (existing) existing.fields.push(field);
    else groups.push({ group: field.group, fields: [field] });
  }
  return groups;
}

/** Label with its unit appended, e.g. "Ambient Temperature (°C)". */
export function fieldLabel(field: PayloadFieldDef): string {
  return field.unit ? `${field.label} (${field.unit})` : field.label;
}

/**
 * Whether a row's reading for this field is a measurement.
 *
 * False only when the row carries a `valid_sample_mask` whose governing bit is
 * clear: the firmware then transmits 0 for those channels and the protocol
 * document says to discard them. A field with no governing bit, or a row with
 * no mask, is always a reading.
 */
export function isReadingValid(row: PayloadRow, field: PayloadFieldDef): boolean {
  if (field.validBit === undefined) return true;
  const mask = (row as Partial<ReePayloadRecord>).valid_sample_mask;
  if (typeof mask !== "number" || !Number.isFinite(mask)) return true;
  return ((mask >>> 0) & (1 << field.validBit)) !== 0;
}
