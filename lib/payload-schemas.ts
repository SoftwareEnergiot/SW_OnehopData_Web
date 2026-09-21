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

import { CSV_COLUMNS, type CsvColumn } from "@/lib/payload-csv";
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
  | "sampleTime"; // uint32 seconds, UTC epoch or since boot (see below)

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
  /** Field keys shown as columns of the list view, in order. */
  listColumns: string[];
  /** Field keys offered as chart series, in order. */
  chartSeries: string[];
  /** Series selected the first time the charts are opened. */
  defaultChartSeries: string[];
  /**
   * Column sets the summary endpoint tries, richest first. A tier naming a
   * column the database does not have is rejected with PostgREST 42703 and the
   * next one is tried, so an un-migrated database still charts what it can.
   */
  summaryColumnTiers: string[];
  csvColumns: CsvColumn[];
  /** Basename of an exported CSV. */
  csvBasename: string;
  capabilities: PayloadSchemaCapabilities;
  /**
   * Device UIDs the database accepts on insert, when it restricts them. Shown
   * to the user where the UI writes rows; never used to filter reads, and never
   * used to rewrite a UID the user typed.
   */
  writeDeviceUids?: string[];
}

/* ------------------------------------------------------- development schema */

const DEVELOPMENT_FIELDS: PayloadFieldDef[] = [
  { key: "id", label: "Row ID", kind: "mono", group: "Report", description: "Database row ID." },
  { key: "created_at", label: "Received", kind: "timestamp", group: "Report", description: "Database insertion timestamp." },
  { key: "device_uid", label: "Device UID", kind: "mono", group: "Report", protocolType: "uint8[8]", description: "Device IEEE 802.15.4 UID. Null for V0 payloads, which carry none." },
  { key: "payload_version", label: "Version", kind: "integer", group: "Report", protocolType: "uint8", description: "Payload format version." },
  { key: "sample_count", label: "Samples", kind: "integer", group: "Report", protocolType: "uint8", description: "Number of samples contained in the report." },
  { key: "error_mask", label: "Error mask", kind: "errorMask", group: "Report", protocolType: "uint32", description: "Active device error flags." },
  { key: "reporting_counter", label: "Counter", kind: "integer", group: "Report", protocolType: "uint32", description: "Monotonic report counter." },
  { key: "byte_length", label: "Bytes", kind: "integer", unit: "B", group: "Report", description: "Total received length in bytes." },
];

const BASE_SUMMARY_COLUMNS = "created_at,byte_length,reporting_counter,error_mask";

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
  listColumns: [
    "created_at",
    "device_uid",
    "payload_version",
    "sample_count",
    "error_mask",
    "reporting_counter",
    "byte_length",
  ],
  // Reception, size, counter, battery and coverage each already have a chart
  // tuned to what they mean, so the generic series picker is not offered here.
  chartSeries: [],
  defaultChartSeries: [],
  summaryColumnTiers: [
    // scripts/005: the reporting-loss counters.
    BASE_SUMMARY_COLUMNS +
      ",battery_soc,battery_voltage,rsrp,snr,reporting_lost_counter,tx_failed",
    // scripts/004: battery and radio diagnostics.
    BASE_SUMMARY_COLUMNS + ",battery_soc,battery_voltage,rsrp,snr",
    // Original schema only.
    BASE_SUMMARY_COLUMNS,
  ],
  csvColumns: CSV_COLUMNS,
  csvBasename: "payloads",
  capabilities: {
    rawPayloadInspector: true,
    errorMask: true,
    byteSizeChart: true,
    diagnosticsCharts: true,
    deviceFilter: true,
    writable: true,
  },
};

/* --------------------------------------------------------------- REE schema */

// Which valid_sample_mask bit governs which REE column. The bits themselves are
// the protocol's (VALID_SAMPLE_BITS in lib/payload-errors); only the column
// names differ, because payloads_REE spells two of them out in full.
const REE_VALID_BIT = {
  ambient: 0,
  luminosity: 1,
  accelerometer: 2,
  current1: 3,
  current2: 4,
  thermocouple1: 5,
  thermocouple2: 6,
  internal: 8,
} as const;

const REE_FIELDS: PayloadFieldDef[] = [
  // Database / report information.
  { key: "id", label: "Row ID", kind: "integer", group: "Report", description: "Database row ID." },
  { key: "created_at", label: "Received", kind: "timestamp", group: "Report", description: "Database insertion timestamp." },
  { key: "payload_version", label: "Payload version", kind: "integer", group: "Report", protocolType: "uint8", description: "Payload format version." },
  { key: "device_uid", label: "Device UID", kind: "mono", group: "Report", protocolType: "text", description: "Device IEEE 802.15.4 UID." },
  { key: "sample_count", label: "Sample count", kind: "integer", group: "Report", protocolType: "uint8", description: "Number of samples contained in the report." },
  { key: "reporting_counter", label: "Reporting counter", kind: "integer", group: "Report", protocolType: "uint32", description: "Monotonic report counter." },

  // Sample information.
  {
    key: "sample_time",
    label: "Sample time",
    unit: "s",
    kind: "sampleTime",
    group: "Sample",
    protocolType: "uint32",
    description:
      "Sample timestamp. Depending on the device's clock status this is either UTC epoch seconds or seconds since boot. payloads_REE carries no status-flags column to choose between them, so both readings are shown rather than one being guessed at.",
  },

  // Temperature.
  { key: "thermocouple_1", label: "Thermocouple 1", unit: "°C", kind: "number", decimals: 1, group: "Temperature", description: "Cable temperature, probe 1.", validBit: REE_VALID_BIT.thermocouple1, chartable: true },
  { key: "thermocouple_2", label: "Thermocouple 2", unit: "°C", kind: "number", decimals: 1, group: "Temperature", description: "Cable temperature, probe 2.", validBit: REE_VALID_BIT.thermocouple2, chartable: true },
  { key: "current_1_internal_temperature", label: "Current Sensor 1 Internal Temperature", unit: "°C", kind: "number", decimals: 1, group: "Temperature", description: "Die/internal temperature of magnetic sensor 1.", validBit: REE_VALID_BIT.current1, chartable: true },
  { key: "current_2_internal_temperature", label: "Current Sensor 2 Internal Temperature", unit: "°C", kind: "number", decimals: 1, group: "Temperature", description: "Die/internal temperature of magnetic sensor 2.", validBit: REE_VALID_BIT.current2, chartable: true },
  { key: "ambient_temperature", label: "Ambient Temperature", unit: "°C", kind: "number", decimals: 1, group: "Temperature", description: "Temperature outside the enclosure.", validBit: REE_VALID_BIT.ambient, chartable: true },
  { key: "internal_temperature", label: "Internal Temperature", unit: "°C", kind: "number", decimals: 1, group: "Temperature", description: "Temperature inside the enclosure.", validBit: REE_VALID_BIT.internal, chartable: true },

  // Humidity.
  { key: "ambient_humidity", label: "Ambient Humidity", unit: "%RH", kind: "number", decimals: 1, group: "Humidity", description: "Humidity outside the enclosure.", validBit: REE_VALID_BIT.ambient, chartable: true },
  { key: "internal_humidity", label: "Internal Humidity", unit: "%RH", kind: "number", decimals: 1, group: "Humidity", description: "Humidity inside the enclosure.", validBit: REE_VALID_BIT.internal, chartable: true },

  // Luminosity.
  { key: "luminosity", label: "Luminosity", unit: "lux", kind: "integer", group: "Luminosity", description: "Ambient light.", validBit: REE_VALID_BIT.luminosity, chartable: true },

  // Acceleration.
  { key: "acceleration_x", label: "Acceleration X", unit: "mg", kind: "integer", group: "Acceleration", validBit: REE_VALID_BIT.accelerometer, chartable: true },
  { key: "acceleration_y", label: "Acceleration Y", unit: "mg", kind: "integer", group: "Acceleration", validBit: REE_VALID_BIT.accelerometer, chartable: true },
  { key: "acceleration_z", label: "Acceleration Z", unit: "mg", kind: "integer", group: "Acceleration", validBit: REE_VALID_BIT.accelerometer, chartable: true },

  // Magnetic field.
  { key: "magnetic_field_1", label: "Magnetic Field 1", unit: "µT", kind: "integer", group: "Magnetic field", description: "RMS magnetic field from sensor 1.", validBit: REE_VALID_BIT.current1, chartable: true },
  { key: "magnetic_field_2", label: "Magnetic Field 2", unit: "µT", kind: "integer", group: "Magnetic field", description: "RMS magnetic field from sensor 2.", validBit: REE_VALID_BIT.current2, chartable: true },

  // Validity.
  { key: "valid_sample_mask", label: "Valid Sample Mask", kind: "sampleMask", group: "Validity", description: "Bitmask indicating which sensor measurements were successfully acquired." },
];

const REE_MEASUREMENT_KEYS = REE_FIELDS.filter((field) => field.chartable).map(
  (field) => field.key,
);

// A cell for the CSV export. A reading whose valid_sample_mask bit is clear is
// exported empty, never as the 0 the device transmitted: a spreadsheet would
// otherwise average "no measurement" in with real ones.
function reeCell(field: PayloadFieldDef) {
  return (row: PayloadRow): string => {
    const value = columnValue(row, field.key);
    if (value === null || value === undefined) return "";
    if (!isReadingValid(row, field)) return "";
    return String(value);
  };
}

const REE_CSV_COLUMNS: CsvColumn[] = REE_FIELDS.map((field) => ({
  key: field.key,
  label: field.unit ? `${field.label} (${field.unit})` : field.label,
  value: reeCell(field),
}));

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
  listColumns: [
    "created_at",
    "device_uid",
    "payload_version",
    "sample_time",
    "ambient_temperature",
    "ambient_humidity",
    "reporting_counter",
    "valid_sample_mask",
  ],
  chartSeries: REE_MEASUREMENT_KEYS,
  defaultChartSeries: [
    "ambient_temperature",
    "internal_temperature",
    "ambient_humidity",
    "luminosity",
  ],
  summaryColumnTiers: [
    [
      "created_at",
      "reporting_counter",
      "valid_sample_mask",
      ...REE_MEASUREMENT_KEYS,
    ].join(","),
  ],
  csvColumns: REE_CSV_COLUMNS,
  csvBasename: "payloads-ree",
  capabilities: {
    rawPayloadInspector: false,
    errorMask: false,
    byteSizeChart: false,
    diagnosticsCharts: false,
    deviceFilter: true,
    writable: true,
  },
  // Enforced by the database, not by the frontend: an insert with any other UID
  // is rejected and the rejection is surfaced as-is.
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
