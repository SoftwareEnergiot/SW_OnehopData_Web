import { describe, expect, it } from "vitest";

import { hashDeviceToken, parseBearerToken } from "@/lib/device-auth";

describe("parseBearerToken", () => {
  it("reads the token of a Bearer header", () => {
    expect(parseBearerToken("Bearer abc123")).toBe("abc123");
    expect(parseBearerToken("bearer  abc123 ")).toBe("abc123");
  });

  it("rejects a missing header, another scheme or an empty token", () => {
    expect(parseBearerToken(null)).toBeNull();
    expect(parseBearerToken("")).toBeNull();
    expect(parseBearerToken("Bearer")).toBeNull();
    expect(parseBearerToken("Bearer   ")).toBeNull();
    expect(parseBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
  });
});

describe("hashDeviceToken", () => {
  it("is the hex SHA-256 of the token", () => {
    expect(hashDeviceToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
