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
  sample_count: number;
  samples: DecodedSample[];
  context: DecodedContext;
  error_mask: number;
  errors: ResolvedError[];
  reporting_counter: number;
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
