import { describe, it, expect } from "bun:test";
import type { QuotaPresence } from "@slashtalk/shared";
import { quotaContentEquals } from "../src/main/quotaEquals";

// Use the wire-shape input for half the cases and the parsed-shape input for
// the other half — quotaContentEquals must accept either via its structural
// type. Without this both consumers (claudeQuota, peerPresenceDiff) would
// drift again the moment the wire shape grows a new field.
const parsed = { plan: "Max 5x", windows: [] };
const wire: QuotaPresence = {
  source: "claude",
  plan: "Max 5x",
  windows: [],
  updatedAt: "2026-04-27T23:37:00Z",
};

describe("quotaContentEquals", () => {
  it("considers two nulls equal", () => {
    expect(quotaContentEquals(null, null)).toBe(true);
    expect(quotaContentEquals(undefined, undefined)).toBe(true);
    expect(quotaContentEquals(null, undefined)).toBe(true);
  });

  it("considers null vs present different", () => {
    expect(quotaContentEquals(null, parsed)).toBe(false);
    expect(quotaContentEquals(parsed, null)).toBe(false);
  });

  it("considers identical plan + empty windows equal regardless of input shape", () => {
    expect(quotaContentEquals(parsed, { ...parsed })).toBe(true);
    // wire-shape vs parsed-shape: updatedAt and source are ignored
    expect(quotaContentEquals(wire, parsed)).toBe(true);
  });

  it("ignores updatedAt churn between two wire-shape inputs", () => {
    const later = { ...wire, updatedAt: "2026-04-28T00:00:00Z" };
    expect(quotaContentEquals(wire, later)).toBe(true);
  });

  it("considers differing plans different", () => {
    expect(quotaContentEquals(parsed, { ...parsed, plan: "Pro" })).toBe(false);
  });

  it("compares windows by label/usedPercent/resetsAt", () => {
    const a = { plan: null, windows: [{ label: "5h", usedPercent: 50, resetsAt: null }] };
    const b = { plan: null, windows: [{ label: "5h", usedPercent: 51, resetsAt: null }] };
    expect(quotaContentEquals(a, b)).toBe(false);
  });

  it("considers different window orderings unequal (positional comparison)", () => {
    const a = {
      plan: "team",
      windows: [
        { label: "5h", usedPercent: 55, resetsAt: null },
        { label: "week", usedPercent: 54, resetsAt: null },
      ],
    };
    const b = {
      plan: "team",
      windows: [
        { label: "week", usedPercent: 54, resetsAt: null },
        { label: "5h", usedPercent: 55, resetsAt: null },
      ],
    };
    expect(quotaContentEquals(a, b)).toBe(false);
  });

  it("considers different window counts unequal", () => {
    const a = { plan: null, windows: [{ label: "5h", usedPercent: 1, resetsAt: null }] };
    const b = {
      plan: null,
      windows: [
        { label: "5h", usedPercent: 1, resetsAt: null },
        { label: "week", usedPercent: 2, resetsAt: null },
      ],
    };
    expect(quotaContentEquals(a, b)).toBe(false);
  });
});
