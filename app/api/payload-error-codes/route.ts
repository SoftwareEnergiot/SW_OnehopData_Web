import { createClient } from "@/lib/supabase/server";
import { PAYLOAD_ERRORS } from "@/lib/payload-errors";
import type { ErrorCodeRecord } from "@/lib/error-catalog";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const ERROR_CODE_TABLE = "payload_error_codes";

/**
 * GET /api/payload-error-codes
 *
 * The device error catalog, read from `public.payload_error_codes` — the
 * authoritative source of every `code`, `bit_value`, `name` and `description`
 * the dashboard shows. Masks are decoded against this list bitwise, by value:
 * an entry is active when `(mask & bit_value) !== 0`.
 *
 * Response: `{ success, codes: [{ code, bit_value, name, description }], source }`.
 *
 * `source` is "database" normally. When the table cannot be read the built-in
 * catalog in lib/payload-errors is returned instead and `source` says
 * "fallback": the payload decoder is synchronous and runs in the browser and on
 * the ingest path, so it cannot wait on a query, and a dashboard that renders
 * "0x00000008" with no name at all would be worse than one rendering the last
 * known name for that bit. The fallback is reported, never passed off as the
 * table's content.
 */
export async function GET() {
  const fallback: ErrorCodeRecord[] = PAYLOAD_ERRORS.map((entry) => ({
    code: entry.code,
    bit_value: entry.bit,
    name: entry.name,
    description: entry.description,
  }));

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from(ERROR_CODE_TABLE)
      .select("code,bit_value,name,description")
      .order("bit_value", { ascending: true });

    if (error || !data || data.length === 0) {
      if (error) {
        console.error("Database error reading the error catalog:", error.message);
      }
      return NextResponse.json({
        success: true,
        source: "fallback",
        details: error
          ? error.message
          : `public.${ERROR_CODE_TABLE} returned no rows.`,
        codes: fallback,
      });
    }

    return NextResponse.json({
      success: true,
      source: "database",
      codes: data as ErrorCodeRecord[],
    });
  } catch (error) {
    console.error("Error reading the error catalog:", error);
    return NextResponse.json({
      success: true,
      source: "fallback",
      details: error instanceof Error ? error.message : "Unknown error",
      codes: fallback,
    });
  }
}
