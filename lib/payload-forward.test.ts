import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FORWARD_URL,
  forwardPayload,
  isOctetStream,
  shouldForward,
} from "@/lib/payload-forward";

const REE_UID = "00:12:4B:00:38:A8:3D:90";
const OTHER_UID = "00:12:4B:00:1A:2B:3C:4D";
const OCTET = "application/octet-stream";
const BODY = new Uint8Array([0x01, 0x00, 0x12, 0x4b]);

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

describe("shouldForward", () => {
  it("forwards the REE device's octet-stream report", () => {
    expect(shouldForward(REE_UID, OCTET, false)).toBe(true);
    expect(shouldForward("00124B0038A83D90", OCTET, false)).toBe(true);
  });

  it("does not forward another device, another content type or a dashboard write", () => {
    expect(shouldForward(OTHER_UID, OCTET, false)).toBe(false);
    expect(shouldForward(null, OCTET, false)).toBe(false);
    expect(shouldForward(REE_UID, "application/json", false)).toBe(false);
    expect(shouldForward(REE_UID, null, false)).toBe(false);
    expect(shouldForward(REE_UID, OCTET, true)).toBe(false);
  });
});

describe("forwardPayload", () => {
  it("POSTs the same bytes as application/octet-stream", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await forwardPayload(BODY, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(FORWARD_URL);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(BODY);
    expect(init.headers).toEqual({ "Content-Type": OCTET });
  });

  it("never rejects on an error status or an unreachable host", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      forwardPayload(BODY, vi.fn(async () => new Response(null, { status: 500 }))),
    ).resolves.toBeUndefined();
    await expect(
      forwardPayload(
        BODY,
        vi.fn(async () => {
          throw new TypeError("fetch failed");
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
