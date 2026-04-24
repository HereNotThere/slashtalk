// The teammate rail is derived state, not user-managed.
//
// Heads = the signed-in user plus every peer returned by /api/feed/users —
// users who've signed in at least once AND share at least one claimed repo
// with you. Refreshed on auth changes, on local-repo changes, and on a 30s
// poll as a fallback until WebSocket user_updated events are wired.

import { SessionState } from "@slashtalk/shared";
import type { ChatHead, RailDebugSnapshot } from "../shared/types";
import * as backend from "./backend";
import * as agentStore from "./agentStore";
import * as localRepos from "./localRepos";
import { createEmitter } from "./emitter";
import type { LocalAgent } from "./agentStore";

const POLL_INTERVAL_MS = 30_000;
// Coalesce bursts of auth/tracked-repo events into one fetch.
const REFRESH_DEBOUNCE_MS = 200;
// Re-sort on a clock so heads drift across time buckets (e.g. "now" → "1m")
// even when no new events arrive.
const REBUCKET_TICK_MS = 15_000;

// Relative-time bucket matching the rail's displayed label. Reorders only fire
// when a head crosses a bucket boundary, so "now" peers stop swapping on every
// ingest event. Keep these thresholds in sync with the renderer's label
// formatter (apps/desktop/src/renderer/overlay/...).
function bucketOf(lastActionAt: number | null | undefined, now: number): number {
  if (lastActionAt == null) return 999;
  const ageMs = Math.max(0, now - lastActionAt);
  if (ageMs < 60_000) return 0; // now
  if (ageMs < 120_000) return 1; // 1m
  if (ageMs < 180_000) return 2; // 2m
  if (ageMs < 240_000) return 3; // 3m
  if (ageMs < 300_000) return 4; // 4m
  if (ageMs < 600_000) return 5; // 5m
  if (ageMs < 1_800_000) return 6; // 10m
  if (ageMs < 3_600_000) return 7; // 30m
  if (ageMs < 7_200_000) return 8; // 1h
  if (ageMs < 21_600_000) return 9; // 2h
  if (ageMs < 86_400_000) return 10; // 6h
  return 11; // 1d+
}

// Stable-sort by bucket, breaking ties by prior rail position so peers in the
// same bucket don't swap when either one emits an event.
function sortByBucket(
  next: ChatHead[],
  prior: ChatHead[],
  now: number,
): ChatHead[] {
  const priorIndex = new Map<string, number>();
  prior.forEach((h, i) => priorIndex.set(h.id, i));
  return [...next].sort((a, b) => {
    const ba = bucketOf(a.lastActionAt, now);
    const bb = bucketOf(b.lastActionAt, now);
    if (ba !== bb) return ba - bb;
    const pa = priorIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const pb = priorIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return (b.lastActionAt ?? -1) - (a.lastActionAt ?? -1);
  });
}

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
// Self is always at heads[0] when signed in, with `live` set only while the
// user has a BUSY/ACTIVE feed session. Drives the rail's session-only mode.
export const isSelfLive = (): boolean => heads[0]?.live === true;

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
  isLive?: boolean,
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
    ...(isLive === true && { live: true }),
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

function selfHead(
  lastActivityAt?: number | null,
  isLive?: boolean,
): ChatHead | null {
  const state = backend.getAuthState();
  if (!state.signedIn) return null;
  return headForUser(
    state.user.githubLogin,
    state.user.avatarUrl,
    lastActivityAt,
    isLive,
  );
}

function sameHeads(a: ChatHead[], b: ChatHead[]): boolean {
  if (a.length !== b.length) return false;
  const now = Date.now();
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
    if (a[i].label !== b[i].label) return false;
    if (a[i].avatar.value !== b[i].avatar.value) return false;
    if (a[i].kind !== b[i].kind) return false;
    // Compare bucketed activity, not raw ms — sub-label changes shouldn't
    // retrigger animations or reorders.
    if (bucketOf(a[i].lastActionAt, now) !== bucketOf(b[i].lastActionAt, now))
      return false;
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
  const now = Date.now();
  const agentHeads = sortByBucket(
    agentStore.list().map(headForAgent),
    heads,
    now,
  );
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
    // Live = user has at least one session in BUSY/ACTIVE state. Matches the
    // "working now" label shown in the info popover so the rail and popover
    // agree on who's actively coding right now.
    const liveByLogin = new Set<string>();
    for (const s of feedSessions) {
      if (s.state === SessionState.BUSY || s.state === SessionState.ACTIVE) {
        liveByLogin.add(s.github_login);
      }
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
    const self =
      selfHead(selfLastTs, liveByLogin.has(initialSelf.label)) ?? initialSelf;

    // Client-side filter: drop peers whose sessions don't land on a repo the
    // user has locally tracked AND left selected in the tray popup. Backend
    // returns the full social graph (everyone sharing a repo with us) — this
    // narrows to "people working on the repos I care about today." Before the
    // user has tracked any local repo, pass through so the rail isn't empty.
    const selectedRepos = localRepos.selectedFullNames();
    const trackedCount = localRepos.list().length;
    const filteredPeers =
      trackedCount === 0
        ? peers
        : peers.filter((p) =>
            p.repos.some((r) => selectedRepos.has(r.toLowerCase())),
          );

    const peerHeads = filteredPeers.map((t) =>
      headForUser(
        t.githubLogin,
        t.avatarUrl,
        latestByLogin.get(t.githubLogin) ?? null,
        liveByLogin.has(t.githubLogin),
      ),
    );
    // Merge debug fakes into the peer list so they survive the poll refresh.
    for (const fake of debugFakes) peerHeads.push(fake);
    const sortedPeers = sortByBucket(peerHeads, heads, now);
    apply([self, ...agentHeads, ...sortedPeers]);

    const projectHeads = repos.map((r) =>
      headForRepo(
        r.repoId,
        r.fullName,
        r.owner,
        latestByRepo.get(r.fullName) ?? null,
      ),
    );
    applyProjects(sortByBucket(projectHeads, projects, now));
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
  const merged = sortByBucket([...peers, fake], peers, Date.now());
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

// Re-sort the current rail without refetching, so heads drift positions as
// time advances (e.g. someone who was "now" 90s ago should now sit below any
// live "now" peers even if no new events arrived).
function rebucketTick(): void {
  const now = Date.now();
  if (heads.length > 1) {
    const [self, ...rest] = heads;
    const sorted = sortByBucket(rest, rest, now);
    apply([self, ...sorted]);
  }
  if (projects.length > 0) {
    applyProjects(sortByBucket(projects, projects, now));
  }
}

export function start(): void {
  backend.onChange(scheduleRefresh);
  agentStore.onChange(scheduleRefresh);
  localRepos.onChange(scheduleRefresh);
  localRepos.onSelectionChange(scheduleRefresh);
  setInterval(() => void refresh(), POLL_INTERVAL_MS);
  setInterval(rebucketTick, REBUCKET_TICK_MS);
  void refresh();
}
