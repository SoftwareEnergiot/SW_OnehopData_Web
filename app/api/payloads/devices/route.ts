import { createClient } from "@/lib/supabase/server";
import {
  ENVIRONMENT_PARAM,
  INGEST_DEFAULT_ENVIRONMENT,
} from "@/lib/environments";
import { listDevices } from "@/lib/device-list";
import { resolveEnvironment } from "@/lib/payload-repository";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/payloads/devices[?environment=<name>]
 *
 * The devices of the selected environment, most recently seen first — what
 * the dashboard's device filter offers. They come from `device_api_key`, the
 * table of known devices, split between environments by the same UID routing
 * ingestion applies (lib/device-list `listDevices`). The UIDs come back in whatever form that environment's table stores
 * them (`payloads` keeps "00:12:4B:…", `payloads_REE` keeps unseparated hex),
 * so the value can be handed straight back as a filter.
 *
 * Response: `{ success, environment, table, devices: [{ device_uid, last_seen }], withoutUid }`,
 * `last_seen` being null for a known device with no payload in this table.
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

    let scan;
    try {
      scan = await listDevices(supabase, environment, table, schema);
    } catch (error) {
      console.error("Database error:", error);
      return NextResponse.json(
        {
          success: false,
          error: "Failed to list devices",
          details: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      environment,
      table,
      ...scan,
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
