// The environments the application can operate against, and the single place
// that maps one to its payload data source.
//
// The *list* of environments the user may choose from always comes from the
// database (`public.environment`, read through GET /api/environments). This
// module only says what the application knows how to *do* with a given
// environment: which table holds its payloads and which schema that table
// follows. An environment row that has no entry here is surfaced as
// unsupported rather than silently falling back to another dataset.

import type { PayloadSchemaId } from "@/lib/payload-schemas.types";

/** One row of `public.environment`. */
export interface EnvironmentRecord {
  name: string;
  production: boolean;
  created_at: string;
}

export interface EnvironmentConfig {
  /**
   * The table identifier exactly as PostgREST expects it. `payloads_REE` was
   * created quoted and keeps its uppercase letters — `payloads_ree` is a
   * different (non-existent) name and is rejected with PGRST205.
   */
  payloadTable: string;
  /** Which payload schema `payloadTable` follows (see lib/payload-schemas). */
  schemaId: PayloadSchemaId;
}

/**
 * Environment name -> data source. Centralised on purpose: no component ever
 * compares an environment name itself.
 */
export const ENVIRONMENT_CONFIG: Record<string, EnvironmentConfig> = {
  REE: { payloadTable: 'payloads_REE', schemaId: "ree" },
  Development: { payloadTable: "payloads", schemaId: "development" },
};

/**
 * The environment an unauthenticated device write lands in.
 *
 * POST /api/payloads is the machine-to-machine ingestion endpoint: real devices
 * have no session and send no `environment` parameter, and they have always
 * been stored in `public.payloads`. That behaviour is preserved exactly — this
 * default applies *only* when the request names no environment at all. Every
 * request from the UI names one explicitly.
 */
export const INGEST_DEFAULT_ENVIRONMENT = "Development";

/**
 * The environment whose table the ingestion endpoint routes a payload to when
 * the payload's own device UID matches the device already stored there. Named
 * here rather than spelled out at the call site, so the set of environment
 * names still lives in one module.
 */
export const REE_ENVIRONMENT = "REE";

/** The query-string parameter every environment-aware endpoint reads. */
export const ENVIRONMENT_PARAM = "environment";

/** sessionStorage key holding the environment chosen for this browser session. */
export const ENVIRONMENT_STORAGE_KEY = "onehop.selectedEnvironment";

export function configForEnvironment(
  name: string | null | undefined,
): EnvironmentConfig | null {
  if (!name) return null;
  return ENVIRONMENT_CONFIG[name] ?? null;
}

/**
 * The payload table for an environment, or null when the application has no
 * mapping for it. Never guesses: an unmapped environment must be reported, not
 * quietly served from another table.
 */
export function getPayloadTable(name: string | null | undefined): string | null {
  return configForEnvironment(name)?.payloadTable ?? null;
}

/** "Production" / "Development" — never the raw boolean. */
export function environmentStatusLabel(production: boolean): string {
  return production ? "Production" : "Development";
}

/** Whether the application knows how to operate against this environment. */
export function isSupportedEnvironment(name: string | null | undefined): boolean {
  return configForEnvironment(name) !== null;
}
