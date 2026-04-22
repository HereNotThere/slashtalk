// The teammate rail is derived state, not user-managed.
//
// Heads = the signed-in user plus every peer returned by /api/feed/users —
// users who've signed in at least once AND share at least one claimed repo
// with you. Refreshed on auth changes, on local-repo changes, and on a 30s
// poll as a fallback until WebSocket user_updated events are wired.

import type { ChatHead, TeammateSummary } from "../shared/types";
import * as backend from "./backend";
import * as localRepos from "./localRepos";
import { createEmitter } from "./emitter";

const POLL_INTERVAL_MS = 30_000;
// Coalesce bursts of auth/tracked-repo events into one fetch.
const REFRESH_DEBOUNCE_MS = 200;

let heads: ChatHead[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const changes = createEmitter<ChatHead[]>();

export const onChange = changes.on;
export const list = (): ChatHead[] => heads;

function headForUser(login: string, avatarUrl: string): ChatHead {
  return {
    id: `user:${login}`,
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
    apply([]);
    return;
  }
  try {
    const peers = await backend.listTeammates();
    apply([
      self,
      ...peers.map((t: TeammateSummary) =>
        headForUser(t.githubLogin, t.avatarUrl),
      ),
    ]);
  } catch {
    // Network or auth hiccup — keep showing self so the rail doesn't flash.
    apply([self]);
  }
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
