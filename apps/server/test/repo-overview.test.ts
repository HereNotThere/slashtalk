import { describe, it, expect } from "bun:test";
import { hashPrs } from "../src/repo/overview";
import type { ProjectPr } from "@slashtalk/shared";

const basePr = (overrides: Partial<ProjectPr>): ProjectPr => ({
  number: 1,
  title: "test",
  url: "https://github.com/owner/repo/pull/1",
  state: "open",
  authorLogin: "alice",
  authorAvatarUrl: null,
  updatedAt: "2026-04-29T00:00:00.000Z",
  ...overrides,
});

describe("hashPrs (project-overview cache fingerprint)", () => {
  it("is stable across input order", () => {
    const prs = [basePr({ number: 1 }), basePr({ number: 2 }), basePr({ number: 3 })];
    const a = hashPrs([prs[0]!, prs[1]!, prs[2]!]);
    const b = hashPrs([prs[2]!, prs[0]!, prs[1]!]);
    expect(a).toBe(b);
  });

  it("changes when a PR's state flips (open → merged invalidates cache)", () => {
    const open = hashPrs([basePr({ number: 1, state: "open" })]);
    const merged = hashPrs([basePr({ number: 1, state: "merged" })]);
    expect(open).not.toBe(merged);
  });

  it("changes when a PR's updatedAt advances (edit invalidates cache)", () => {
    const earlier = hashPrs([basePr({ updatedAt: "2026-04-29T00:00:00.000Z" })]);
    const later = hashPrs([basePr({ updatedAt: "2026-04-29T01:00:00.000Z" })]);
    expect(earlier).not.toBe(later);
  });

  it("changes when a new PR enters the window", () => {
    const one = hashPrs([basePr({ number: 1 })]);
    const two = hashPrs([basePr({ number: 1 }), basePr({ number: 2 })]);
    expect(one).not.toBe(two);
  });

  it("ignores fields that don't affect cache validity (title, author)", () => {
    const before = hashPrs([basePr({ title: "before", authorLogin: "alice" })]);
    // The fingerprint should NOT depend on title/author — those don't bust
    // the LLM cache; only the (number, state, updatedAt) tuple does. If a PR
    // title rename should bust the cache, callers should bump updatedAt too,
    // which the GitHub poller does naturally.
    const after = hashPrs([basePr({ title: "after", authorLogin: "bob" })]);
    expect(before).toBe(after);
  });

  it("is short enough to use in a cache key", () => {
    const h = hashPrs([basePr({})]);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});
