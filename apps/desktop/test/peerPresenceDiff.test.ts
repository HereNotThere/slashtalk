import { describe, it, expect } from "bun:test";
import type { PeerPresenceEntry, QuotaPresence, SpotifyPresence } from "@slashtalk/shared";
import { diffPresence } from "../src/main/peerPresenceDiff";

function spotify(overrides: Partial<SpotifyPresence> & { trackId: string }): SpotifyPresence {
  return {
    trackId: overrides.trackId,
    name: overrides.name ?? "Song",
    artist: overrides.artist ?? "Artist",
    url: overrides.url ?? `https://open.spotify.com/track/${overrides.trackId}`,
    isPlaying: overrides.isPlaying ?? true,
    updatedAt: overrides.updatedAt ?? "2026-04-22T18:00:00.000Z",
  };
}

function codex(overrides: Partial<QuotaPresence> = {}): QuotaPresence {
  return {
    source: "codex",
    plan: overrides.plan ?? "team",
    windows: overrides.windows ?? [
      { label: "5h", usedPercent: 55, resetsAt: "2026-04-28T03:30:49.000Z" },
      { label: "week", usedPercent: 54, resetsAt: "2026-04-29T16:21:21.000Z" },
    ],
    updatedAt: overrides.updatedAt ?? "2026-04-27T23:37:35.888Z",
  };
}

function entry(parts: PeerPresenceEntry): PeerPresenceEntry {
  return parts;
}

describe("diffPresence", () => {
  it("emits nothing when prev and next are both empty", () => {
    expect(diffPresence({}, {})).toEqual([]);
  });

  it("emits no changes when spotify track is unchanged (ignores updatedAt churn)", () => {
    const prev = {
      alice: entry({ spotify: spotify({ trackId: "abc", updatedAt: "2026-04-22T18:00:00Z" }) }),
    };
    const next = {
      alice: entry({ spotify: spotify({ trackId: "abc", updatedAt: "2026-04-22T18:05:00Z" }) }),
    };
    expect(diffPresence(prev, next)).toEqual([]);
  });

  it("emits a change when a peer's track flips", () => {
    const prev = { alice: entry({ spotify: spotify({ trackId: "abc" }) }) };
    const next = { alice: entry({ spotify: spotify({ trackId: "xyz", name: "Different" }) }) };
    const out = diffPresence(prev, next);
    expect(out).toHaveLength(1);
    expect(out[0]!.login).toBe("alice");
    expect(out[0]!.entry?.spotify?.trackId).toBe("xyz");
  });

  it("emits a clear when a peer disappears entirely", () => {
    const prev = { alice: entry({ spotify: spotify({ trackId: "abc" }) }) };
    const next = {};
    expect(diffPresence(prev, next)).toEqual([{ login: "alice", entry: null }]);
  });

  it("emits an add when a peer shows up", () => {
    const prev = {};
    const nextEntry = entry({ spotify: spotify({ trackId: "abc" }) });
    const next = { alice: nextEntry };
    expect(diffPresence(prev, next)).toEqual([{ login: "alice", entry: nextEntry }]);
  });

  it("treats isPlaying flip as a change even when trackId is unchanged", () => {
    const prev = { alice: entry({ spotify: spotify({ trackId: "abc", isPlaying: true }) }) };
    const next = { alice: entry({ spotify: spotify({ trackId: "abc", isPlaying: false }) }) };
    const out = diffPresence(prev, next);
    expect(out).toHaveLength(1);
    expect(out[0]!.entry?.spotify?.isPlaying).toBe(false);
  });

  it("emits no change when codex quota is structurally identical (ignores updatedAt)", () => {
    const prev = {
      alice: entry({ quota: { codex: codex({ updatedAt: "2026-04-27T23:37:00Z" }) } }),
    };
    const next = {
      alice: entry({ quota: { codex: codex({ updatedAt: "2026-04-27T23:38:00Z" }) } }),
    };
    expect(diffPresence(prev, next)).toEqual([]);
  });

  it("emits a change when a quota window's used% moves", () => {
    const prev = {
      alice: entry({
        quota: {
          codex: codex({
            windows: [{ label: "5h", usedPercent: 55, resetsAt: "2026-04-28T03:30:49.000Z" }],
          }),
        },
      }),
    };
    const next = {
      alice: entry({
        quota: {
          codex: codex({
            windows: [{ label: "5h", usedPercent: 60, resetsAt: "2026-04-28T03:30:49.000Z" }],
          }),
        },
      }),
    };
    const out = diffPresence(prev, next);
    expect(out).toHaveLength(1);
    expect(out[0]!.entry?.quota?.codex?.windows[0]!.usedPercent).toBe(60);
  });

  it("emits a change when codex quota first appears", () => {
    const prev = { alice: entry({ spotify: spotify({ trackId: "abc" }) }) };
    const next = {
      alice: entry({
        spotify: spotify({ trackId: "abc" }),
        quota: { codex: codex() },
      }),
    };
    const out = diffPresence(prev, next);
    expect(out).toHaveLength(1);
    expect(out[0]!.entry?.quota?.codex).toBeTruthy();
  });
});
