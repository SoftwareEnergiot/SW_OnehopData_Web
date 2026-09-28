/**
 * Forwarding of device reports to the ETL.
 *
 * Before this platform existed, devices reported straight to the ETL
 * (`http://etl-prd.metrics.nc:6789/post`). They now report here, so the ETL
 * gets its copy from us: the exact bytes the device sent, with the device's
 * Content-Type, relayed after the device has already had its answer.
 *
 * The target comes from the `ETL_FORWARD_URL` environment variable. Without it
 * nothing is forwarded, so deploying this code changes nothing until the
 * variable is set in Vercel.
 *
 * Forwarding is strictly best-effort. It never changes what the device is
 * told, never throws, and a slow or unreachable ETL costs at most
 * `ETL_FORWARD_TIMEOUT_MS` of background work — the outcome is only logged.
 */

export const ETL_FORWARD_URL_ENV = "ETL_FORWARD_URL";
export const ETL_FORWARD_TIMEOUT_MS = 10_000;

export type EtlForwardResult =
  | { forwarded: false; reason: "disabled" }
  | { forwarded: true; status: number }
  | { forwarded: false; reason: "failed"; details: string };

/** The configured ETL URL, or null when forwarding is switched off. */
export function etlForwardUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env[ETL_FORWARD_URL_ENV]?.trim();
  return raw ? raw : null;
}

/**
 * POST `body` to the ETL as-is. Resolves with what happened; never rejects.
 */
export async function forwardToEtl(
  body: Uint8Array,
  contentType: string | null,
  options: {
    url?: string | null;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<EtlForwardResult> {
  const url = options.url === undefined ? etlForwardUrl() : options.url;
  if (!url) return { forwarded: false, reason: "disabled" };

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": contentType || "application/octet-stream",
      },
      body: body as BodyInit,
      signal: AbortSignal.timeout(options.timeoutMs ?? ETL_FORWARD_TIMEOUT_MS),
    });
    // The body is not used; drain it so the connection is released.
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) {
      console.error(`ETL forward answered ${response.status} (${url})`);
    }
    return { forwarded: true, status: response.status };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    console.error(`ETL forward failed (${url}):`, details);
    return { forwarded: false, reason: "failed", details };
  }
}
