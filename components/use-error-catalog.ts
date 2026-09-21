"use client";

import { useEffect, useState } from "react";

import { PAYLOAD_ERRORS } from "@/lib/payload-errors";
import type { ErrorCodeRecord } from "@/lib/error-catalog";

/**
 * The device error catalog, read once per page load from
 * `public.payload_error_codes` through GET /api/payload-error-codes.
 *
 * The table is the authoritative source of every code, bit value, name and
 * description the dashboard shows. The built-in list in lib/payload-errors is
 * used only until the fetch lands, and as the fallback when it cannot: the
 * payload decoder is synchronous and runs in the browser and on the ingest
 * path, so it can never wait on a query, and a mask rendered with no names at
 * all would tell the reader less than one rendered with the last known ones.
 * `source` says which is in play.
 */
export type ErrorCatalogSource = "database" | "fallback" | "loading";

export interface ErrorCatalog {
  codes: ErrorCodeRecord[];
  source: ErrorCatalogSource;
}

const BUILT_IN: ErrorCodeRecord[] = PAYLOAD_ERRORS.map((entry) => ({
  code: entry.code,
  bit_value: entry.bit,
  name: entry.name,
  description: entry.description,
}));

// One fetch per page load, shared by every component that asks.
let cache: ErrorCatalog | null = null;
let inFlight: Promise<ErrorCatalog> | null = null;

function load(): Promise<ErrorCatalog> {
  if (cache) return Promise.resolve(cache);
  if (inFlight) return inFlight;

  inFlight = fetch("/api/payload-error-codes", { cache: "no-store" })
    .then(async (response) => {
      const result = await response.json();
      if (!response.ok || !result?.success || !Array.isArray(result.codes)) {
        throw new Error("Malformed error catalog response");
      }
      const catalog: ErrorCatalog = {
        codes: result.codes as ErrorCodeRecord[],
        source: result.source === "database" ? "database" : "fallback",
      };
      cache = catalog;
      return catalog;
    })
    .catch(() => {
      const catalog: ErrorCatalog = { codes: BUILT_IN, source: "fallback" };
      cache = catalog;
      return catalog;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export function useErrorCatalog(): ErrorCatalog {
  const [catalog, setCatalog] = useState<ErrorCatalog>(
    () => cache ?? { codes: BUILT_IN, source: "loading" },
  );

  useEffect(() => {
    let cancelled = false;
    load().then((next) => {
      if (!cancelled) setCatalog(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return catalog;
}
