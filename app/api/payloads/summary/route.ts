import { createClient } from "@/lib/supabase/server";
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
const CHART_COLUMNS =
  "created_at,byte_length,reporting_counter,battery_soc,battery_voltage,rsrp,snr";

// The subset that exists before scripts/004 has been applied.
const BASE_COLUMNS = "created_at,byte_length,reporting_counter";

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
 * Query: `from` / `to` (optional, inclusive bounds on `created_at`).
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

    const fromDate = from ? new Date(from) : null;
    const hasFrom = fromDate && !Number.isNaN(fromDate.getTime());
    const toDate = to ? new Date(to) : null;
    const hasTo = toDate && !Number.isNaN(toDate.getTime());

    const supabase = await createClient();

    const points: {
      created_at: string;
      byte_length: number;
      reporting_counter: number;
      battery_soc?: number | null;
      battery_voltage?: number | null;
      rsrp?: number | null;
      snr?: number | null;
    }[] = [];
    let truncated = false;
    // Downgraded to BASE_COLUMNS once the database tells us the diagnostic
    // columns are not there (scripts/004 not applied).
    let columns = CHART_COLUMNS;

    for (let offset = 0; offset < MAX_POINTS; offset += CHUNK) {
      const runQuery = async (select: string) => {
        let query = supabase
          .from("payloads")
          .select(select)
          .order("created_at", { ascending: true })
          .range(offset, offset + CHUNK - 1);

        if (hasFrom) query = query.gte("created_at", fromDate.toISOString());
        if (hasTo) query = query.lte("created_at", toDate.toISOString());

        return query;
      };

      let { data, error } = await runQuery(columns);

      // PostgREST reports an unknown column as 42703. Fall back to the columns
      // that have always existed rather than failing the whole chart panel.
      if (error && columns !== BASE_COLUMNS && error.code === "42703") {
        console.warn(
          "Payload summary: diagnostic columns missing (run scripts/004); charting reception only.",
        );
        columns = BASE_COLUMNS;
        ({ data, error } = await runQuery(columns));
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
