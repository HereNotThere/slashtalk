// Polls /api/presence/locations and caches each peer's persisted IANA
// timezone + city for the info-card renderer. Locations rarely change, so
// we poll on a long interval; freshness isn't the goal — populating the
// peer card with anything other than the local user's tz is.

import type { UserLocation } from "../shared/types";
import * as backend from "./backend";

const POLL_MS = 5 * 60_000;

let map: Record<string, UserLocation> = {};
let running = false;
let timer: NodeJS.Timeout | null = null;

export function get(login: string): UserLocation | null {
  return map[login] ?? null;
}

async function refresh(): Promise<void> {
  if (!running) return;
  try {
    map = await backend.listPeerLocations();
  } catch (err) {
    console.warn("[peerLocations] refresh failed", err);
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
  map = {};
}
