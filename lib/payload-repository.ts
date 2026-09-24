// The one place the application decides which table a payload request reads or
// writes. Every API route goes through here, so no route — and no component —
// ever names a payload table itself.
//
// Resolution is deliberately strict: an environment is valid only when the
// application has a data source mapped for it (lib/environments). Anything else
// is an error the caller must report — there is no fallback to another
// environment, because quietly serving REE a page of Development rows is worse
// than an error message.
//
// Resolution does NOT re-read `public.environment` on every request. That table
// is what the *selector* offers (GET /api/environments), and the provider drops
// a persisted choice the moment the table stops listing it — so a user can only
// ever be inside an environment the database named. Making the payload
// endpoints depend on the same read would mean that losing access to one small
// reference table takes down device ingestion, which writes payloads that
// cannot be re-sent. The mapping is the authority for "which table", the
// database is the authority for "which environments exist", and neither job
// needs the other on the hot path.

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ENVIRONMENT_CONFIG,
  ENVIRONMENT_PARAM,
  INGEST_DEFAULT_ENVIRONMENT,
  REE_ENVIRONMENT,
  configForEnvironment,
  type EnvironmentRecord,
} from "@/lib/environments";
import {
  PAYLOAD_SCHEMAS,
  schemaForEnvironment,
  type PayloadSchema,
} from "@/lib/payload-schemas";

/** Table holding the environments the user may choose from. */
export const ENVIRONMENT_TABLE = "environment";

// Supabase's generated types are not wired up in this project, so the client is
// used untyped — the same way lib/supabase/* hands it out.
type Client = SupabaseClient;

export interface ResolvedEnvironment {
  /** The environment name as the request gave it. */
  environment: string;
  /** Exact PostgREST table identifier for this environment's payloads. */
  table: string;
  schema: PayloadSchema;
}

export interface EnvironmentResolutionError {
  /** HTTP status the caller should answer with. */
  status: number;
  error: string;
  details: string;
}

export type EnvironmentResolution =
  | { ok: true; value: ResolvedEnvironment }
  | { ok: false; error: EnvironmentResolutionError };

/**
 * The environments on offer, newest last (name order — the table is tiny).
 *
 * Reads `public.environment` through the caller's Supabase client, so the
 * project's existing RLS rules decide what comes back.
 */
export async function listEnvironments(
  supabase: Client,
): Promise<{ data: EnvironmentRecord[]; error: string | null }> {
  const { data, error } = await supabase
    .from(ENVIRONMENT_TABLE)
    .select("name,production,created_at")
    .order("production", { ascending: false })
    .order("name", { ascending: true });

  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as EnvironmentRecord[], error: null };
}

/**
 * Resolve the environment named by a request into its payload data source.
 *
 * `name` is the raw `?environment=` value. It must name a row of
 * `public.environment` that the application has a mapping for; anything else
 * comes back as an error, never as a different environment's data.
 */
export function resolveEnvironment(
  name: string | null | undefined,
): EnvironmentResolution {
  const requested = name?.trim() ?? "";

  if (requested === "") {
    return {
      ok: false,
      error: {
        status: 400,
        error: "Missing environment",
        details: `This endpoint needs an "${ENVIRONMENT_PARAM}" parameter naming one of the environments in public.${ENVIRONMENT_TABLE}.`,
      },
    };
  }

  const config = configForEnvironment(requested);
  const schema = schemaForEnvironment(requested);
  if (!config || !schema) {
    return {
      ok: false,
      error: {
        status: 404,
        error: "Unknown environment",
        details: `This application has no payload data source mapped for "${requested}". Known environments: ${Object.keys(
          ENVIRONMENT_CONFIG,
        ).join(", ")}.`,
      },
    };
  }

  return {
    ok: true,
    value: {
      environment: requested,
      table: config.payloadTable,
      schema,
    },
  };
}

/* ------------------------------------------------- device-based ingest routing */

/** The 16 hex digits of a UID, uppercase and unseparated. */
export function canonicalUid(uid: string | null | undefined): string | null {
  if (!uid) return null;
  const hex = uid.replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
  return hex.length === 16 ? hex : null;
}

/**
 * Which environment an *unaddressed* incoming payload belongs to.
 *
 * Devices POST to the ingestion endpoint without naming an environment, so the
 * endpoint decides from the payload itself: a decoded device UID listed in the
 * REE schema's `writeDeviceUids` routes the payload to `payloads_REE`. Anything
 * else — a different device, or a payload with no UID at all (V0) — goes to
 * `public.payloads`, which is where every payload has always landed.
 *
 * The list is fixed in code on purpose. Reading the reference UID back from
 * `payloads_REE` made routing depend on the table it is meant to fill: while it
 * was empty (or hidden from the anon role) nothing could ever match, so every
 * report of the REE device went to Development and the table never got its
 * first row.
 *
 * This never applies to a request that names an environment explicitly: an
 * explicit choice is the caller's, and a write it rejects must be reported
 * rather than redirected to another table.
 */
export function environmentForDeviceUid(deviceUid: string | null): string {
  const incoming = canonicalUid(deviceUid);
  if (!incoming) return INGEST_DEFAULT_ENVIRONMENT;

  const reeDevices = PAYLOAD_SCHEMAS.ree.writeDeviceUids ?? [];
  if (reeDevices.some((uid) => canonicalUid(uid) === incoming)) {
    return REE_ENVIRONMENT;
  }

  return INGEST_DEFAULT_ENVIRONMENT;
}

/* ------------------------------------------------------------ device listing */

// PostgREST caps a single request; walk the rows in chunks.
const DEVICE_SCAN_CHUNK = 1000;
// Hard ceiling on rows scanned, so a large table can never make a device list
// slow. Devices only seen before the most recent rows are missing from the
// list, which the result says via `truncated`.
const DEVICE_SCAN_MAX_ROWS = 20000;

export interface DeviceSummary {
  /** The UID as the environment's table stores it. */
  device_uid: string;
  /** Rows from this device within the scanned rows. */
  payloads: number;
  /** Most recent reception, ISO 8601. */
  last_seen: string;
}

export interface DeviceScan {
  /** Most recently seen first. */
  devices: DeviceSummary[];
  /** At least one scanned row has no UID (V0). */
  withoutUid: boolean;
  truncated: boolean;
}

/**
 * The distinct device UIDs that have sent payloads to an environment's table.
 *
 * There is no DISTINCT over the REST API without adding a database function, so
 * this scans only the device and timestamp columns, newest first, and folds
 * them. Throws with the database's message on a query error.
 */
export async function scanDevices(
  supabase: Client,
  table: string,
  schema: PayloadSchema,
): Promise<DeviceScan> {
  // A schema with no device column has no device list to offer.
  if (!schema.deviceKey) return { devices: [], withoutUid: false, truncated: false };

  const deviceKey = schema.deviceKey;
  const receivedKey = schema.receivedKey;
  const devices = new Map<string, DeviceSummary>();
  let withoutUid = false;
  let truncated = false;

  for (let offset = 0; offset < DEVICE_SCAN_MAX_ROWS; offset += DEVICE_SCAN_CHUNK) {
    const { data, error } = await supabase
      .from(table)
      .select(`${deviceKey},${receivedKey}`)
      .order(receivedKey, { ascending: false })
      .range(offset, offset + DEVICE_SCAN_CHUNK - 1);

    if (error) throw new Error(error.message);

    for (const row of (data ?? []) as unknown as Record<string, string | null>[]) {
      const uid = row[deviceKey];
      if (!uid) {
        withoutUid = true;
        continue;
      }
      const known = devices.get(uid);
      if (known) {
        known.payloads += 1;
      } else {
        // Rows arrive newest first, so the first one seen is the last seen.
        devices.set(uid, {
          device_uid: uid,
          payloads: 1,
          last_seen: row[receivedKey] ?? "",
        });
      }
    }

    if (!data || data.length < DEVICE_SCAN_CHUNK) break;
    if (offset + DEVICE_SCAN_CHUNK >= DEVICE_SCAN_MAX_ROWS) truncated = true;
  }

  return { devices: Array.from(devices.values()), withoutUid, truncated };
}

/** The remote-config fields of a device's most recent payload. */
export interface LatestConfigReport {
  received_at: string;
  /** CRC32 of the config the device runs. Null when the payload's format has none. */
  config_crc32: number | null;
  /** Result of the device's last config poll. Null when the format has none. */
  last_poll_status: number | null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

/**
 * `config_crc32` and `last_poll_status` of the newest payload of one device.
 *
 * `payloads_REE` stores them as columns; `payloads` keeps them in the `context`
 * JSONB. Either is null for a payload whose format predates them (V1 before
 * the 93-byte revision), and for REE rows stored before the context columns.
 * `storedUid` must be in the table's own UID format.
 */
export async function latestConfigReport(
  supabase: Client,
  table: string,
  schema: PayloadSchema,
  storedUid: string,
): Promise<LatestConfigReport | null> {
  if (!schema.deviceKey) return null;

  const columns =
    schema.id === "ree"
      ? `${schema.receivedKey},config_crc32,last_poll_status`
      : `${schema.receivedKey},config_crc32:context->config_crc32,last_poll_status:context->last_poll_status`;

  const { data, error } = await supabase
    .from(table)
    .select(columns)
    .eq(schema.deviceKey, storedUid)
    .order(schema.receivedKey, { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const row = data as unknown as Record<string, unknown>;
  return {
    received_at: String(row[schema.receivedKey] ?? ""),
    config_crc32: asNumber(row.config_crc32),
    last_poll_status: asNumber(row.last_poll_status),
  };
}

/* ------------------------------------------------------------- remote config */

const REMOTE_CONFIG_UNAVAILABLE =
  "Remote config is only available in the Development environment.";

/**
 * Why the Remote config endpoints must refuse this environment, or null when
 * its schema offers them. The tab is hidden there too; this is the server's
 * own check, so a direct API call gets the same answer.
 */
export function remoteConfigUnavailable(
  resolved: ResolvedEnvironment,
): EnvironmentResolutionError | null {
  if (resolved.schema.capabilities.remoteConfig) return null;
  return {
    status: 403,
    error: "Remote config not available",
    details: `${REMOTE_CONFIG_UNAVAILABLE} "${resolved.environment}" does not offer it.`,
  };
}

/**
 * Why a device must not be given a remote config, or null. A device whose
 * reports are routed to an environment without remote config (the REE devices)
 * is refused whatever environment the request names.
 */
export function remoteConfigRefusedForDevice(
  deviceUid: string,
): EnvironmentResolutionError | null {
  const home = resolveEnvironment(environmentForDeviceUid(deviceUid));
  if (!home.ok || home.value.schema.capabilities.remoteConfig) return null;
  return {
    status: 403,
    error: "Remote config not available for this device",
    details: `${deviceUid} reports to ${home.value.environment}. ${REMOTE_CONFIG_UNAVAILABLE}`,
  };
}
