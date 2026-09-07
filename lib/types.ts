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
