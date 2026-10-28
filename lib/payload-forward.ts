/**
 * Relay of device reports to the Dynagrid Logstash relay.
 *
 * Every device report that decoded as a stored format (V1 or V2, with a device
 * UID) is also POSTed, byte for byte, to the URL in `PAYLOAD_FORWARD_URL` —
 * the same request this endpoint receives: the raw binary frame as
 * `application/octet-stream`. Nothing is decoded or rebuilt. Logstash decodes
 * the frame and sends it to ThingsBoard DEV and PROD, per device
 * (SW_DynagridCloud_Logstash, glpi-inventory-iot.csv).
 *
 * When `PAYLOAD_FORWARD_URL` is not set (or is not an https URL), nothing is
 * forwarded. The URL lives in the environment, not in the code.
 *
 * It is best-effort: it runs after the device has had its answer, never
 * throws, gives up after `FORWARD_TIMEOUT_MS` and only logs a failure.
 */

export const FORWARD_URL_ENV = "PAYLOAD_FORWARD_URL";
export const FORWARD_TIMEOUT_MS = 10_000;

const OCTET_STREAM = "application/octet-stream";

/** Whether a Content-Type header names application/octet-stream. */
export function isOctetStream(contentType: string | null): boolean {
  return contentType?.split(";")[0].trim().toLowerCase() === OCTET_STREAM;
}

/** The forward target from the environment, or null when unset or not https. */
export function forwardUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env[FORWARD_URL_ENV]?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Only a device report (no `environment` parameter) sent as octet-stream by a
 * device with a UID is forwarded — whatever environment stores it.
 */
export function shouldForward(
  deviceUid: string | null,
  contentType: string | null,
  explicitEnvironment: boolean,
): boolean {
  return !explicitEnvironment && isOctetStream(contentType) && !!deviceUid;
}

/** POST the frame to the forward target. Never rejects. */
export async function forwardPayload(
  body: Uint8Array,
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    const response = await fetchImpl(url, {
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
