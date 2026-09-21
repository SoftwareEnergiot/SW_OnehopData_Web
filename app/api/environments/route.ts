import { createClient } from "@/lib/supabase/server";
import { isSupportedEnvironment } from "@/lib/environments";
import { listEnvironments, ENVIRONMENT_TABLE } from "@/lib/payload-repository";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/environments
 *
 * The environments the user may operate in, read from `public.environment`.
 * This is the only source of that list — the frontend never carries its own
 * copy — so an environment added to or removed from the table shows up here
 * without a code change.
 *
 * Each row is returned with a `supported` flag saying whether this application
 * has a payload data source mapped for it (lib/environments). An unsupported
 * environment is still listed, so the selector can say why it cannot be chosen
 * rather than silently hiding a row the database offers.
 *
 * Response: `{ success, environments: [{ name, production, created_at, supported }] }`.
 * Behind Clerk, like every other non-ingest route.
 */
export async function GET() {
  try {
    const supabase = await createClient();
    const { data, error } = await listEnvironments(supabase);

    if (error) {
      console.error("Database error listing environments:", error);
      return NextResponse.json(
        {
          success: false,
          error: "Failed to load the environments",
          details: error,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      environments: data.map((environment) => ({
        ...environment,
        supported: isSupportedEnvironment(environment.name),
      })),
    });
  } catch (error) {
    console.error(`Error reading public.${ENVIRONMENT_TABLE}:`, error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to load the environments",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
