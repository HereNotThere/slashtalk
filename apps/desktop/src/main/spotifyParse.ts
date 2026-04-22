// Pure parser for the osascript output in spotify.ts. Kept in its own file
// (no electron / backend imports) so it's reachable from bun test without
// pulling the whole main-process graph.

import type { SpotifyPresence } from "@slashtalk/shared";

export type Track = Omit<SpotifyPresence, "updatedAt">;

/**
 * Parse the single-line osascript payload produced by the script in
 * spotify.ts. Format is tab-joined `state \t spotifyUri \t name \t artist`
 * on a running+playing track, or one of the sentinels `not-running`,
 * `stopped`, `error`, or empty string otherwise.
 *
 * Returns null for anything that isn't a currently-playing track so the
 * caller treats paused, stopped, quit, and malformed the same way: clear
 * the card.
 */
export function parseSpotifyOutput(raw: string): Track | null {
  if (!raw || raw === "not-running" || raw === "stopped" || raw === "error") {
    return null;
  }
  const parts = raw.split("\t");
  if (parts.length < 4) return null;
  const [state, uri, name, artist] = parts;
  if (!uri || !name || !artist) return null;
  const m = /^spotify:track:(.+)$/.exec(uri);
  if (!m) return null;
  if (state !== "playing") return null;
  const trackId = m[1]!;
  return {
    trackId,
    name,
    artist,
    url: `https://open.spotify.com/track/${trackId}`,
    isPlaying: true,
  };
}
