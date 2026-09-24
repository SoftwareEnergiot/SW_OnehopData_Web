import { createClient } from "@/lib/supabase/server";
import { analyzePayload, PayloadDecodeError } from "@/lib/payload-decoder";
import {
  applyDeviceUidFilter,
  NO_DEVICE_UID,
  parseDeviceUidFilter,
} from "@/lib/payload-filters";
import {
  ENVIRONMENT_PARAM,
  INGEST_DEFAULT_ENVIRONMENT,
} from "@/lib/environments";
import {
  environmentForDeviceUid,
  resolveEnvironment,
} from "@/lib/payload-repository";
import {
  PayloadInsertError,
  rowsForSchema,
  unsupportedFormat,
} from "@/lib/payload-insert";
import { learnDeviceToken, parseBearerToken } from "@/lib/device-auth";
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
 * The environment a read request names.
 *
 * A value that is present but unknown, or that the application has no data
 * source for, is always an error — never another environment's data. Absent is
 * different from invalid: it means the caller is not environment-aware at all
 * (a listing client written before environments existed), and resolves to the
 * environment those callers have always read.
 */
function requestedEnvironment(request: NextRequest) {
  const raw = new URL(request.url).searchParams.get(ENVIRONMENT_PARAM);
  return resolveEnvironment(raw ?? INGEST_DEFAULT_ENVIRONMENT);
}

/**
 * POST /api/payloads[?environment=<name>]
 *
 * Receives a raw binary Onehop payload (preferably
 * `Content-Type: application/octet-stream`), decodes it and stores it in the
 * selected environment's table. Only the current V1 format is accepted: V0 and
 * the earlier V1 revisions still decode, but are discarded with a 400
 * (`unsupportedFormat` in lib/payload-insert), so every stored payload carries
 * a device UID.
 *
 * Devices send no `environment`, and the endpoint then picks the table from the
 * payload itself: a decoded device UID listed in the REE schema's
 * `writeDeviceUids` stores the payload in `payloads_REE`; any other device is
 * stored in `public.payloads`. A
 * storage failure on that path stays best-effort, as it always has: the payload
 * decoded, so the request is still accepted with 204 and no body.
 *
 * A request that *names* an environment comes from the dashboard. That choice
 * is honoured as given — no UID-based rerouting — and a storage failure is then
 * the answer: it is reported with its database message rather than swallowed
 * behind a 204. That is what makes the REE device-UID constraint visible
 * instead of silent. A rejected write is never retried against another
 * environment.
 */
export async function POST(request: NextRequest) {
  const explicitEnvironment =
    new URL(request.url).searchParams.get(ENVIRONMENT_PARAM) !== null;

  try {
    const arrayBuffer = await request.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    let analysis;
    try {
      analysis = analyzePayload(bytes);
    } catch (error) {
      if (error instanceof PayloadDecodeError) {
        console.error("Payload decode error:", error.code, error.message);
        return explicitEnvironment
          ? NextResponse.json(
              { success: false, error: error.code, details: error.message },
              { status: statusForDecodeError(error.code) },
            )
          : new NextResponse(null, { status: statusForDecodeError(error.code) });
      }
      throw error;
    }

    // Only the current V1 format is stored. Anything else decoded but is
    // discarded with a 400, so the sender knows the frame was not kept.
    const rejection = unsupportedFormat(analysis);
    if (rejection) {
      console.error("Payload discarded:", rejection);
      return explicitEnvironment
        ? NextResponse.json(
            { success: false, error: "UNSUPPORTED_FORMAT", details: rejection },
            { status: 400 },
          )
        : new NextResponse(null, { status: 400 });
    }

    try {
      const supabase = await createClient();

      // A device's report carries both its Bearer token and its UID: remember
      // the pairing, so GET /api/config can tell which device is polling. Only
      // the token's hash is stored, and this never throws or changes the
      // answer below.
      const token = parseBearerToken(request.headers.get("authorization"));
      if (token) {
        await learnDeviceToken(supabase, token, analysis.decoded.device_uid);
      }

      const named = new URL(request.url).searchParams.get(ENVIRONMENT_PARAM);
      // Named explicitly -> honour it. Unaddressed -> route on the device UID.
      const target =
        named ?? environmentForDeviceUid(analysis.decoded.device_uid);
      const resolution = resolveEnvironment(target);

      if (!resolution.ok) {
        // An unknown environment can only come from an explicit parameter.
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

      let rows;
      try {
        rows = rowsForSchema(schema, analysis, {
          ip:
            request.headers.get("x-forwarded-for") ||
            request.headers.get("x-real-ip"),
          userAgent: request.headers.get("user-agent"),
        });
      } catch (error) {
        if (error instanceof PayloadInsertError) {
          console.error(
            `Payload not storable in ${table}:`,
            error.message,
          );
          // Explicit -> the caller asked for this table and must hear why it
          // could not be used. Unaddressed -> a device is on the other end and
          // the payload did decode, so the contract stays what it has always
          // been: 204, with the reason in the server log.
          if (explicitEnvironment) {
            return NextResponse.json(
              {
                success: false,
                environment,
                table,
                error: "Payload cannot be stored in this environment",
                details: error.message,
              },
              { status: 422 },
            );
          }
          return new NextResponse(null, { status: 204 });
        }
        throw error;
      }

      const { error } = await supabase.from(table).insert(rows);

      if (error) {
        console.error(
          `Database error storing payload in ${table}:`,
          error.message,
        );
        // The dashboard must see the rejection — the REE device-UID constraint
        // is enforced here and nowhere else.
        if (explicitEnvironment) {
          return NextResponse.json(
            {
              success: false,
              environment,
              table,
              error: "The database rejected the write",
              details: error.message,
              hint: schema.writeDeviceUids?.length
                ? `${table} only accepts payloads from: ${schema.writeDeviceUids.join(", ")}.`
                : undefined,
            },
            { status: 422 },
          );
        }
      } else if (explicitEnvironment) {
        return NextResponse.json(
          {
            success: true,
            environment,
            table,
            stored: rows.length,
          },
          { status: 201 },
        );
      }
    } catch (error) {
      console.error(
        "Skipping payload storage:",
        error instanceof Error ? error.message : "Unknown error",
      );
      if (explicitEnvironment) {
        return NextResponse.json(
          {
            success: false,
            error: "Could not reach the database",
            details: error instanceof Error ? error.message : "Unknown error",
          },
          { status: 500 },
        );
      }
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("Error processing payload:", error);
    return explicitEnvironment
      ? NextResponse.json(
          {
            success: false,
            error: "Failed to process the payload",
            details: error instanceof Error ? error.message : "Unknown error",
          },
          { status: 500 },
        )
      : new NextResponse(null, { status: 500 });
  }
}

/**
 * GET /api/payloads[?environment=<name>]
 *
 * Lists stored payloads for the selected environment, most recent first.
 * Supports `limit`, `offset`, an optional `error_mask` filter (only where the
 * environment's schema has that column), an optional received-timestamp range
 * (`from` / `to`) filter on `created_at`, and an optional `device_uid` filter
 * (any separator or case; `none` selects the payloads without a UID).
 *
 * Omitting `environment` lists `public.payloads`, which is what this endpoint
 * has always returned. Naming one that does not exist, or that this application
 * has no data source for, is an error — never another environment's rows.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get("limit") || "50");
    const offset = parseInt(searchParams.get("offset") || "0");
    const errorMask = searchParams.get("error_mask");
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    const resolution = requestedEnvironment(request);
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

    const deviceFilter = parseDeviceUidFilter(
      searchParams.get("device_uid"),
      schema.deviceUidFormat,
    );

    // A malformed UID is an error, not "no filter": silently returning every
    // device's payloads would look like a filter that matched.
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

    let query = supabase
      .from(table)
      .select("*", { count: "exact" })
      .order(schema.receivedKey, { ascending: false })
      .range(offset, offset + limit - 1);

    // Only a dataset that stores an error mask is filtered on one, rather than
    // the filter being applied to a column that is not there.
    if (
      schema.capabilities.errorMask &&
      errorMask !== null &&
      errorMask !== ""
    ) {
      query = query.eq("error_mask", Number(errorMask));
    }

    if (schema.deviceKey) {
      query = applyDeviceUidFilter(query, deviceFilter, schema.deviceKey);
    }

    // Received-timestamp range filter. Accepts any value Date can parse (e.g.
    // an ISO 8601 string); invalid values are ignored rather than erroring.
    const fromDate = from ? new Date(from) : null;
    if (fromDate && !Number.isNaN(fromDate.getTime())) {
      query = query.gte(schema.receivedKey, fromDate.toISOString());
    }

    const toDate = to ? new Date(to) : null;
    if (toDate && !Number.isNaN(toDate.getTime())) {
      query = query.lte(schema.receivedKey, toDate.toISOString());
    }

    const { data, error, count } = await query;

    if (error) {
      console.error("Database error:", error);
      return NextResponse.json(
        {
          success: false,
          error: "Failed to fetch payloads",
          details: error.message,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      environment,
      table,
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
