-- Create the payloads table that stores every received LoRaWAN V0 binary
-- payload together with its decoded form. Column names match the application
-- code (lib/types.ts / app/api/payloads/route.ts).
CREATE TABLE IF NOT EXISTS payloads (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload_hex       TEXT NOT NULL,              -- raw payload, continuous lowercase hex
  payload_binary    TEXT,                       -- raw payload as space-separated bits (optional)
  byte_length       INTEGER NOT NULL,           -- total received length in bytes
  payload_version   SMALLINT NOT NULL,          -- header: payload id / version (uint8)
  sample_count      SMALLINT NOT NULL,          -- header: sample count (uint8)
  samples           JSONB NOT NULL,             -- decoded sample array
  context           JSONB NOT NULL,             -- decoded batch context { error_mask, reporting_counter }
  error_mask        BIGINT NOT NULL,            -- context: error mask (uint32)
  errors            JSONB NOT NULL,             -- resolved error catalog entries
  reporting_counter BIGINT NOT NULL,            -- context: reporting counter (uint32)
  source_ip         TEXT,                       -- source metadata (x-forwarded-for / x-real-ip)
  source_user_agent TEXT                        -- source metadata (user-agent)
);

-- Indexes for common queries.
CREATE INDEX IF NOT EXISTS idx_payloads_created_at ON payloads(created_at);
CREATE INDEX IF NOT EXISTS idx_payloads_payload_version ON payloads(payload_version);
CREATE INDEX IF NOT EXISTS idx_payloads_error_mask ON payloads(error_mask);
CREATE INDEX IF NOT EXISTS idx_payloads_reporting_counter ON payloads(reporting_counter);

-- Row Level Security.
ALTER TABLE payloads ENABLE ROW LEVEL SECURITY;

-- Allow unauthenticated devices to insert decoded payloads.
DROP POLICY IF EXISTS "Allow public insert" ON payloads;
CREATE POLICY "Allow public insert" ON payloads FOR INSERT WITH CHECK (true);

-- Allow anyone to read payloads (for the dashboard).
DROP POLICY IF EXISTS "Allow public read" ON payloads;
CREATE POLICY "Allow public read" ON payloads FOR SELECT USING (true);
