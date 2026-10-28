import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FORWARD_URL_ENV,
  forwardConfig,
  forwardPayload,
  forwardUrl,
  isOctetStream,
  shouldForward,
} from "@/lib/payload-forward";

const REE_UID = "00:12:4B:00:38:A8:3D:90";
const DEV_UID = "00:12:4B:00:38:A8:3D:92";
const OCTET = "application/octet-stream";
const BODY = new Uint8Array([0x01, 0x00, 0x12, 0x4b]);
const URL_OK = "https://relay.example.test/";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isOctetStream", () => {
  it("accepts application/octet-stream, with parameters or any case", () => {
    expect(isOctetStream(OCTET)).toBe(true);
    expect(isOctetStream("Application/Octet-Stream; charset=binary")).toBe(
      true,
    );
  });

  it("rejects any other or missing content type", () => {
    expect(isOctetStream(null)).toBe(false);
    expect(isOctetStream("application/json")).toBe(false);
  });
});

describe("forwardUrl", () => {
  it("reads an https URL from the environment", () => {
    expect(forwardUrl({ [FORWARD_URL_ENV]: ` ${URL_OK} ` })).toBe(URL_OK);
  });

  it("returns null when unset, empty, not https or not a URL", () => {
    expect(forwardUrl({})).toBeNull();
    expect(forwardUrl({ [FORWARD_URL_ENV]: "" })).toBeNull();
    expect(forwardUrl({ [FORWARD_URL_ENV]: "http://relay.example.test/" })).toBeNull();
    expect(forwardUrl({ [FORWARD_URL_ENV]: "relay.example.test" })).toBeNull();
  });
});

describe("forwardConfig", () => {
  it("accepts a quoted value pasted in the dashboard", () => {
    expect(forwardConfig({ [FORWARD_URL_ENV]: `"${URL_OK}"` })).toEqual({ ok: true, url: URL_OK });
    expect(forwardConfig({ [FORWARD_URL_ENV]: ` '${URL_OK}' ` })).toEqual({ ok: true, url: URL_OK });
  });

  it("says why forwarding is off", () => {
    expect(forwardConfig({})).toEqual({ ok: false, reason: "unset" });
    expect(forwardConfig({ [FORWARD_URL_ENV]: "etl-dev.dynagrid.io" })).toEqual({ ok: false, reason: "not-a-url" });
    expect(forwardConfig({ [FORWARD_URL_ENV]: "http://relay.example.test/" })).toEqual({ ok: false, reason: "not-https" });
  });
});

describe("shouldForward", () => {
  it("forwards any device's octet-stream report, REE or Development", () => {
    expect(shouldForward(REE_UID, OCTET, false)).toBe(true);
    expect(shouldForward("00124B0038A83D90", OCTET, false)).toBe(true);
    expect(shouldForward(DEV_UID, OCTET, false)).toBe(true);
  });

  it("does not forward a report without UID, another content type or a dashboard write", () => {
    expect(shouldForward(null, OCTET, false)).toBe(false);
    expect(shouldForward(REE_UID, "application/json", false)).toBe(false);
    expect(shouldForward(REE_UID, null, false)).toBe(false);
    expect(shouldForward(REE_UID, OCTET, true)).toBe(false);
  });
});

describe("forwardPayload", () => {
  it("POSTs the same bytes as application/octet-stream to the given URL", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await forwardPayload(BODY, URL_OK, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(URL_OK);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(BODY);
    expect(init.headers).toEqual({ "Content-Type": OCTET });
  });

  it("never rejects on an error status or an unreachable host", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      forwardPayload(
        BODY,
        URL_OK,
        vi.fn(async () => new Response(null, { status: 500 })),
      ),
    ).resolves.toBeUndefined();
    await expect(
      forwardPayload(
        BODY,
        URL_OK,
        vi.fn(async () => {
          throw new TypeError("fetch failed");
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
