-- Promote the two counters added by the V1 context revision (36 -> 40 bytes)
-- out of the `context` JSONB into indexable columns.
--
-- OPTIONAL, and not deployment-order sensitive. The ingest endpoint never names
-- these columns: both fields already reach the database inside `context` the
-- moment the decoder understands them. This script only makes them cheap to
-- query and chart. Without it the application works normally and the reception
-- charts fall back to the columns that exist.
--
-- Same mechanism as scripts/004: GENERATED ... STORED columns derived from
-- `context`, populated for existing rows the moment they are added, NULL for V0
-- payloads and for V1 payloads stored before the firmware sent these fields.
-- Never write to them directly; change `context` and they follow.

ALTER TABLE payloads
  -- Reports that will never reach the server, accumulated since boot. Explains
  -- every gap in the reporting counter: a report is lost either because its
  -- transmission failed, or because it was overwritten in the outbox before the
  -- previous one could be sent.
  ADD COLUMN IF NOT EXISTS reporting_lost_counter INTEGER
    GENERATED ALWAYS AS ((context->>'reporting_lost_counter')::integer) STORED,

  -- Failed send attempts since boot. In this firmware release there are no
  -- transmission retries, so every failed attempt costs exactly one report and
  -- this tracks the lost counter; the two diverge only once retries exist.
  ADD COLUMN IF NOT EXISTS tx_failed INTEGER
    GENERATED ALWAYS AS ((context->>'tx_failed')::integer) STORED;

-- Both are counters since boot, so the useful query is "reports where the
-- counter moved", not an equality lookup. Partial indexes keep the V0 rows out.
CREATE INDEX IF NOT EXISTS idx_payloads_reporting_lost_counter
  ON payloads(reporting_lost_counter)
  WHERE reporting_lost_counter IS NOT NULL AND reporting_lost_counter > 0;
CREATE INDEX IF NOT EXISTS idx_payloads_tx_failed
  ON payloads(tx_failed)
  WHERE tx_failed IS NOT NULL AND tx_failed > 0;

COMMENT ON COLUMN payloads.reporting_lost_counter IS
  'V1 context reporting_lost_counter, generated from context. Counter since boot; read as a delta between consecutive reports of the same boot session. NULL for V0 payloads.';
COMMENT ON COLUMN payloads.tx_failed IS
  'V1 context tx_failed, generated from context. Counter since boot; read as a delta. NULL for V0 payloads.';
