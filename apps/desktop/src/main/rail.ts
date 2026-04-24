// The teammate rail is derived state, not user-managed.
//
// Heads = the signed-in user plus every peer returned by /api/feed/users —
// users who've signed in at least once AND share at least one claimed repo
// with you. Refreshed on auth changes, on local-repo changes, and on a 30s
// poll as a fallback until WebSocket user_updated events are wired.

import type { ChatHead, RailDebugSnapshot } from "../shared/types";
import * as backend from "./backend";
import * as agentStore from "./agentStore";
import * as localRepos from "./localRepos";
import * as orgRepos from "./orgRepos";
import { createEmitter } from "./emitter";
import type { LocalAgent } from "./agentStore";

const POLL_INTERVAL_MS = 30_000;
// Coalesce bursts of auth/tracked-repo events into one fetch.
const REFRESH_DEBOUNCE_MS = 200;

let heads: ChatHead[] = [];
let projects: ChatHead[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const changes = createEmitter<ChatHead[]>();
const projectChanges = createEmitter<ChatHead[]>();

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
export const onProjectsChange = projectChanges.on;
export const listProjects = (): ChatHead[] => projects;

const USER_HEAD_PREFIX = "user:";
const AGENT_HEAD_PREFIX = "agent:";
const REPO_HEAD_PREFIX = "repo:";

export function userHeadId(login: string): string {
  return `${USER_HEAD_PREFIX}${login}`;
}

export function parseUserHeadId(headId: string): string | null {
  return headId.startsWith(USER_HEAD_PREFIX)
    ? headId.slice(USER_HEAD_PREFIX.length)
    : null;
}

export function agentHeadId(agentId: string): string {
  return `${AGENT_HEAD_PREFIX}${agentId}`;
}

export function parseAgentHeadId(headId: string): string | null {
  return headId.startsWith(AGENT_HEAD_PREFIX)
    ? headId.slice(AGENT_HEAD_PREFIX.length)
    : null;
}

export function repoHeadId(repoId: number): string {
  return `${REPO_HEAD_PREFIX}${repoId}`;
}

export function parseRepoHeadId(headId: string): number | null {
  if (!headId.startsWith(REPO_HEAD_PREFIX)) return null;
  const n = Number(headId.slice(REPO_HEAD_PREFIX.length));
  return Number.isFinite(n) ? n : null;
}

function repoOwnerAvatarUrl(owner: string): string {
  // GitHub serves an org/user avatar at this URL regardless of the specific
  // repo; the repos table has no avatar column so we derive one. s=90 gives
  // retina-clean rendering at our 45px bubble size.
  return `https://avatars.githubusercontent.com/${encodeURIComponent(owner)}?s=90&v=4`;
}

function headForUser(
  login: string,
  avatarUrl: string,
  lastActivityAt?: number | null,
): ChatHead {
  const prAt = prActivityByLogin.get(login);
  return {
    id: userHeadId(login),
    kind: "user",
    label: login,
    tint: "transparent",
    avatar: { type: "remote", value: avatarUrl },
    ...(lastActivityAt != null && { lastActionAt: lastActivityAt }),
    ...(prAt != null && { prActivityAt: prAt }),
  };
}

function headForAgent(agent: LocalAgent): ChatHead {
  const initial = (agent.name[0] ?? "A").toUpperCase();
  return {
    id: agentHeadId(agent.id),
    label: agent.name,
    tint: "var(--color-accent)",
    avatar: { type: "emoji", value: initial },
    kind: "agent",
    lastActionAt: agent.createdAt,
  };
}

function headForRepo(
  repoId: number,
  fullName: string,
  owner: string,
  lastActivityAt?: number | null,
): ChatHead {
  return {
    id: repoHeadId(repoId),
    kind: "repo",
    label: fullName,
    tint: "transparent",
    avatar: { type: "remote", value: repoOwnerAvatarUrl(owner) },
    repoId,
    repoFullName: fullName,
    ...(lastActivityAt != null && { lastActionAt: lastActivityAt }),
  };
}

function selfHead(lastActivityAt?: number | null): ChatHead | null {
  const state = backend.getAuthState();
  if (!state.signedIn) return null;
  return headForUser(state.user.githubLogin, state.user.avatarUrl, lastActivityAt);
}

function sameHeads(a: ChatHead[], b: ChatHead[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
    if (a[i].label !== b[i].label) return false;
    if (a[i].avatar.value !== b[i].avatar.value) return false;
    if (a[i].kind !== b[i].kind) return false;
    if (a[i].lastActionAt !== b[i].lastActionAt) return false;
    if (a[i].live !== b[i].live) return false;
    if (a[i].unread !== b[i].unread) return false;
    if (a[i].prActivityAt !== b[i].prActivityAt) return false;
  }
  return true;
}

function apply(next: ChatHead[]): void {
  if (sameHeads(heads, next)) return;
  heads = next;
  changes.emit(heads);
}

function applyProjects(next: ChatHead[]): void {
  if (sameHeads(projects, next)) return;
  projects = next;
  projectChanges.emit(projects);
}

async function refresh(): Promise<void> {
  const initialSelf = selfHead();
  if (!initialSelf) {
    console.log("[rail] refresh skipped — not signed in");
    lastSnapshot = { at: Date.now(), peers: null, error: "not signed in" };
    apply([]);
    applyProjects([]);
    return;
  }
  console.log(`[rail] refresh as ${initialSelf.label}`);
  const agentHeads = agentStore
    .list()
    .map(headForAgent)
    .sort((a, b) => (b.lastActionAt ?? -1) - (a.lastActionAt ?? -1));
  try {
    // Fetch peers, feed, and claimed repos in parallel. Each peer's / repo's
    // "last activity" is the timestamp of the most recent session in the feed
    // keyed by login / repo_full_name — no dedicated backend field needed.
    const [peers, feedSessions, repos] = await Promise.all([
      backend.listTeammates(),
      backend.listFeedSessions(),
      backend.listRepos().catch((err) => {
        console.warn("[rail] listRepos failed:", err);
        return [];
      }),
    ]);

    const latestByLogin = new Map<string, number>();
    const latestByRepo = new Map<string, number>();
    for (const s of feedSessions) {
      if (!s.lastTs) continue;
      const ts = new Date(s.lastTs).getTime();
      const prevU = latestByLogin.get(s.github_login) ?? 0;
      if (ts > prevU) latestByLogin.set(s.github_login, ts);
      if (s.repo_full_name) {
        const prevR = latestByRepo.get(s.repo_full_name) ?? 0;
        if (ts > prevR) latestByRepo.set(s.repo_full_name, ts);
      }
    }

    lastSnapshot = { at: Date.now(), peers, error: null };
    const selfLastTs = latestByLogin.get(initialSelf.label) ?? null;
    console.log(
      `[rail] self=${initialSelf.label} selfLastTs=${selfLastTs} feedCount=${feedSessions.length} latestByLogin=${JSON.stringify([...latestByLogin.entries()])}`,
    );
    const self = selfHead(selfLastTs) ?? initialSelf;

    // Client-side filter: drop peers with no session in a repo the user has
    // selected in the tray popup. Backend returns the full org roster; this
    // narrows it to the user's local "repos I care about today" set.
    //
    // Only filter when we actually have repo data for the active org.
    // Without that check, a restored-from-store activeOrg combined with a
    // still-pending or scope-blocked GitHub fetch would silently drop every
    // peer from the rail — breaking the core "teammates list" feature.
    //
    // Compare case-insensitively: GitHub full names are case-insensitive, but
    // /api/feed/users returns them lowercased (via the server's normalization)
    // while /api/me/orgs/:org/repos preserves GitHub's natural owner/name
    // casing. A literal set lookup across those two sources yields zero
    // overlap and drops every peer.
    const filteredPeers = orgRepos.hasLoadedReposForActiveOrg()
      ? peers.filter((p) =>
          p.repos.some((r) =>
            orgRepos.getSelectedFullNamesLowerSet().has(r.toLowerCase()),
          ),
        )
      : peers;

    const peerHeads = filteredPeers.map((t) =>
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
    apply([self, ...agentHeads, ...peerHeads]);

    const projectHeads = repos.map((r) =>
      headForRepo(
        r.repoId,
        r.fullName,
        r.owner,
        latestByRepo.get(r.fullName) ?? null,
      ),
    );
    projectHeads.sort((a, b) => (b.lastActionAt ?? -1) - (a.lastActionAt ?? -1));
    applyProjects(projectHeads);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastSnapshot = { at: Date.now(), peers: null, error: message };
    console.error("[rail] listTeammates failed:", err);
    // Keep showing self + agents so the rail doesn't flash.
    apply([initialSelf, ...agentHeads]);
    applyProjects([]);
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
    kind: "user",
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
  agentStore.onChange(scheduleRefresh);
  localRepos.onChange(scheduleRefresh);
  orgRepos.onActiveOrgChange(scheduleRefresh);
  orgRepos.onSelectionChange(scheduleRefresh);
  setInterval(() => void refresh(), POLL_INTERVAL_MS);
  void refresh();
}
