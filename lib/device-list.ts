// The devices an environment's dashboard offers: its device filter and the
// Remote config tab.
//
// The list comes from `device_api_key`, the table of devices the platform knows
// (token hash -> UID, learned from every report that carries a Bearer token).
// It used to be folded out of the newest 20,000 payload rows, which at
// Development's ~5,000 rows a day only reached back four days: a device silent
// for five was not offered at all, although all its payloads were still there.

import type { SupabaseClient } from "@supabase/supabase-js";

import { DEVICE_TOKEN_TABLE } from "@/lib/device-auth";
import { normalizeDeviceUid } from "@/lib/payload-decoder";
import { formatDeviceUidFor } from "@/lib/payload-filters";
import { canonicalUid, environmentForDeviceUid } from "@/lib/payload-repository";
import type { PayloadSchema } from "@/lib/payload-schemas";

// PostgREST caps a single request; the key table is read in pages of this.
const KEY_PAGE = 1000;
// Newest payload rows read to spot reporting devices with no key yet (a report
// without a Bearer token) and payloads with no UID at all (V0).
const RECENT_ROWS = 1000;
// Devices whose newest payload is looked up at the same time.
const LOOKUP_CONCURRENCY = 10;

export interface DeviceSummary {
  /** The UID as the environment's table stores it. */
  device_uid: string;
  /** Newest payload of the device in this environment, ISO 8601; null if none. */
  last_seen: string | null;
}

export interface DeviceList {
  /** Most recently seen first; devices with no payload here last. */
  devices: DeviceSummary[];
  /** The newest payloads include one with no UID (V0). */
  withoutUid: boolean;
}

/** Every distinct canonical UID in `device_api_key`. Throws on a query error. */
export async function listKnownDeviceUids(supabase: SupabaseClient): Promise<string[]> {
  const uids = new Set<string>();
  for (let offset = 0; ; offset += KEY_PAGE) {
    const { data, error } = await supabase
      .from(DEVICE_TOKEN_TABLE)
      .select("device_uid")
      .order("device_uid", { ascending: true })
      .range(offset, offset + KEY_PAGE - 1);
    if (error) throw new Error(`${DEVICE_TOKEN_TABLE}: ${error.message}`);
    const rows = (data ?? []) as { device_uid: string | null }[];
    for (const row of rows) {
      const uid = canonicalUid(row.device_uid);
      if (uid) uids.add(uid);
    }
    if (rows.length < KEY_PAGE) break;
  }
  return Array.from(uids);
}

/**
 * The devices of one environment: those in `device_api_key` whose reports are
 * routed to it (the same rule ingestion applies, `environmentForDeviceUid`),
 * plus any device among its newest payloads that has no key yet, each with the
 * time of its newest payload there.
 *
 * Throws when `device_api_key` cannot be read. A failed last-seen lookup only
 * leaves that device's `last_seen` null.
 */
export async function listDevices(
  supabase: SupabaseClient,
  environment: string,
  table: string,
  schema: PayloadSchema,
): Promise<DeviceList> {
  // A schema with no device column has no device list to offer.
  const deviceKey = schema.deviceKey;
  if (!deviceKey) return { devices: [], withoutUid: false };
  const receivedKey = schema.receivedKey;

  const [known, recent] = await Promise.all([
    listKnownDeviceUids(supabase),
    supabase
      .from(table)
      .select(`${deviceKey},${receivedKey}`)
      .order(receivedKey, { ascending: false })
      .limit(RECENT_ROWS),
  ]);

  // Stored form -> newest payload, for the devices the recent rows already show.
  const lastSeen = new Map<string, string>();
  let withoutUid = false;
  const recentRows = (recent.error ? [] : recent.data ?? []) as unknown as Record<
    string,
    string | null
  >[];
  for (const row of recentRows) {
    const uid = row[deviceKey];
    if (!uid) withoutUid = true;
    else if (!lastSeen.has(uid)) lastSeen.set(uid, row[receivedKey] ?? "");
  }

  // The environment's devices, in the form its table stores them.
  const stored = new Set<string>(lastSeen.keys());
  for (const uid of known) {
    if (environmentForDeviceUid(uid) !== environment) continue;
    const display = normalizeDeviceUid(uid);
    if (display) stored.add(formatDeviceUidFor(display, schema.deviceUidFormat));
  }

  // The newest payload of every device the recent rows did not cover: one
  // indexed lookup each, a few at a time.
  const missing = Array.from(stored).filter((uid) => !lastSeen.has(uid));
  for (let i = 0; i < missing.length; i += LOOKUP_CONCURRENCY) {
    await Promise.all(
      missing.slice(i, i + LOOKUP_CONCURRENCY).map(async (uid) => {
        const { data, error } = await supabase
          .from(table)
          .select(receivedKey)
          .eq(deviceKey, uid)
          .order(receivedKey, { ascending: false })
          .limit(1);
        const seen = error
          ? null
          : ((data?.[0] as unknown as Record<string, string | null> | undefined)?.[receivedKey] ??
            null);
        if (seen) lastSeen.set(uid, seen);
      }),
    );
  }

  const devices = Array.from(stored, (uid) => ({
    device_uid: uid,
    last_seen: lastSeen.get(uid) ?? null,
  })).sort((a, b) => {
    if (a.last_seen === b.last_seen) return a.device_uid.localeCompare(b.device_uid);
    if (a.last_seen === null) return 1;
    if (b.last_seen === null) return -1;
    return Date.parse(b.last_seen) - Date.parse(a.last_seen);
  });

  return { devices, withoutUid };
}
