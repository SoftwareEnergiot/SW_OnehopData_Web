import { describe, expect, it } from "vitest";

import {
  environmentForDeviceUid,
  remoteConfigRefusedForDevice,
  remoteConfigUnavailable,
  resolveEnvironment,
} from "@/lib/payload-repository";
import { REE_SCHEMA } from "@/lib/payload-schemas";

describe("resolveEnvironment", () => {
  it("resolves each environment to its own table and schema", () => {
    const dev = resolveEnvironment("Development");
    expect(dev.ok && dev.value.table).toBe("payloads");
    expect(dev.ok && dev.value.schema.id).toBe("development");

    const ree = resolveEnvironment("REE");
    expect(ree.ok && ree.value.table).toBe("payloads_REE");
    expect(ree.ok && ree.value.schema.id).toBe("ree");
  });

  it("rejects an unknown environment instead of falling back to one", () => {
    for (const name of ["Staging", "payloads_ree", "ree", "development"]) {
      const resolved = resolveEnvironment(name);
      expect(resolved.ok, name).toBe(false);
      expect(!resolved.ok && resolved.error.status).toBe(404);
    }
  });

  it("rejects a missing environment rather than choosing one", () => {
    const resolved = resolveEnvironment("");
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.error.status).toBe(400);
  });

  it("trims a name before resolving it", () => {
    const resolved = resolveEnvironment("  REE  ");
    expect(resolved.ok && resolved.value.table).toBe("payloads_REE");
  });
});

describe("environmentForDeviceUid", () => {
  it("routes a payload from the REE device to REE", () => {
    expect(environmentForDeviceUid("00:12:4B:00:38:A8:3D:90")).toBe("REE");
  });

  it("matches regardless of separators or case", () => {
    for (const uid of [
      "00124b0038a83d90",
      "00-12-4B-00-38-A8-3D-90",
      "00124B0038A83D90",
    ]) {
      expect(environmentForDeviceUid(uid), uid).toBe("REE");
    }
  });

  it("routes every UID the REE table accepts to REE", () => {
    for (const uid of REE_SCHEMA.writeDeviceUids ?? []) {
      expect(environmentForDeviceUid(uid), uid).toBe("REE");
    }
  });

  it("routes any other device to Development", () => {
    expect(environmentForDeviceUid("00:12:4B:00:1A:2B:3C:4D")).toBe("Development");
  });

  it("routes a payload with no UID to Development", () => {
    // A V0 payload cannot match anything.
    expect(environmentForDeviceUid(null)).toBe("Development");
  });

  it("routes a malformed UID to Development", () => {
    expect(environmentForDeviceUid("00:12:4B")).toBe("Development");
  });
});

describe("remote config availability", () => {
  it("is offered in Development and refused in REE", () => {
    const dev = resolveEnvironment("Development");
    const ree = resolveEnvironment("REE");
    expect(dev.ok && remoteConfigUnavailable(dev.value)).toBeNull();
    expect(ree.ok && remoteConfigUnavailable(ree.value)?.status).toBe(403);
  });

  it("refuses a device whose reports go to REE, whatever the request names", () => {
    const reeUid = REE_SCHEMA.writeDeviceUids![0];
    expect(remoteConfigRefusedForDevice(reeUid)?.status).toBe(403);
    expect(remoteConfigRefusedForDevice("00124B0038A83BF0")).toBeNull();
  });
});
