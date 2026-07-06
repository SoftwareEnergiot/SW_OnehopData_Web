import { createClient } from "@/lib/supabase/server";
import { analyzePayload, PayloadDecodeError } from "@/lib/payload-decoder";
import type { PayloadIngestResponse } from "@/lib/types";
import { NextRequest, NextResponse } from "next/server";

// Raw binary bodies require the Node.js runtime (not the Edge runtime) so the
// full request buffer is available via request.arrayBuffer().
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Map a decode error code to an HTTP status.
function statusForDecodeError(code: string): number {
  return code === "MALFORMED_BODY" ? 415 : 400;
}

/**
 * POST /api/payloads
 *
 * Receives a raw binary LoRaWAN V0 payload (preferably
 * `Content-Type: application/octet-stream`), decodes it, stores it in Supabase
 * (best-effort — a storage failure does not fail the decode), and returns the
 * full analysis (metadata, hex, binary, header, samples, context, errors).
 *
 * The body is read with request.arrayBuffer() — it is never parsed as JSON.
 */
export async function POST(request: NextRequest) {
  try {
    const arrayBuffer = await request.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    let analysis;
    try {
      analysis = analyzePayload(bytes);
    } catch (error) {
      if (error instanceof PayloadDecodeError) {
        return NextResponse.json(
          { success: false, error: error.message, code: error.code },
          { status: statusForDecodeError(error.code) },
        );
      }
      throw error;
    }

    const { decoded } = analysis;

    // Best-effort persistence. When Supabase is not configured (or the insert
    // is rejected) we still return the decoded result with `stored: false`.
    let storedId: string | null = null;
    let stored = false;
    try {
      const supabase = await createClient();
      const { data, error } = await supabase
        .from("payloads")
        .insert({
          payload_hex: analysis.hex,
          payload_binary: analysis.binary,
          byte_length: analysis.meta.byteLength,
          payload_version: decoded.payload_version,
          sample_count: decoded.sample_count,
          samples: decoded.samples,
          context: decoded.context,
          error_mask: decoded.error_mask,
          errors: decoded.errors,
          reporting_counter: decoded.reporting_counter,
          source_ip:
            request.headers.get("x-forwarded-for") ||
            request.headers.get("x-real-ip"),
          source_user_agent: request.headers.get("user-agent"),
        })
        .select("id")
        .single();

      if (error) {
        console.error("Database error storing payload:", error.message);
      } else {
        storedId = data?.id ?? null;
        stored = true;
      }
    } catch (error) {
      console.error(
        "Skipping payload storage:",
        error instanceof Error ? error.message : "Unknown error",
      );
    }

    const body: PayloadIngestResponse = {
      success: true,
      stored,
      id: storedId,
      meta: analysis.meta,
      hex: analysis.hex,
      binary: analysis.binary,
      header: {
        payload_version: decoded.payload_version,
        sample_count: decoded.sample_count,
      },
      samples: decoded.samples,
      context: decoded.context,
      error_mask: decoded.error_mask,
      error_mask_hex: decoded.error_mask_hex,
      reporting_counter: decoded.reporting_counter,
      errors: decoded.errors,
    };

    return NextResponse.json(body);
  } catch (error) {
    console.error("Error processing payload:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to process payload",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

/**
 * GET /api/payloads
 *
 * Lists stored payloads, most recent first. Supports `limit`, `offset`, an
 * optional `error_mask` filter, and an optional received-timestamp range
 * (`from` / `to`) filter on `created_at`.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get("limit") || "50");
    const offset = parseInt(searchParams.get("offset") || "0");
    const errorMask = searchParams.get("error_mask");
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    const supabase = await createClient();

    let query = supabase
      .from("payloads")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (errorMask !== null && errorMask !== "") {
      query = query.eq("error_mask", Number(errorMask));
    }

    // Received-timestamp range filter. Accepts any value Date can parse (e.g.
    // an ISO 8601 string); invalid values are ignored rather than erroring.
    const fromDate = from ? new Date(from) : null;
    if (fromDate && !Number.isNaN(fromDate.getTime())) {
      query = query.gte("created_at", fromDate.toISOString());
    }

    const toDate = to ? new Date(to) : null;
    if (toDate && !Number.isNaN(toDate.getTime())) {
      query = query.lte("created_at", toDate.toISOString());
    }

    const { data, error, count } = await query;

    if (error) {
      console.error("Database error:", error);
      return NextResponse.json(
        { success: false, error: "Failed to fetch payloads", details: error.message },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      data,
      total: count ?? 0,
      limit,
      offset,
    });
  } catch (error) {
    console.error("Error fetching payloads:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch data",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
