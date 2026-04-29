// Pure diff for peerPresence.ts. Isolated from electron/backend imports so
// it's reachable from bun test.

import type { PeerPresenceEntry, SpotifyPresence } from "@slashtalk/shared";
import { quotaContentEquals } from "./quotaEquals";

export type PresenceMap = Record<string, PeerPresenceEntry>;

export interface PresenceChange {
  login: string;
  /** New full entry, or null if the login dropped off entirely. */
  entry: PeerPresenceEntry | null;
}

function sameSpotify(a: SpotifyPresence | undefined, b: SpotifyPresence | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  // updatedAt ticks every keepalive even when nothing changed, so ignore it
  // and key on what the user would actually notice on the card.
  return a.trackId === b.trackId && a.isPlaying === b.isPlaying;
}

function sameEntry(a: PeerPresenceEntry | undefined, b: PeerPresenceEntry | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (!sameSpotify(a.spotify, b.spotify)) return false;

  const sources = new Set([...Object.keys(a.quota ?? {}), ...Object.keys(b.quota ?? {})]) as Set<
    keyof NonNullable<PeerPresenceEntry["quota"]>
  >;
  for (const src of sources) {
    if (!quotaContentEquals(a.quota?.[src], b.quota?.[src])) return false;
  }
  return true;
}

/**
 * Returns one entry per login whose presence meaningfully changed between
 * `prev` and `next`. `entry: null` means the login dropped off (cleared all
 * presence). Order is not guaranteed.
 */
export function diffPresence(prev: PresenceMap, next: PresenceMap): PresenceChange[] {
  const logins = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const out: PresenceChange[] = [];
  for (const login of logins) {
    if (!sameEntry(prev[login], next[login])) {
      out.push({ login, entry: next[login] ?? null });
    }
  }
  return out;
}
