-- Reference table for the error bitmask codes that may appear in
-- payloads.error_mask. Each row defines a single-bit flag; the mask value on a
-- payload is the OR of every active flag, so a value of 0x00000018 means both
-- ERR_RSN_SENSOR_HALL_EFFECT_1 (0x08) and ERR_RSN_SENSOR_HALL_EFFECT_2 (0x10)
-- are reported.
--
-- This is the SQL-side source of truth that mirrors lib/payload-errors.ts and
-- the "Error Codes" protocol document.
CREATE TABLE IF NOT EXISTS payload_error_codes (
  code        TEXT PRIMARY KEY,                  -- canonical "0x00000001" form
  bit_value   BIGINT NOT NULL UNIQUE,            -- numeric bit value (0 for ERR_RSN_NONE)
  name        TEXT NOT NULL UNIQUE,              -- e.g. ERR_RSN_SENSOR_AMBIENT
  description TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Index by name for joins that key off the symbolic identifier.
CREATE INDEX IF NOT EXISTS idx_payload_error_codes_name ON payload_error_codes(name);

-- Row Level Security: read-only for everyone (matches payloads).
ALTER TABLE payload_error_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public read" ON payload_error_codes;
CREATE POLICY "Allow public read" ON payload_error_codes FOR SELECT USING (true);

-- Seed every catalog entry. Re-runnable: ON CONFLICT keeps name/description
-- in sync with this script if the catalog evolves.
INSERT INTO payload_error_codes (code, bit_value, name, description) VALUES
  ('0x00000000', 0,      'ERR_RSN_NONE',                   'No error'),
  ('0x00000001', 1,      'ERR_RSN_SENSOR_AMBIENT',         'Cannot configure/read ambient sensor'),
  ('0x00000002', 2,      'ERR_RSN_SENSOR_LIGHT',           'Cannot configure/read light sensor'),
  ('0x00000004', 4,      'ERR_RSN_SENSOR_ACCELEROMETER',   'Cannot configure/read accelerometer sensor'),
  ('0x00000008', 8,      'ERR_RSN_SENSOR_HALL_EFFECT_1',   'Cannot configure/read hall effect sensor 1'),
  ('0x00000010', 16,     'ERR_RSN_SENSOR_HALL_EFFECT_2',   'Cannot configure/read hall effect sensor 2'),
  ('0x00000020', 32,     'ERR_RSN_SENSOR_CABLE_TEMP_1',    'Cannot configure/read cable temperature sensor 1'),
  ('0x00000040', 64,     'ERR_RSN_SENSOR_CABLE_TEMP_2',    'Cannot configure/read cable temperature sensor 2'),
  ('0x00000080', 128,    'ERR_RSN_SENSOR_CABLE_TEMP_3',    'Cannot configure/read cable temperature sensor 3'),
  ('0x00000100', 256,    'ERR_RSN_SENSOR_BUS_ADQUISITION', 'Sensor bus acquisition failed'),
  ('0x00000200', 512,    'ERR_RSN_COMM_OPEN',              'Cannot open communication interface'),
  ('0x00000400', 1024,   'ERR_RSN_COMM_SEND',              'Cannot send data'),
  ('0x00000800', 2048,   'ERR_RSN_CONFIG_INVALID',         'Configuration is invalid'),
  ('0x00001000', 4096,   'ERR_RSN_ENCODE_PAYLOAD',         'Cannot encode payload'),
  ('0x00002000', 8192,   'ERR_RSN_CONFIG_APPLY',           'Cannot apply configuration'),
  ('0x00004000', 16384,  'ERR_RSN_BAT_UNDER_75',           'Battery capacity under 75%'),
  ('0x00008000', 32768,  'ERR_RSN_BAT_UNDER_50',           'Battery capacity under 50%'),
  ('0x00010000', 65536,  'ERR_RSN_BAT_UNDER_25',           'Battery capacity under 25%'),
  ('0x00020000', 131072, 'ERR_RSN_BAT_DISABLED',           'Battery disabled as a precautionary measure'),
  ('0x00040000', 262144, 'ERR_RSN_BAT_STATUS_UNKNOWN',     'Can not determine the status of the battery.'),
  ('0x00080000', 524288, 'ERR_RSN_SCAP_UNBALANCED',        'Supercapacitors disconnected. Unbalanced detected.')
ON CONFLICT (code) DO UPDATE
  SET bit_value   = EXCLUDED.bit_value,
      name        = EXCLUDED.name,
      description = EXCLUDED.description;
