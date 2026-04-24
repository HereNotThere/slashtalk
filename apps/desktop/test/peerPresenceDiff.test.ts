import { describe, it, expect } from "bun:test";
import type { SpotifyPresence } from "@slashtalk/shared";
import { diffPresence } from "../src/main/peerPresenceDiff";

function mk(
  overrides: Partial<SpotifyPresence> & { trackId: string },
): SpotifyPresence {
  return {
    trackId: overrides.trackId,
    name: overrides.name ?? "Song",
    artist: overrides.artist ?? "Artist",
    url: overrides.url ?? `https://open.spotify.com/track/${overrides.trackId}`,
    isPlaying: overrides.isPlaying ?? true,
    updatedAt: overrides.updatedAt ?? "2026-04-22T18:00:00.000Z",
  };
}

describe("diffPresence", () => {
  it("emits nothing when prev and next are both empty", () => {
    expect(diffPresence({}, {})).toEqual([]);
  });

  it("emits no changes when a peer's track is unchanged (ignores updatedAt churn)", () => {
    const prev = {
      alice: mk({ trackId: "abc", updatedAt: "2026-04-22T18:00:00Z" }),
    };
    const next = {
      alice: mk({ trackId: "abc", updatedAt: "2026-04-22T18:05:00Z" }),
    };
    expect(diffPresence(prev, next)).toEqual([]);
  });

  it("emits a change when a peer's track flips", () => {
    const prev = { alice: mk({ trackId: "abc" }) };
    const next = { alice: mk({ trackId: "xyz", name: "Different" }) };
    const out = diffPresence(prev, next);
    expect(out).toHaveLength(1);
    expect(out[0].login).toBe("alice");
    expect(out[0].presence?.trackId).toBe("xyz");
  });

  it("emits a clear when a peer disappears (stopped playing)", () => {
    const prev = { alice: mk({ trackId: "abc" }) };
    const next = {};
    expect(diffPresence(prev, next)).toEqual([
      { login: "alice", presence: null },
    ]);
  });

  it("emits an add when a peer shows up", () => {
    const prev = {};
    const nextPresence = mk({ trackId: "abc" });
    const next = { alice: nextPresence };
    expect(diffPresence(prev, next)).toEqual([
      { login: "alice", presence: nextPresence },
    ]);
  });

  it("only emits for peers that actually changed in a mixed update", () => {
    const prev = {
      alice: mk({ trackId: "a1" }),
      bob: mk({ trackId: "b1" }),
      carol: mk({ trackId: "c1" }),
    };
    const next = {
      alice: mk({ trackId: "a1" }), // unchanged
      bob: mk({ trackId: "b2" }), // changed track
      // carol: missing → clear
      dave: mk({ trackId: "d1" }), // new
    };
    const byLogin = new Map(
      diffPresence(prev, next).map((c) => [c.login, c.presence]),
    );
    expect(byLogin.has("alice")).toBe(false);
    expect(byLogin.get("bob")?.trackId).toBe("b2");
    expect(byLogin.get("carol")).toBeNull();
    expect(byLogin.get("dave")?.trackId).toBe("d1");
    expect(byLogin.size).toBe(3);
  });

  it("treats isPlaying flip as a change even when trackId is unchanged", () => {
    const prev = { alice: mk({ trackId: "abc", isPlaying: true }) };
    const next = { alice: mk({ trackId: "abc", isPlaying: false }) };
    const out = diffPresence(prev, next);
    expect(out).toHaveLength(1);
    expect(out[0].presence?.isPlaying).toBe(false);
  });
});
