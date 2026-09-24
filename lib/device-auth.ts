// Identifying a device by its Bearer token.
//
// GET /api/config carries no body, so the token is the only thing that says
// which device is asking. The application has no key list of its own: it learns
// token -> device_uid from the reports each device already POSTs to
// /api/payloads, which carry both the Bearer header and the UID (bytes 1–8).
//
// Only a SHA-256 of the token is ever stored or compared — never the token
// itself — and neither the token nor the Authorization header is logged.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { canonicalUid } from "@/lib/payload-repository";

/** token hash -> device UID. Created by 007_remote_config.sql (Supabase scripts). */
export const DEVICE_TOKEN_TABLE = "device_api_key";

/**
 * The token of an `Authorization: Bearer <token>` header, or null when the
 * header is absent, uses another scheme, or carries an empty token.
 */
export function parseBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  const token = match?.[1].trim() ?? "";
  return token === "" ? null : token;
}

/** Lowercase hex SHA-256 of the token's UTF-8 bytes. */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// Pairings this server instance has already confirmed, so a warm instance does
// not hit the database on every report. Holds hashes only.
const knownPairings = new Map<string, string>();

/**
 * Record which device a token belongs to, from a report's Bearer header and
 * decoded UID.
 *
 * The first pairing seen for a token is kept. A later report pairing the same
 * token with a different UID is logged (hash prefix only) and ignored, so a
 * token cannot be moved to another device by whoever holds it.
 *
 * Best-effort by design: it never throws, so the ingestion contract of
 * POST /api/payloads does not change when this table is missing.
 */
export async function learnDeviceToken(
  supabase: SupabaseClient,
  token: string,
  deviceUid: string | null,
): Promise<void> {
  const uid = canonicalUid(deviceUid);
  if (!uid) return;

  const tokenHash = hashDeviceToken(token);
  if (knownPairings.get(tokenHash) === uid) return;

  try {
    const { data, error } = await supabase
      .from(DEVICE_TOKEN_TABLE)
      .select("device_uid")
      .eq("token_sha256", tokenHash)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const existing = (data as { device_uid: string } | null)?.device_uid ?? null;
    if (existing === null) {
      const { error: insertError } = await supabase
        .from(DEVICE_TOKEN_TABLE)
        .upsert(
          { token_sha256: tokenHash, device_uid: uid },
          { onConflict: "token_sha256", ignoreDuplicates: true },
        );
      if (insertError) throw new Error(insertError.message);
      knownPairings.set(tokenHash, uid);
    } else if (existing === uid) {
      knownPairings.set(tokenHash, uid);
    } else {
      console.warn(
        `Device token ${tokenHash.slice(0, 8)}… is paired with ${existing}; ignoring a report pairing it with ${uid}.`,
      );
    }
  } catch (error) {
    console.error(
      "Could not record the device token:",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

/**
 * The canonical UID ("00124B0038A83BF0") a token was learned for, or null when
 * the token is unknown. Throws on a database error, which the caller answers
 * with a 5xx — an outage must not look like an unknown token.
 */
export async function deviceForToken(
  supabase: SupabaseClient,
  token: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from(DEVICE_TOKEN_TABLE)
    .select("device_uid")
    .eq("token_sha256", hashDeviceToken(token))
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { device_uid: string } | null)?.device_uid ?? null;
}
