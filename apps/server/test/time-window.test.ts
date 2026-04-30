import { describe, it, expect } from "bun:test";
import { windowStart } from "../src/util/time-window";

describe("windowStart", () => {
  it("is exactly 24h before now (within a few ms)", () => {
    const before = Date.now();
    const start = windowStart().getTime();
    const after = Date.now();
    const expectedMin = before - 24 * 60 * 60 * 1000 - 50;
    const expectedMax = after - 24 * 60 * 60 * 1000 + 50;
    expect(start).toBeGreaterThanOrEqual(expectedMin);
    expect(start).toBeLessThanOrEqual(expectedMax);
  });
});
