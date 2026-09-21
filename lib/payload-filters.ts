// The `device_uid` query parameter shared by GET /api/payloads and
// GET /api/payloads/summary, parsed in one place so the table, the CSV export
// and the charts can never disagree about which rows a filter selects.

import { normalizeDeviceUid } from "@/lib/payload-decoder";

// Selects the payloads that carry no UID: every V0 payload, which has none.
export const NO_DEVICE_UID = "none";

/**
 * How a table stores a device UID.
 *
 * `payloads` keeps the protocol document's printed form, "00:12:4B:…".
 * `payloads_REE` keeps continuous uppercase hex, "00124B0038A83D90". A filter
 * normalised to the wrong one matches nothing at all, which would look exactly
 * like a device that has never reported — hence the explicit parameter rather
 * than a default that silently works for one table only.
 */
export type DeviceUidFormat = "colon" | "plain";

export type DeviceUidFilter =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "uid"; uid: string }
  | { kind: "invalid"; raw: string };

/** Render 8 bytes of hex the way the given table stores them. */
export function formatDeviceUidFor(
  uid: string,
  format: DeviceUidFormat,
): string {
  return format === "plain" ? uid.replace(/[^0-9A-Fa-f]/g, "").toUpperCase() : uid;
}

export function parseDeviceUidFilter(
  raw: string | null,
  format: DeviceUidFormat = "colon",
): DeviceUidFilter {
  const value = raw?.trim() ?? "";
  if (value === "") return { kind: "all" };
  if (value.toLowerCase() === NO_DEVICE_UID) return { kind: "none" };
  // Any separator and any case, so a UID copied from a label, a log or the
  // firmware console matches the stored form of whichever table is active.
  const uid = normalizeDeviceUid(value);
  return uid
    ? { kind: "uid", uid: formatDeviceUidFor(uid, format) }
    : { kind: "invalid", raw: value };
}

// Anything with the two methods the filter needs — the Supabase query builder.
interface FilterableQuery<Q> {
  eq(column: string, value: string): Q;
  is(column: string, value: null): Q;
}

// Narrow a payloads query to the filter. Returns the query unchanged for "all";
// "invalid" must be rejected by the caller before this point. `column` is the
// active schema's device column.
export function applyDeviceUidFilter<Q extends FilterableQuery<Q>>(
  query: Q,
  filter: DeviceUidFilter,
  column = "device_uid",
): Q {
  switch (filter.kind) {
    case "uid":
      return query.eq(column, filter.uid);
    case "none":
      return query.is(column, null);
    default:
      return query;
  }
}
