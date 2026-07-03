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

// Shape returned by POST /api/payloads after a successful ingest.
export interface PayloadIngestResponse {
  success: boolean;
  stored: boolean;
  id: string | null;
  meta: {
    byteLength: number;
    expectedLength: number;
    sampleCount: number;
    version: number;
  };
  hex: string;
  binary: string;
  header: {
    payload_version: number;
    sample_count: number;
  };
  samples: DecodedSample[];
  context: DecodedContext;
  error_mask: number;
  error_mask_hex: string;
  reporting_counter: number;
  errors: ResolvedError[];
}

// Error body returned when decoding fails.
export interface PayloadErrorResponse {
  success: false;
  error: string;
  code: string;
}
