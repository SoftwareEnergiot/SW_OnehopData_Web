import { createClient } from "@/lib/supabase/server";
import { ENVIRONMENT_PARAM } from "@/lib/environments";
import {
  canonicalUid,
  latestConfigReport,
  remoteConfigUnavailable,
  resolveEnvironment,
  scanDevices,
} from "@/lib/payload-repository";
import { listDeviceConfigs } from "@/lib/device-config-store";
import { normalizeDeviceUid } from "@/lib/payload-decoder";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/remote-config?environment=<name>
 *
 * The Remote config tab's view of every device that has sent a payload to the
 * selected environment: its saved config (if any) and the `config_crc32` /
 * `last_poll_status` of its newest payload, from which the tab derives
 * Applied / Pending / No remote config.
 *
 * Behind Clerk like every dashboard route (only GET /api/config is public).
 * Development only: an environment whose schema does not offer remote config
 * (REE) answers 403.
 *
 * Response: `{ success, environment, table, truncated, devices: [{ device_uid,
 * stored_uid, payloads, last_seen, last_report, config }] }`, where
 * `device_uid` is the "00:12:4B:…" display form and `config` the saved
 * `device_config` row or null.
 */
export async function GET(request: NextRequest) {
  try {
    const resolution = resolveEnvironment(
      new URL(request.url).searchParams.get(ENVIRONMENT_PARAM),
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

    const unavailable = remoteConfigUnavailable(resolution.value);
    if (unavailable) {
      return NextResponse.json(
        { success: false, error: unavailable.error, details: unavailable.details },
        { status: unavailable.status },
      );
    }

    const supabase = await createClient();
    const [scan, configs] = await Promise.all([
      scanDevices(supabase, table, schema),
      listDeviceConfigs(supabase),
    ]);
    const configByUid = new Map(configs.map((c) => [c.device_uid, c]));

    const devices = await Promise.all(
      scan.devices.map(async (device) => {
        const uid = canonicalUid(device.device_uid);
        return {
          device_uid: normalizeDeviceUid(device.device_uid) ?? device.device_uid,
          stored_uid: device.device_uid,
          payloads: device.payloads,
          last_seen: device.last_seen,
          last_report: await latestConfigReport(
            supabase,
            table,
            schema,
            device.device_uid,
          ),
          config: (uid && configByUid.get(uid)) || null,
        };
      }),
    );

    return NextResponse.json({
      success: true,
      environment,
      table,
      truncated: scan.truncated,
      devices,
    });
  } catch (error) {
    console.error(
      "Error listing remote configs:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return NextResponse.json(
      {
        success: false,
        error: "Failed to load remote configs",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
