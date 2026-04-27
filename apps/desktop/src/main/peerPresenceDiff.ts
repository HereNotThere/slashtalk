// Pure diff for peerPresence.ts. Isolated from electron/backend imports so
// it's reachable from bun test.

import type { SpotifyPresence } from "@slashtalk/shared";

export type PresenceMap = Record<string, SpotifyPresence>;

export interface PresenceChange {
  login: string;
  presence: SpotifyPresence | null;
}

function sameEntry(a: SpotifyPresence | undefined, b: SpotifyPresence | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  // updatedAt ticks every keepalive even when nothing changed, so ignore it
  // and key on what the user would actually notice on the card.
  return a.trackId === b.trackId && a.isPlaying === b.isPlaying;
}

/**
 * Returns one entry per login whose presence meaningfully changed between
 * `prev` and `next`. `presence: null` means cleared (user stopped playing
 * or dropped off). Order is not guaranteed.
 */
export function diffPresence(prev: PresenceMap, next: PresenceMap): PresenceChange[] {
  const logins = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const out: PresenceChange[] = [];
  for (const login of logins) {
    if (!sameEntry(prev[login], next[login])) {
      out.push({ login, presence: next[login] ?? null });
    }
  }
  return out;
}
