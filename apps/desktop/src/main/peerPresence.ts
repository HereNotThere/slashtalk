// Polls /api/presence/peers and caches the latest Spotify "now playing"
// presence for the signed-in user and every peer who shares a claimed repo.
// The info-card renderer reads this via an IPC handler in index.ts.

import type { SpotifyPresence } from "@slashtalk/shared";
import * as backend from "./backend";
import { createEmitter } from "./emitter";
import { diffPresence, type PresenceMap } from "./peerPresenceDiff";

const POLL_MS = 15_000;

let map: PresenceMap = {};
let running = false;
let timer: NodeJS.Timeout | null = null;
const changes = createEmitter<{ login: string; presence: SpotifyPresence | null }>();

export const onChange = changes.on;

export function get(login: string): SpotifyPresence | null {
  return map[login] ?? null;
}

async function refresh(): Promise<void> {
  if (!running) return;
  let next: PresenceMap;
  try {
    next = await backend.listPeerPresence();
  } catch (err) {
    console.warn("[peerPresence] refresh failed", err);
    return;
  }
  const prev = map;
  map = next;
  for (const change of diffPresence(prev, next)) {
    changes.emit(change);
  }
}

export async function start(): Promise<void> {
  if (running) return;
  running = true;
  await refresh();
  timer = setInterval(() => void refresh(), POLL_MS);
}

export function stop(): void {
  if (!running) return;
  running = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const prev = map;
  map = {};
  for (const change of diffPresence(prev, map)) {
    changes.emit(change);
  }
}
