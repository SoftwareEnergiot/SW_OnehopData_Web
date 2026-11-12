import { describe, expect, it } from "vitest";
import {
  FIRST_BATCH_SIZE,
  MAX_BATCH_SIZE,
  appendBatch,
  nextBatchSize,
} from "./payload-list";

describe("nextBatchSize", () => {
  it("starts small and doubles up to the cap", () => {
    expect([0, 1, 2, 3, 4, 5].map(nextBatchSize)).toEqual([
      25, 50, 100, 200, 200, 200,
    ]);
  });

  it("starts with the first batch size", () => {
    expect(nextBatchSize(0)).toBe(FIRST_BATCH_SIZE);
  });

  it("never exceeds the cap, however many batches", () => {
    expect(nextBatchSize(1_000)).toBe(MAX_BATCH_SIZE);
  });

  it("treats a negative or fractional count as the batches fully loaded", () => {
    expect(nextBatchSize(-3)).toBe(FIRST_BATCH_SIZE);
    expect(nextBatchSize(1.7)).toBe(50);
  });
});

describe("appendBatch", () => {
  const id = (row: { id: string }) => row.id;

  it("appends the batch after the current rows, in order", () => {
    expect(
      appendBatch([{ id: "a" }, { id: "b" }], [{ id: "c" }, { id: "d" }], id),
    ).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
  });

  it("skips rows already shown", () => {
    expect(
      appendBatch([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }], id),
    ).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
  });

  it("returns a copy, never the array it was given", () => {
    const current = [{ id: "a" }];
    const result = appendBatch(current, [], id);
    expect(result).toEqual(current);
    expect(result).not.toBe(current);
  });
});
