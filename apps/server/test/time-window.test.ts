import { describe, it, expect } from "bun:test";
import { windowStart } from "../src/util/time-window";

describe("windowStart", () => {
  it("past24h is exactly 24h before now (within a few ms)", () => {
    const before = Date.now();
    const start = windowStart("past24h", "America/New_York").getTime();
    const after = Date.now();
    // Allow a small margin for the call itself.
    const expectedMin = before - 24 * 60 * 60 * 1000 - 50;
    const expectedMax = after - 24 * 60 * 60 * 1000 + 50;
    expect(start).toBeGreaterThanOrEqual(expectedMin);
    expect(start).toBeLessThanOrEqual(expectedMax);
  });

  it("today in UTC equals UTC midnight of the current calendar day", () => {
    const now = new Date();
    const expected = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0,
    );
    expect(windowStart("today", null).getTime()).toBe(expected);
  });

  it("today in a non-UTC zone equals that zone's local midnight", () => {
    // Build a tz-local "today" string for Tokyo, parse it back to compare.
    const tz = "Asia/Tokyo";
    const start = windowStart("today", tz);
    // Format the start instant in tz: should read as 00:00:00 on the local day.
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const wallClock = fmt.format(start);
    // Some locales render midnight as "24:00" — accept either.
    expect(["00:00:00", "24:00:00"]).toContain(wallClock);
  });

  it("invalid timezone falls back to UTC midnight", () => {
    const now = new Date();
    const expected = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0,
    );
    expect(windowStart("today", "Not/A/Zone").getTime()).toBe(expected);
  });
});
