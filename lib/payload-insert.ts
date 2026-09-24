// Turning a decoded payload into the rows the active environment's table
// expects. Kept out of the route so both shapes can be unit-tested directly.

import {
  V1_CONTEXT_FIELDS,
  V1_LAYOUT,
  V1_SAMPLE_FIELDS,
  type PayloadAnalysis,
} from "@/lib/payload-decoder";
import type { PayloadSchema } from "@/lib/payload-schemas";

/** Source metadata the ingest endpoint records alongside a Development row. */
export interface IngestSource {
  ip: string | null;
  userAgent: string | null;
}

export class PayloadInsertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadInsertError";
  }
}

/**
 * Why a decoded payload is not accepted for storage, or null when it is.
 *
 * Only the current V1 format is accepted, in every environment: V0 and the
 * earlier 82/86-byte V1 revisions still decode (so stored rows and the
 * Playground can show them), but a frame in any of them is discarded. Every
 * accepted payload therefore carries a device UID.
 */
export function unsupportedFormat(analysis: PayloadAnalysis): string | null {
  const { decoded, meta } = analysis;
  if (decoded.layout_revision !== V1_LAYOUT.revision) {
    return `Only the current V1 format (${V1_LAYOUT.label}) is accepted; this payload is ${meta.revisionLabel}.`;
  }
  if (!decoded.device_uid) {
    return "Every payload must carry a device UID.";
  }
  return null;
}

/**
 * `payloads` stores the whole received frame: the raw bytes plus the decoded
 * JSON, exactly as it always has.
 */
function developmentRows(
  analysis: PayloadAnalysis,
  source: IngestSource,
): Record<string, unknown>[] {
  const { decoded } = analysis;
  return [
    {
      payload_hex: analysis.hex,
      payload_binary: analysis.binary,
      byte_length: analysis.meta.byteLength,
      payload_version: decoded.payload_version,
      // Null for V0, which carries no UID. Requires scripts/003 to have been
      // run against the database.
      device_uid: decoded.device_uid,
      sample_count: decoded.sample_count,
      samples: decoded.samples,
      context: decoded.context,
      error_mask: decoded.error_mask,
      errors: decoded.errors,
      reporting_counter: decoded.reporting_counter,
      source_ip: source.ip,
      source_user_agent: source.userAgent,
    },
  ];
}

// Scaling divisor per V1 sample channel (raw / factor = engineering value), so
// the REE mapping below cannot drift from the decoder's own field table.
const V1_FACTOR = new Map(V1_SAMPLE_FIELDS.map((f) => [f.key, f.factor]));

/**
 * V1 sample channel -> `payloads_REE` column.
 *
 * Every column of the REE table has exactly one V1 channel behind it; two are
 * spelled out in full there (`current_N_internal_temperature`) where the
 * protocol abbreviates them. Nothing is invented and nothing is dropped.
 */
const REE_COLUMN_FOR_CHANNEL: Record<string, string> = {
  thermocouple_1: "thermocouple_1",
  thermocouple_2: "thermocouple_2",
  current_1_int_temp: "current_1_internal_temperature",
  current_2_int_temp: "current_2_internal_temperature",
  ambient_temperature: "ambient_temperature",
  internal_temperature: "internal_temperature",
  ambient_humidity: "ambient_humidity",
  internal_humidity: "internal_humidity",
  luminosity: "luminosity",
  acceleration_x: "acceleration_x",
  acceleration_y: "acceleration_y",
  acceleration_z: "acceleration_z",
  magnetic_field_1: "magnetic_field_1",
  magnetic_field_2: "magnetic_field_2",
  valid_sample_mask: "valid_sample_mask",
};

/**
 * V1 context fields, each stored in the `payloads_REE` column of the same name.
 * Read from the decoder's own field table, so the two cannot drift.
 */
export const REE_CONTEXT_COLUMNS: string[] = V1_CONTEXT_FIELDS.map((f) => f.key);

/** The 16 hex digits of a UID, uppercase and unseparated — REE's stored form. */
function plainUid(uid: string): string {
  return uid.replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
}

/**
 * `payloads_REE` stores one *decoded sample* per row, no raw frame. A report of
 * N samples becomes N rows sharing the report's header and context fields, each
 * context field in its own column (the V1 format of the REE devices is frozen).
 *
 * Only the current V1 revision maps: V0 carries neither a device UID nor these
 * channels, and the earlier V1 revisions carry no per-sample time, which
 * `payloads_REE.sample_time` requires and which must not be faked with a 0.
 * Those are rejected with a message that says exactly why.
 */
function reeRows(analysis: PayloadAnalysis): Record<string, unknown>[] {
  const { decoded } = analysis;

  if (decoded.device_uid === null) {
    throw new PayloadInsertError(
      `This payload (${analysis.meta.revisionLabel}) carries no device UID, and payloads_REE.device_uid is NOT NULL. Only the current V1 format can be stored in the REE environment.`,
    );
  }

  return decoded.samples.map((sample, index) => {
    const time = sample.time;
    if (typeof time !== "number") {
      throw new PayloadInsertError(
        `Sample ${index} of this payload (${analysis.meta.revisionLabel}) carries no sample time, and payloads_REE.sample_time is NOT NULL. Only the current V1 format, whose samples carry their read time, can be stored in the REE environment.`,
      );
    }

    const row: Record<string, unknown> = {
      payload_version: decoded.payload_version,
      device_uid: plainUid(decoded.device_uid as string),
      sample_count: decoded.sample_count,
      reporting_counter: decoded.reporting_counter,
      sample_time: time,
    };

    for (const [channel, column] of Object.entries(REE_COLUMN_FOR_CHANNEL)) {
      const raw = sample[channel];
      if (typeof raw !== "number") continue;
      const factor = V1_FACTOR.get(channel) ?? 1;
      // The REE temperature and humidity columns are float8 — engineering
      // values, not the raw counts the wire carries. The integer columns have a
      // factor of 1 and pass through untouched.
      row[column] = factor === 1 ? raw : raw / factor;
    }

    for (const column of REE_CONTEXT_COLUMNS) {
      row[column] = decoded.context[column];
    }

    return row;
  });
}

/**
 * The rows a decoded payload becomes in the given environment's table.
 *
 * Throws PayloadInsertError when the payload's format cannot be represented in
 * that table. The caller reports that as a request error — it never retries
 * against another environment.
 */
export function rowsForSchema(
  schema: PayloadSchema,
  analysis: PayloadAnalysis,
  source: IngestSource,
): Record<string, unknown>[] {
  switch (schema.id) {
    case "development":
      return developmentRows(analysis, source);
    case "ree":
      return reeRows(analysis);
  }
}
