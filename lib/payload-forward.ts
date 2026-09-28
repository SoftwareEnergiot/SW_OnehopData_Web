import { REE_ENVIRONMENT } from "@/lib/environments";
import { environmentForDeviceUid } from "@/lib/payload-repository";

/**
 * Relay of the REE device's reports to the other platform.
 *
 * A report that lands in `payloads_REE` is also POSTed, byte for byte, to
 * `FORWARD_URL` — the same request this endpoint receives: the raw binary
 * frame as `application/octet-stream`. Nothing is decoded or rebuilt.
 *
 * It is best-effort: it runs after the device has had its answer, never
 * throws, gives up after `FORWARD_TIMEOUT_MS` and only logs a failure.
 */

export const FORWARD_URL =
  "https://app.dynagrid.io/api/v1/integrations/http/56e271b4-c9b2-feef-91bb-44262e41caa9";
export const FORWARD_TIMEOUT_MS = 10_000;

const OCTET_STREAM = "application/octet-stream";

/** Whether a Content-Type header names application/octet-stream. */
export function isOctetStream(contentType: string | null): boolean {
  return contentType?.split(";")[0].trim().toLowerCase() === OCTET_STREAM;
}

/**
 * Only a device report (no `environment` parameter) sent as octet-stream by a
 * device routed to REE is forwarded.
 */
export function shouldForward(
  deviceUid: string | null,
  contentType: string | null,
  explicitEnvironment: boolean,
): boolean {
  return (
    !explicitEnvironment &&
    isOctetStream(contentType) &&
    environmentForDeviceUid(deviceUid) === REE_ENVIRONMENT
  );
}

/** POST the frame to the other platform. Never rejects. */
export async function forwardPayload(
  body: Uint8Array,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    const response = await fetchImpl(FORWARD_URL, {
      method: "POST",
      headers: { "Content-Type": OCTET_STREAM },
      body: body as BodyInit,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`Payload forward answered ${response.status}`);
    }
  } catch (error) {
    console.error(
      "Payload forward failed:",
      error instanceof Error ? error.message : error,
    );
  }
}
