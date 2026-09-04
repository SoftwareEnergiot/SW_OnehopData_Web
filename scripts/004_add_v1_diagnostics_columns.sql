-- Promote the V1 battery and radio diagnostics from the `context` JSONB into
-- real, indexable columns.
--
-- These are GENERATED ... STORED columns: Postgres derives each value from the
-- `context` object that the ingest endpoint already writes, so no application
-- code changes and no backfill is needed — existing rows are populated when the
-- column is added. Never write to these columns directly; change `context` and
-- they follow.
--
-- V0 payloads have no such fields, so `context->>'…'` is NULL for them and the
-- generated value is NULL too. The dashboard renders those as gaps rather than
-- as zeros.
--
-- Unlike scripts/003, this migration is NOT deployment-order sensitive: the
-- insert never names these columns, so the application works whether or not the
-- script has run. Only the battery and coverage charts need it.

ALTER TABLE payloads
  -- Fuel-gauge state of charge, 0-100. A genuine 0 means a flat battery, so it
  -- is a real reading and not treated as "missing" anywhere.
  ADD COLUMN IF NOT EXISTS battery_soc SMALLINT
    GENERATED ALWAYS AS ((context->>'battery_soc')::smallint) STORED,

  -- Measured VBAT in mV. Valid even when the fuel gauge fails, which is why it
  -- is worth keeping alongside the state of charge.
  ADD COLUMN IF NOT EXISTS battery_voltage INTEGER
    GENERATED ALWAYS AS ((context->>'battery_voltage')::integer) STORED,

  -- Reference signal received power, dBm. Negative, roughly -140 to -44.
  -- The firmware sends 0 for "not available", so 0 is excluded from the
  -- coverage statistics rather than plotted as an unusually strong signal.
  ADD COLUMN IF NOT EXISTS rsrp SMALLINT
    GENERATED ALWAYS AS ((context->>'rsrp')::smallint) STORED,

  -- Signal-to-noise ratio, dB, roughly -20 to +30. 0 also means "not available".
  ADD COLUMN IF NOT EXISTS snr SMALLINT
    GENERATED ALWAYS AS ((context->>'snr')::smallint) STORED,

  -- Last cellular error: 0 none, 1 attach, 2 HTTP connect, 3 HTTP request,
  -- 4 sleep, 5 clock, 6 unknown. See COMM_ERRORS in lib/payload-errors.ts.
  ADD COLUMN IF NOT EXISTS last_communication_error SMALLINT
    GENERATED ALWAYS AS ((context->>'last_communication_error')::smallint) STORED;

-- Partial indexes: every V0 row is NULL in these columns, so there is no point
-- indexing them. "Which devices dropped below 25 %" and "when did coverage go
-- bad" are the queries these serve.
CREATE INDEX IF NOT EXISTS idx_payloads_battery_soc
  ON payloads(battery_soc) WHERE battery_soc IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payloads_rsrp
  ON payloads(rsrp) WHERE rsrp IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payloads_last_communication_error
  ON payloads(last_communication_error)
  WHERE last_communication_error IS NOT NULL AND last_communication_error <> 0;

COMMENT ON COLUMN payloads.battery_soc IS
  'V1 context battery_soc (%), generated from context. NULL for V0 payloads.';
COMMENT ON COLUMN payloads.battery_voltage IS
  'V1 context battery_voltage (mV), generated from context. NULL for V0 payloads.';
COMMENT ON COLUMN payloads.rsrp IS
  'V1 context RSRP (dBm), generated from context. 0 means not available. NULL for V0 payloads.';
COMMENT ON COLUMN payloads.snr IS
  'V1 context SNR (dB), generated from context. 0 means not available. NULL for V0 payloads.';
COMMENT ON COLUMN payloads.last_communication_error IS
  'V1 context last cellular error enum, generated from context. NULL for V0 payloads.';
