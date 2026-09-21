import { createClient } from "@/lib/supabase/server";
import {
  ENVIRONMENT_PARAM,
  INGEST_DEFAULT_ENVIRONMENT,
} from "@/lib/environments";
import { resolveEnvironment } from "@/lib/payload-repository";
import { NextRequest, NextResponse } from "next/server";

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
 * GET /api/payloads/devices[?environment=<name>]
 *
 * The distinct device UIDs that have sent payloads in the selected
 * environment, most recently seen first — what the dashboard's device filter
 * offers. The UIDs come back in whatever form that environment's table stores
 * them (`payloads` keeps "00:12:4B:…", `payloads_REE` keeps unseparated hex),
 * so the value can be handed straight back as a filter.
 *
 * There is no DISTINCT over the REST API without adding a database function, so
 * the endpoint scans only the device and timestamp columns, newest first, and
 * folds them. The partial index from scripts/003 keeps that cheap.
 *
 * Response: `{ success, environment, table, devices: [{ device_uid, payloads, last_seen }], withoutUid, truncated }`.
 * `withoutUid` is true when at least one scanned payload has no UID (V0).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const resolution = resolveEnvironment(
      searchParams.get(ENVIRONMENT_PARAM) ?? INGEST_DEFAULT_ENVIRONMENT,
    );
    if (!resolution.ok) {
      return NextResponse.json(
        {
          success: false,
          error: resolution.error.error,
          details: resolution.error.details,
        },
        { status: resolution.error.status },
      );
    }
    const { environment, table, schema } = resolution.value;
    const supabase = await createClient();

    // A schema with no device column has no device list to offer.
    if (!schema.deviceKey) {
      return NextResponse.json({
        success: true,
        environment,
        table,
        devices: [],
        withoutUid: false,
        truncated: false,
      });
    }

    const deviceKey = schema.deviceKey;
    const receivedKey = schema.receivedKey;
    const devices = new Map<string, DeviceSummary>();
    let withoutUid = false;
    let truncated = false;

    for (let offset = 0; offset < MAX_ROWS; offset += CHUNK) {
      const { data, error } = await supabase
        .from(table)
        .select(`${deviceKey},${receivedKey}`)
        .order(receivedKey, { ascending: false })
        .range(offset, offset + CHUNK - 1);

      if (error) {
        console.error("Database error:", error);
        return NextResponse.json(
          {
            success: false,
            error: "Failed to list devices",
            details: error.message,
          },
          { status: 500 },
        );
      }

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

      if (!data || data.length < CHUNK) break;
      if (offset + CHUNK >= MAX_ROWS) truncated = true;
    }

    return NextResponse.json({
      success: true,
      environment,
      table,
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
