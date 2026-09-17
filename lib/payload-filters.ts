// The `device_uid` query parameter shared by GET /api/payloads and
// GET /api/payloads/summary, parsed in one place so the table, the CSV export
// and the charts can never disagree about which rows a filter selects.

import { normalizeDeviceUid } from "@/lib/payload-decoder";

// Selects the payloads that carry no UID: every V0 payload, which has none.
export const NO_DEVICE_UID = "none";

export type DeviceUidFilter =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "uid"; uid: string }
  | { kind: "invalid"; raw: string };

export function parseDeviceUidFilter(raw: string | null): DeviceUidFilter {
  const value = raw?.trim() ?? "";
  if (value === "") return { kind: "all" };
  if (value.toLowerCase() === NO_DEVICE_UID) return { kind: "none" };
  // Any separator and any case, so a UID copied from a label, a log or the
  // firmware console matches the stored "00:12:4B:…" form.
  const uid = normalizeDeviceUid(value);
  return uid ? { kind: "uid", uid } : { kind: "invalid", raw: value };
}

// Anything with the two methods the filter needs — the Supabase query builder.
interface FilterableQuery<Q> {
  eq(column: string, value: string): Q;
  is(column: string, value: null): Q;
}

// Narrow a payloads query to the filter. Returns the query unchanged for "all";
// "invalid" must be rejected by the caller before this point.
export function applyDeviceUidFilter<Q extends FilterableQuery<Q>>(
  query: Q,
  filter: DeviceUidFilter,
): Q {
  switch (filter.kind) {
    case "uid":
      return query.eq("device_uid", filter.uid);
    case "none":
      return query.is("device_uid", null);
    default:
      return query;
  }
}
