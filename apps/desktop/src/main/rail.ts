// The teammate rail is derived state, not user-managed.
//
// Heads = the signed-in user plus every peer returned by /api/feed/users —
// users who've signed in at least once AND share at least one claimed repo
// with you. Refreshed on auth changes, on local-repo changes, and on a 30s
// poll as a fallback until WebSocket user_updated events are wired.

import type { ChatHead, RailDebugSnapshot } from "../shared/types";
import * as backend from "./backend";
import * as localRepos from "./localRepos";
import { createEmitter } from "./emitter";

const POLL_INTERVAL_MS = 30_000;
// Coalesce bursts of auth/tracked-repo events into one fetch.
const REFRESH_DEBOUNCE_MS = 200;

let heads: ChatHead[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const changes = createEmitter<ChatHead[]>();

let lastSnapshot: RailDebugSnapshot = { at: null, peers: null, error: null };

// Transient PR-event timestamps keyed by GitHub login. Survives across rail
// refreshes (which would otherwise rebuild head objects without prActivityAt)
// and is cleared on a timer so stale events don't re-trigger animations.
const prActivityByLogin = new Map<string, number>();
const PR_ACTIVITY_TTL_MS = 8_000;

// DEV ONLY — synthetic teammates for testing enter/exit animations without
// touching the backend. Merged into the peer list in refresh() so regular
// polls don't wipe them.
const debugFakes: ChatHead[] = [];
let debugFakeSeq = 0;
const DEBUG_EMOJIS = ["🦊", "🐼", "🐙", "🦄", "🐸", "🐵", "🦉", "🐧", "🐝"];
const DEBUG_TINTS = [
  "#ff6b6b",
  "#4ecdc4",
  "#ffd166",
  "#9b5de5",
  "#06d6a0",
  "#f15bb5",
];

export const onChange = changes.on;
export const list = (): ChatHead[] => heads;

const USER_HEAD_PREFIX = "user:";

export function userHeadId(login: string): string {
  return `${USER_HEAD_PREFIX}${login}`;
}

export function parseUserHeadId(headId: string): string | null {
  return headId.startsWith(USER_HEAD_PREFIX)
    ? headId.slice(USER_HEAD_PREFIX.length)
    : null;
}

function headForUser(
  login: string,
  avatarUrl: string,
  lastActivityAt?: number | null,
): ChatHead {
  const prAt = prActivityByLogin.get(login);
  return {
    id: userHeadId(login),
    label: login,
    tint: "transparent",
    avatar: { type: "remote", value: avatarUrl },
    ...(lastActivityAt != null && { lastActionAt: lastActivityAt }),
    ...(prAt != null && { prActivityAt: prAt }),
  };
}

function selfHead(): ChatHead | null {
  const state = backend.getAuthState();
  if (!state.signedIn) return null;
  return headForUser(state.user.githubLogin, state.user.avatarUrl);
}

function sameHeads(a: ChatHead[], b: ChatHead[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
    if (a[i].label !== b[i].label) return false;
    if (a[i].avatar.value !== b[i].avatar.value) return false;
    if (a[i].prActivityAt !== b[i].prActivityAt) return false;
  }
  return true;
}

function apply(next: ChatHead[]): void {
  if (sameHeads(heads, next)) return;
  heads = next;
  changes.emit(heads);
}

async function refresh(): Promise<void> {
  const self = selfHead();
  if (!self) {
    console.log("[rail] refresh skipped — not signed in");
    lastSnapshot = { at: Date.now(), peers: null, error: "not signed in" };
    apply([]);
    return;
  }
  console.log(`[rail] refresh as ${self.label}`);
  try {
    // Fetch the peer list and the recent session feed in parallel. Each peer's
    // "last activity" is just the timestamp of their most recent session in
    // the feed — no dedicated backend field needed.
    const [peers, feedSessions] = await Promise.all([
      backend.listTeammates(),
      backend.listFeedSessions(),
    ]);

    const latestByLogin = new Map<string, number>();
    for (const s of feedSessions) {
      if (!s.lastTs) continue;
      const ts = new Date(s.lastTs).getTime();
      const prev = latestByLogin.get(s.github_login) ?? 0;
      if (ts > prev) latestByLogin.set(s.github_login, ts);
    }

    lastSnapshot = { at: Date.now(), peers, error: null };
    const peerHeads = peers.map((t) =>
      headForUser(
        t.githubLogin,
        t.avatarUrl,
        latestByLogin.get(t.githubLogin) ?? null,
      ),
    );
    // Merge debug fakes into the peer list so they survive the poll refresh.
    for (const fake of debugFakes) peerHeads.push(fake);
    // Most recently active first; peers with no known activity sink to the end.
    peerHeads.sort((a, b) => (b.lastActionAt ?? -1) - (a.lastActionAt ?? -1));
    apply([self, ...peerHeads]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastSnapshot = { at: Date.now(), peers: null, error: message };
    console.error("[rail] listTeammates failed:", err);
    // Keep showing self so the rail doesn't flash.
    apply([self]);
  }
}

export function getDebugSnapshot(): RailDebugSnapshot {
  return lastSnapshot;
}

export async function forceRefresh(): Promise<RailDebugSnapshot> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  await refresh();
  return lastSnapshot;
}

function scheduleRefresh(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void refresh();
  }, REFRESH_DEBOUNCE_MS);
}

export function refreshSoon(): void {
  scheduleRefresh();
}

/** Stamp a teammate's head with a fresh PR-activity timestamp so the overlay
 *  renders its celebration animation. The stamp self-expires after the TTL so
 *  later refreshes don't keep replaying the animation. */
export function markPrActivity(login: string): void {
  const now = Date.now();
  prActivityByLogin.set(login, now);
  setTimeout(() => {
    if (prActivityByLogin.get(login) === now) {
      prActivityByLogin.delete(login);
      // Re-emit so the renderer drops prActivityAt cleanly. This is cheap; the
      // animation has already finished by then.
      const next = heads.map((h) =>
        parseUserHeadId(h.id) === login && h.prActivityAt === now
          ? (() => {
              const { prActivityAt, ...rest } = h;
              return rest as ChatHead;
            })()
          : h,
      );
      apply(next);
    }
  }, PR_ACTIVITY_TTL_MS);

  // Immediate broadcast so the animation starts now without waiting for a poll.
  const next = heads.map((h) =>
    parseUserHeadId(h.id) === login ? { ...h, prActivityAt: now } : h,
  );
  apply(next);
}

/** DEV ONLY — append a synthetic teammate and re-sort the rail, triggering
 *  the renderer's enter animation. Persists across polls via `debugFakes`. */
export function debugAddFakeTeammate(): void {
  debugFakeSeq += 1;
  const id = `user:debug_${debugFakeSeq}`;
  const emoji = DEBUG_EMOJIS[debugFakeSeq % DEBUG_EMOJIS.length]!;
  const tint = DEBUG_TINTS[debugFakeSeq % DEBUG_TINTS.length]!;
  const fake: ChatHead = {
    id,
    label: `debug_${debugFakeSeq}`,
    tint,
    avatar: { type: "emoji", value: emoji },
    lastActionAt: Date.now(),
  };
  debugFakes.push(fake);

  // Immediate broadcast so the enter animation fires without waiting for a
  // poll. We splice the new fake into the existing rail sorted by lastActionAt.
  if (heads.length === 0) return;
  const [self, ...peers] = heads;
  const merged = [...peers, fake];
  merged.sort((a, b) => (b.lastActionAt ?? -1) - (a.lastActionAt ?? -1));
  apply([self, ...merged]);
}

/** DEV ONLY — remove the most recently added fake teammate. */
export function debugRemoveFakeTeammate(): void {
  const removed = debugFakes.pop();
  if (!removed) return;
  const next = heads.filter((h) => h.id !== removed.id);
  apply(next);
}

/** DEV ONLY — clear all synthetic teammates. */
export function debugClearFakeTeammates(): void {
  if (debugFakes.length === 0) return;
  const removedIds = new Set(debugFakes.map((f) => f.id));
  debugFakes.length = 0;
  apply(heads.filter((h) => !removedIds.has(h.id)));
}

/** DEV ONLY — shuffle peer heads in place and emit. Used to verify the rail's
 *  reorder animation without waiting for real activity. Self (index 0) is
 *  never moved. */
export function debugShuffleRail(): void {
  if (heads.length < 3) return;
  const [self, ...peers] = heads;
  for (let i = peers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [peers[i], peers[j]] = [peers[j], peers[i]];
  }
  // Guarantee an observable change so a no-op shuffle doesn't confuse testing.
  if (peers.length >= 2 && sameHeads(heads, [self, ...peers])) {
    [peers[0], peers[1]] = [peers[1], peers[0]];
  }
  apply([self, ...peers]);
}

export function start(): void {
  backend.onChange(scheduleRefresh);
  localRepos.onChange(scheduleRefresh);
  setInterval(() => void refresh(), POLL_INTERVAL_MS);
  void refresh();
}
