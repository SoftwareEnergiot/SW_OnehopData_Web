import { createClient } from "@/lib/supabase/server";
import { ENVIRONMENT_PARAM } from "@/lib/environments";
import {
  canonicalUid,
  remoteConfigRefusedForDevice,
  remoteConfigUnavailable,
  resolveEnvironment,
} from "@/lib/payload-repository";
import { saveDeviceConfig } from "@/lib/device-config-store";
import { CONFIG_VERSIONS, validateConfigV0 } from "@/lib/remote-config";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUT /api/remote-config/<device_uid>?environment=<name>
 *
 * Development only: the named environment must offer remote config, and so
 * must the environment the device's reports are routed to — a REE device is
 * refused (403) whatever the request names.
 *
 * Body: `{ version: "v0", config: { …the seven v0 keys… }, lab_limits: boolean }`.
 *
 * Validates the config again here — the editor's validation is a convenience,
 * this is the gate — then generates the device file and saves it as the
 * device's only config, replacing the previous one. The device picks it up on
 * its next poll of GET /api/config.
 *
 * 200 `{ success, config }` saved · 400 invalid request · 403 not available
 * for this environment or device · 422 `{ errors }` the config breaks a
 * firmware rule · 500 otherwise.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ deviceUid: string }> },
) {
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

    const { deviceUid: rawUid } = await params;
    const deviceUid = canonicalUid(rawUid);
    if (!deviceUid) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid device_uid",
          details: `"${rawUid}" is not 8 bytes of hex.`,
        },
        { status: 400 },
      );
    }

    const refused =
      remoteConfigUnavailable(resolution.value) ??
      remoteConfigRefusedForDevice(deviceUid);
    if (refused) {
      return NextResponse.json(
        { success: false, error: refused.error, details: refused.details },
        { status: refused.status },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid request", details: "The body must be JSON." },
        { status: 400 },
      );
    }

    const { version, config, lab_limits: labLimits } = (body ?? {}) as Record<
      string,
      unknown
    >;
    if (!CONFIG_VERSIONS.includes(version as (typeof CONFIG_VERSIONS)[number])) {
      return NextResponse.json(
        {
          success: false,
          error: "Unsupported config version",
          details: `version must be one of: ${CONFIG_VERSIONS.join(", ")}.`,
        },
        { status: 400 },
      );
    }
    if (typeof labLimits !== "boolean") {
      return NextResponse.json(
        { success: false, error: "Invalid request", details: "lab_limits must be a boolean." },
        { status: 400 },
      );
    }

    const validation = validateConfigV0(config, { labLimits });
    if (!validation.ok) {
      return NextResponse.json(
        {
          success: false,
          error: "The config breaks a firmware rule",
          details: validation.errors
            .map((e) => (e.field ? `${e.field} ${e.message}` : e.message))
            .join("; "),
          errors: validation.errors,
        },
        { status: 422 },
      );
    }

    const supabase = await createClient();
    const saved = await saveDeviceConfig(supabase, deviceUid, validation.config, labLimits);
    return NextResponse.json({ success: true, config: saved });
  } catch (error) {
    console.error(
      "Error saving remote config:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return NextResponse.json(
      {
        success: false,
        error: "Failed to save the config",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
