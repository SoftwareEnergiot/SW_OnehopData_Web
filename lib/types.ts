import type { DecodedSample, DecodedContext } from "@/lib/payload-decoder";
import type { ResolvedError } from "@/lib/payload-errors";

// A stored payload row as returned by the API / Supabase.
export interface PayloadRecord {
  id: string;
  created_at: string;
  payload_hex: string;
  payload_binary: string | null;
  byte_length: number;
  payload_version: number;
  // Header device UID, "00:12:4B:…" — V1 and later only. Null for the V0 rows
  // stored before the format carried one.
  device_uid: string | null;
  sample_count: number;
  samples: DecodedSample[];
  context: DecodedContext;
  error_mask: number;
  errors: ResolvedError[];
  reporting_counter: number;
  // V1 battery and radio diagnostics. These are columns generated from
  // `context` by scripts/004 — the ingest endpoint never writes them directly.
  // Null for V0 payloads, and absent entirely if that migration has not run.
  battery_soc: number | null;
  battery_voltage: number | null;
  /** RSRP in dBm; 0 means "not available". */
  rsrp: number | null;
  /** SNR in dB; 0 means "not available". */
  snr: number | null;
  last_communication_error: number | null;
  // Counters since boot, added by the V1 context revision (36 -> 40 bytes) and
  // exposed as columns by scripts/005. Read them as a delta between consecutive
  // reports of the same boot session.
  reporting_lost_counter: number | null;
  tx_failed: number | null;
  // V2 power stage, generated from `context` like the columns above. Null for
  // V1 rows, and for a reading the device could not take.
  vin_mv?: number | null;
  uvlos_mask?: number | null;
  uvlos_rising_v?: number | null;
  uvlos_window?: "short" | "wide" | null;
  supercaps_connected?: boolean | null;
  eh_active?: boolean | null;
  source_ip: string | null;
  source_user_agent: string | null;
}

// Shape returned by GET /api/payloads (list view).
export interface PayloadListResponse {
  success: boolean;
  data: PayloadRecord[];
  total: number;
  limit: number;
  offset: number;
}

// POST /api/payloads returns no body — the outcome is the HTTP status alone
// (204 accepted, 4xx decode failure, 500 unexpected error).

// A stored REE sample row, as returned by the API / Supabase. One row is one
// already-decoded sample — `payloads_REE` holds no raw frame, so there is no
// payload_hex and no byte_length here. The report's batch context is stored
// one column per field; those columns are null on rows stored before they were
// added. Every sensor column is nullable; a reading whose `valid_sample_mask`
// bit is clear was transmitted as 0 and must be discarded (see isReadingValid).
export interface ReePayloadRecord {
  id: number;
  created_at: string;
  payload_version: number;
  device_uid: string;
  sample_count: number;
  reporting_counter: number;
  sample_time: number;
  thermocouple_1: number | null;
  thermocouple_2: number | null;
  current_1_internal_temperature: number | null;
  current_2_internal_temperature: number | null;
  ambient_temperature: number | null;
  internal_temperature: number | null;
  ambient_humidity: number | null;
  internal_humidity: number | null;
  luminosity: number | null;
  acceleration_x: number | null;
  acceleration_y: number | null;
  acceleration_z: number | null;
  magnetic_field_1: number | null;
  magnetic_field_2: number | null;
  valid_sample_mask: number | null;
  // V1 batch context, one column per field.
  error_mask: number | null;
  last_communication_error: number | null;
  battery_soc: number | null;
  battery_voltage: number | null;
  config_crc32: number | null;
  boot_count: number | null;
  reset_source: number | null;
  /** RSRP in dBm; 0 means "not available". */
  rsrp: number | null;
  /** SNR in dB; 0 means "not available". */
  snr: number | null;
  status_flags: number | null;
  tau: number | null;
  active_time: number | null;
  last_attach_duration_ms: number | null;
  last_tx_duration_ms: number | null;
  reporting_lost_counter: number | null;
  tx_failed: number | null;
  last_poll_status: number | null;
  // V2 power stage, decoded. Null on V1 rows, and for a reading the device
  // could not take.
  vin_mv?: number | null;
  uvlos_mask?: number | null;
  uvlos_rising_v?: number | null;
  uvlos_window?: "short" | "wide" | null;
  supercaps_connected?: boolean | null;
  eh_active?: boolean | null;
}

// Either environment's row shape. Schema-driven views read columns by key, so
// they work against whichever of the two the active environment selects.
export type PayloadRow = PayloadRecord | ReePayloadRecord;

// Shape returned by GET /api/payloads for any environment.
export interface PayloadRowsResponse {
  success: boolean;
  environment: string;
  table: string;
  data: PayloadRow[];
  total: number;
  limit: number;
  offset: number;
}
