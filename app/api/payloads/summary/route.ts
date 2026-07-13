import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Supabase/PostgREST caps a single request; walk the range in chunks.
const CHUNK = 1000;
// Hard ceiling so an unbounded range can never stream an unbounded response.
const MAX_POINTS = 20000;

/**
 * GET /api/payloads/summary
 *
 * Returns the two series the dashboard charts need — reception time and byte
 * size — for *every* payload in the range, not just the page the table shows.
 * Only the two columns are selected, so the whole range stays cheap to ship.
 *
 * Query: `from` / `to` (optional, inclusive bounds on `created_at`).
 * Response: `{ success, points: [{ created_at, byte_length }], total, truncated }`
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

    const points: { created_at: string; byte_length: number }[] = [];
    let truncated = false;

    for (let offset = 0; offset < MAX_POINTS; offset += CHUNK) {
      let query = supabase
        .from("payloads")
        .select("created_at,byte_length")
        .order("created_at", { ascending: true })
        .range(offset, offset + CHUNK - 1);

      if (hasFrom) query = query.gte("created_at", fromDate.toISOString());
      if (hasTo) query = query.lte("created_at", toDate.toISOString());

      const { data, error } = await query;

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

      points.push(...(data ?? []));

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
