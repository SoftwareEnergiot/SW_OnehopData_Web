import { createClient } from "@/lib/supabase/server";
import {
  applyDeviceUidFilter,
  NO_DEVICE_UID,
  parseDeviceUidFilter,
} from "@/lib/payload-filters";
import {
  ENVIRONMENT_PARAM,
  INGEST_DEFAULT_ENVIRONMENT,
} from "@/lib/environments";
import { resolveEnvironment } from "@/lib/payload-repository";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Supabase/PostgREST caps a single request; walk the range in chunks.
const CHUNK = 1000;
// Hard ceiling so an unbounded range can never stream an unbounded response.
const MAX_POINTS = 20000;

/**
 * GET /api/payloads/summary[?environment=<name>]
 *
 * Returns the series the dashboard charts need for *every* payload in the
 * range, not just the page the table shows. Which columns those are comes from
 * the active environment's schema (lib/payload-schemas), so the response is
 * always narrow: the whole range ships in one response and every extra column
 * is paid for on every payload.
 *
 * Development asks for reception time, byte size, reporting counter, the error
 * mask and the V1 battery / radio diagnostics. The diagnostic columns are
 * generated from `context` by scripts/004 and scripts/005; a database missing
 * one of those migrations does not have them at all, so the schema lists
 * progressively smaller column sets and the query walks down until one is
 * accepted — a database missing only the newest migration keeps every chart it
 * can still serve.
 *
 * REE asks for reception time, the reporting counter, the valid-sample mask and
 * the sensor channels, which is everything `payloads_REE` can chart.
 *
 * Query: `from` / `to` (optional, inclusive bounds on `created_at`), and
 * `device_uid` (optional; same rules as GET /api/payloads). Charting one device
 * at a time matters here: lines from several devices interleaved into one
 * series would be meaningless.
 *
 * Response: `{ success, environment, table, columns, points, total, truncated }`
 * ordered oldest first. `truncated` is true when the range holds more than
 * MAX_POINTS payloads and the response was cut short.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");

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
    const columnTiers = schema.summaryColumnTiers;

    const deviceFilter = parseDeviceUidFilter(
      searchParams.get("device_uid"),
      schema.deviceUidFormat,
    );

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

    const points: Record<string, unknown>[] = [];
    let truncated = false;
    // Index into the schema's column tiers. Steps down once the database tells
    // us a tier names a column it does not have, and stays there for the rest
    // of the paging loop so the downgrade is probed once, not per chunk.
    let tier = 0;

    for (let offset = 0; offset < MAX_POINTS; offset += CHUNK) {
      const runQuery = async (select: string) => {
        let query = supabase
          .from(table)
          .select(select)
          .order(schema.receivedKey, { ascending: true })
          .range(offset, offset + CHUNK - 1);

        if (hasFrom) {
          query = query.gte(schema.receivedKey, fromDate.toISOString());
        }
        if (hasTo) query = query.lte(schema.receivedKey, toDate.toISOString());

        return schema.deviceKey
          ? applyDeviceUidFilter(query, deviceFilter, schema.deviceKey)
          : query;
      };

      let { data, error } = await runQuery(columnTiers[tier]);

      // PostgREST reports an unknown column as 42703. Step down one tier at a
      // time rather than dropping straight to the base columns, so a database
      // missing only the newest migration keeps the charts it can still serve.
      while (error && error.code === "42703" && tier < columnTiers.length - 1) {
        tier += 1;
        console.warn(
          `Payload summary (${table}): a column is missing (run the migrations in scripts/); retrying with tier ${tier}.`,
        );
        ({ data, error } = await runQuery(columnTiers[tier]));
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
      environment,
      table,
      columns: columnTiers[tier].split(","),
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
