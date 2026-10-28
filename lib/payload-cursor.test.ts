import { describe, expect, it } from "vitest";

import { cursorFilter, nextCursor, parseCursor } from "@/lib/payload-cursor";

const TS = "2026-10-28T09:33:09.633394+00:00";
const UUID = "80cecfe5-cc0e-4fa8-8217-4f0b0157250e";

describe("parseCursor", () => {
  it("returns null when no cursor is given", () => {
    expect(parseCursor(null, null)).toBeNull();
  });

  it("keeps the timestamp exactly as given, microseconds included", () => {
    expect(parseCursor(TS, UUID)).toEqual({ before: TS, beforeId: UUID });
    expect(parseCursor("2026-10-28T09:32:04Z", "10448")).toEqual({
      before: "2026-10-28T09:32:04Z",
      beforeId: "10448",
    });
  });

  it("rejects a half or malformed cursor", () => {
    expect(parseCursor(TS, null)).toBe("invalid");
    expect(parseCursor(null, UUID)).toBe("invalid");
    expect(parseCursor("yesterday", UUID)).toBe("invalid");
    expect(parseCursor(TS, "1,2)")).toBe("invalid");
    expect(parseCursor("2026-13-45T99:99:99Z", UUID)).toBe("invalid");
  });
});

describe("cursorFilter", () => {
  it("selects rows strictly older than the cursor, id breaking ties", () => {
    expect(cursorFilter({ before: TS, beforeId: UUID }, "created_at", "id")).toBe(
      `created_at.lt."${TS}",and(created_at.eq."${TS}",id.lt."${UUID}")`,
    );
  });
});

describe("nextCursor", () => {
  const rows = [
    { id: "b", created_at: "2026-10-28T09:33:00+00:00" },
    { id: 7, created_at: "2026-10-28T09:32:00+00:00" },
  ];

  it("points at the last row of a full page", () => {
    expect(nextCursor(rows, 2, "created_at", "id")).toEqual({
      before: "2026-10-28T09:32:00+00:00",
      beforeId: "7",
    });
  });

  it("ends on a short or empty page", () => {
    expect(nextCursor(rows, 3, "created_at", "id")).toBeNull();
    expect(nextCursor([], 0, "created_at", "id")).toBeNull();
  });
});
