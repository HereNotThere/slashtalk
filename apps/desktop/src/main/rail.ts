// The teammate rail is derived state, not user-managed.
//
// Heads = the signed-in user plus every peer returned by /api/feed/users —
// users who've signed in at least once AND share at least one claimed repo
// with you. Refreshed on auth changes, on local-repo changes, and on a 30s
// poll as a fallback until WebSocket user_updated events are wired.

import type {
  ChatHead,
  RailDebugSnapshot,
  TeammateSummary,
} from "../shared/types";
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

function headForUser(login: string, avatarUrl: string): ChatHead {
  return {
    id: userHeadId(login),
    label: login,
    tint: "transparent",
    avatar: { type: "remote", value: avatarUrl },
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
    lastSnapshot = { at: Date.now(), peers: null, error: "not signed in" };
    apply([]);
    return;
  }
  try {
    const peers = await backend.listTeammates();
    lastSnapshot = { at: Date.now(), peers, error: null };
    apply([
      self,
      ...peers.map((t: TeammateSummary) =>
        headForUser(t.githubLogin, t.avatarUrl),
      ),
    ]);
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

export function start(): void {
  backend.onChange(scheduleRefresh);
  localRepos.onChange(scheduleRefresh);
  setInterval(() => void refresh(), POLL_INTERVAL_MS);
  void refresh();
}
