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

export type ForwardConfig =
  | { ok: true; url: string }
  | { ok: false; reason: "unset" | "not-a-url" | "not-https" };

/**
 * Reads the forward target. Surrounding quotes and spaces (a frequent paste
 * mistake in the Vercel dashboard) are removed; anything else that is not an
 * https URL is reported, never guessed.
 */
export function forwardConfig(
  env: Record<string, string | undefined> = process.env,
): ForwardConfig {
  const raw = env[FORWARD_URL_ENV]?.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  if (!raw) return { ok: false, reason: "unset" };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "not-a-url" };
  }
  return parsed.protocol === "https:"
    ? { ok: true, url: raw }
    : { ok: false, reason: "not-https" };
}

let reported = false;

/**
 * The forward target, or null when forwarding is off. The first call of each
 * server instance logs whether forwarding is on (host only) or why it is off,
 * so a wrong value in the dashboard shows up in the runtime logs.
 */
export function forwardUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const config = forwardConfig(env);
  if (!reported) {
    reported = true;
    if (config.ok) {
      console.info(`Payload forward: on, to ${new URL(config.url).host}`);
    } else {
      console.warn(`Payload forward: off (${FORWARD_URL_ENV} ${config.reason})`);
    }
  }
  return config.ok ? config.url : null;
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
