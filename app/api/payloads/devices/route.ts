import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PostgREST caps a single request; walk the rows in chunks.
const CHUNK = 1000;
// Hard ceiling on rows scanned, so a large table can never make this endpoint
// slow. Devices only seen before the most recent MAX_ROWS payloads are missing
// from the list, which the response says via `truncated`.
const MAX_ROWS = 20000;

interface DeviceSummary {
  device_uid: string;
  /** Payloads from this device within the scanned rows. */
  payloads: number;
  /** Most recent reception, ISO 8601. */
  last_seen: string;
}

/**
 * GET /api/payloads/devices
 *
 * The distinct device UIDs that have sent payloads, most recently seen first —
 * what the dashboard's device filter offers.
 *
 * There is no DISTINCT over the REST API without adding a database function, so
 * the endpoint scans only the `device_uid` and `created_at` columns, newest
 * first, and folds them. The partial index from scripts/003 keeps that cheap.
 *
 * Response: `{ success, devices: [{ device_uid, payloads, last_seen }], withoutUid, truncated }`.
 * `withoutUid` is true when at least one scanned payload has no UID (V0).
 */
export async function GET() {
  try {
    const supabase = await createClient();

    const devices = new Map<string, DeviceSummary>();
    let withoutUid = false;
    let truncated = false;

    for (let offset = 0; offset < MAX_ROWS; offset += CHUNK) {
      const { data, error } = await supabase
        .from("payloads")
        .select("device_uid,created_at")
        .order("created_at", { ascending: false })
        .range(offset, offset + CHUNK - 1);

      if (error) {
        console.error("Database error:", error);
        return NextResponse.json(
          { success: false, error: "Failed to list devices", details: error.message },
          { status: 500 },
        );
      }

      for (const row of data ?? []) {
        if (!row.device_uid) {
          withoutUid = true;
          continue;
        }
        const known = devices.get(row.device_uid);
        if (known) {
          known.payloads += 1;
        } else {
          // Rows arrive newest first, so the first one seen is the last seen.
          devices.set(row.device_uid, {
            device_uid: row.device_uid,
            payloads: 1,
            last_seen: row.created_at,
          });
        }
      }

      if (!data || data.length < CHUNK) break;
      if (offset + CHUNK >= MAX_ROWS) truncated = true;
    }

    return NextResponse.json({
      success: true,
      devices: Array.from(devices.values()),
      withoutUid,
      truncated,
    });
  } catch (error) {
    console.error("Error listing devices:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to list devices",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
