import { createClient } from "@/lib/supabase/server";
import {
  applyDeviceUidFilter,
  NO_DEVICE_UID,
  parseDeviceUidFilter,
} from "@/lib/payload-filters";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Supabase/PostgREST caps a single request; walk the range in chunks.
const CHUNK = 1000;
// Hard ceiling so an unbounded range can never stream an unbounded response.
const MAX_POINTS = 20000;

// The columns the charts plot. Kept narrow on purpose: the whole range ships in
// one response, so every extra column is paid for on every payload. The battery
// and radio columns are generated from `context` by scripts/004 — a database
// without that migration simply has no such columns, which is handled below.
// Progressively smaller column sets, richest first. Each generated-column
// migration adds a tier, and the query walks down the list until the database
// accepts one — so a database missing scripts/005 still charts everything
// scripts/004 provides, instead of falling all the way back to reception only.
//
// error_mask belongs to the original schema, so it is in every tier: the battery
// series needs it to tell a flat battery from a failed fuel gauge.
const BASE_COLUMNS = "created_at,byte_length,reporting_counter,error_mask";
const COLUMN_TIERS = [
  // scripts/005: the reporting-loss counters.
  BASE_COLUMNS +
    ",battery_soc,battery_voltage,rsrp,snr,reporting_lost_counter,tx_failed",
  // scripts/004: battery and radio diagnostics.
  BASE_COLUMNS + ",battery_soc,battery_voltage,rsrp,snr",
  // Original schema only.
  BASE_COLUMNS,
];

/**
 * GET /api/payloads/summary
 *
 * Returns the series the dashboard charts need — reception time, byte size,
 * reporting counter, and the V1 battery / radio diagnostics — for *every*
 * payload in the range, not just the page the table shows. Only those columns
 * are selected, so the whole range stays cheap to ship.
 *
 * The diagnostic columns are null for V0 payloads, which carry no such fields.
 * If scripts/004 has not been run the columns do not exist at all; the query is
 * then retried with the base columns so the reception charts keep working and
 * only the battery / coverage charts go missing.
 *
 * Query: `from` / `to` (optional, inclusive bounds on `created_at`), and
 * `device_uid` (optional; same rules as GET /api/payloads). Charting one device
 * at a time matters here: battery and coverage lines from several devices
 * interleaved into one series would be meaningless.
 * Response:
 * `{ success, points: [{ created_at, byte_length, reporting_counter, battery_soc?, battery_voltage?, rsrp?, snr? }], total, truncated }`
 * ordered oldest first. `truncated` is true when the range holds more than
 * MAX_POINTS payloads and the response was cut short.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const deviceFilter = parseDeviceUidFilter(searchParams.get("device_uid"));

    if (deviceFilter.kind === "invalid") {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid device_uid",
          details: `"${deviceFilter.raw}" is not 8 bytes of hex (e.g. 00:12:4B:00:1A:2B:3C:4D), nor "${NO_DEVICE_UID}".`,
        },
        { status: 400 },
      );
    }

    const fromDate = from ? new Date(from) : null;
    const hasFrom = fromDate && !Number.isNaN(fromDate.getTime());
    const toDate = to ? new Date(to) : null;
    const hasTo = toDate && !Number.isNaN(toDate.getTime());

    const supabase = await createClient();

    const points: {
      created_at: string;
      byte_length: number;
      reporting_counter: number;
      error_mask?: number | null;
      battery_soc?: number | null;
      battery_voltage?: number | null;
      rsrp?: number | null;
      snr?: number | null;
      reporting_lost_counter?: number | null;
      tx_failed?: number | null;
    }[] = [];
    let truncated = false;
    // Index into COLUMN_TIERS. Steps down once the database tells us a tier
    // names a column it does not have, and stays there for the rest of the
    // paging loop so the downgrade is probed once, not per chunk.
    let tier = 0;

    for (let offset = 0; offset < MAX_POINTS; offset += CHUNK) {
      const runQuery = async (select: string) => {
        let query = supabase
          .from("payloads")
          .select(select)
          .order("created_at", { ascending: true })
          .range(offset, offset + CHUNK - 1);

        if (hasFrom) query = query.gte("created_at", fromDate.toISOString());
        if (hasTo) query = query.lte("created_at", toDate.toISOString());

        return applyDeviceUidFilter(query, deviceFilter);
      };

      let { data, error } = await runQuery(COLUMN_TIERS[tier]);

      // PostgREST reports an unknown column as 42703. Step down one tier at a
      // time rather than dropping straight to the base columns, so a database
      // missing only the newest migration keeps the charts it can still serve.
      while (error && error.code === "42703" && tier < COLUMN_TIERS.length - 1) {
        tier += 1;
        console.warn(
          `Payload summary: a diagnostic column is missing (run the migrations in scripts/); retrying with tier ${tier}.`,
        );
        ({ data, error } = await runQuery(COLUMN_TIERS[tier]));
      }

      if (error) {
        console.error("Database error:", error);
        return NextResponse.json(
          {
            success: false,
            error: "Failed to fetch payload summary",
            details: error.message,
          },
          { status: 500 },
        );
      }

      points.push(...((data ?? []) as unknown as typeof points));

      // A short chunk means the range is exhausted.
      if (!data || data.length < CHUNK) break;
      // The next iteration would cross the ceiling: stop and say so.
      if (offset + CHUNK >= MAX_POINTS) truncated = true;
    }

    return NextResponse.json({
      success: true,
      points,
      total: points.length,
      truncated,
    });
  } catch (error) {
    console.error("Error fetching payload summary:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch payload summary",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
