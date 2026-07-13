import { describe, expect, it } from "vitest";
import { createdAtBoundFromInput, formatCreatedAt } from "./utils";

describe("formatCreatedAt", () => {
  it("shows a stored UTC stamp on the Madrid clock in summer (UTC+2)", () => {
    expect(formatCreatedAt("2026-07-13T07:24:19+00:00")).toBe(
      "2026-07-13 09:24:19",
    );
  });

  it("shows it on the Madrid clock in winter (UTC+1)", () => {
    expect(formatCreatedAt("2026-01-13T07:24:19Z")).toBe("2026-01-13 08:24:19");
  });

  it("handles the shapes Postgres returns a timestamptz in", () => {
    // The row reads 09:54:59.427309+00 in the DB; Madrid is on CEST, so 11:54.
    for (const stored of [
      "2026-07-13 09:54:59.427309+00",
      "2026-07-13T09:54:59.427309+00:00",
      "2026-07-13T09:54:59.427Z",
      "2026-07-13T09:54:59+02:00", // an offset that is not UTC is still honoured
    ]) {
      expect(formatCreatedAt(stored)).toBe(
        stored.endsWith("+02:00") ? "2026-07-13 09:54:59" : "2026-07-13 11:54:59",
      );
    }
  });

  it("reads a zone-less stamp as UTC, the way the column stores it", () => {
    expect(formatCreatedAt("2026-07-13 07:24:19.123")).toBe(
      "2026-07-13 09:24:19",
    );
  });

  it("returns an unparseable value untouched", () => {
    expect(formatCreatedAt("not a date")).toBe("not a date");
  });
});

describe("createdAtBoundFromInput", () => {
  it("reads the filter input as Madrid local time, not UTC", () => {
    expect(createdAtBoundFromInput("2026-07-13T09:24", "from")).toBe(
      "2026-07-13T07:24:00.000Z",
    );
  });

  it("uses the winter offset for a winter date", () => {
    expect(createdAtBoundFromInput("2026-01-13T08:24:19", "from")).toBe(
      "2026-01-13T07:24:19.000Z",
    );
  });

  it("round-trips with the clock the table displays", () => {
    const bound = createdAtBoundFromInput("2026-07-13T09:24:00", "from");
    expect(formatCreatedAt(bound as string)).toBe("2026-07-13 09:24:00");
  });

  it("runs a `to` bound to the end of the day when only a day is picked", () => {
    // Madrid 2026-07-13 23:59:59.999 is 21:59:59.999 UTC — every row received
    // that day is included, none silently dropped.
    expect(createdAtBoundFromInput("2026-07-13", "to")).toBe(
      "2026-07-13T21:59:59.999Z",
    );
    expect(createdAtBoundFromInput("2026-07-13T00:00", "to")).toBe(
      "2026-07-13T21:59:59.999Z",
    );
  });

  it("runs a `to` bound to the end of the minute the user typed", () => {
    // A row at 11:54:59 Madrid must survive a "to 11:54" filter.
    const bound = createdAtBoundFromInput("2026-07-13T11:54", "to") as string;
    expect(bound).toBe("2026-07-13T09:54:59.999Z");
    expect(Date.parse("2026-07-13T09:54:59.427309+00:00")).toBeLessThanOrEqual(
      Date.parse(bound),
    );
  });

  it("still starts a `from` bound at the top of the day", () => {
    expect(createdAtBoundFromInput("2026-07-13", "from")).toBe(
      "2026-07-12T22:00:00.000Z",
    );
  });

  it("is null for an unusable value", () => {
    expect(createdAtBoundFromInput("2026-07", "from")).toBeNull();
    expect(createdAtBoundFromInput("", "to")).toBeNull();
  });
});
