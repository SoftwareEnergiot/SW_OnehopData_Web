-- Add the device UID carried by the V1 payload header.
--
-- V0 payloads have no UID, so the column is nullable and every row stored
-- before this migration keeps a NULL: the dashboard renders those as "—".
-- The value is the 8-byte factory IEEE 802.15.4 MAC formatted the way the
-- protocol document prints it — uppercase hex, colon separated, in wire order
-- (e.g. '00:12:4B:00:1A:2B:3C:4D').
--
-- Run this BEFORE deploying the code that writes the column: the payload
-- insert names device_uid explicitly, so against an un-migrated table every
-- insert is rejected. Storage failures are silent by design (the endpoint
-- still answers 204), so the symptom would be payloads that decode but never
-- appear in the dashboard.
ALTER TABLE payloads ADD COLUMN IF NOT EXISTS device_uid TEXT;

-- Per-device lookups and the "payloads from device X" filter.
CREATE INDEX IF NOT EXISTS idx_payloads_device_uid ON payloads(device_uid);

COMMENT ON COLUMN payloads.device_uid IS
  'V1+ header device UID (factory IEEE 802.15.4 MAC), uppercase colon-separated hex. NULL for V0 payloads.';
