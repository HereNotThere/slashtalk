// Polls GitHub for each known user's recent activity and announces
// PullRequestEvent (opened or merged) to every claimed-repo channel.
//
// This is the only path today that publishes to Redis — see CLAUDE.md
// "Implementation status". Subscribers (WS clients) on `repo:<id>` see a
// `pr_activity` message and the desktop animates the actor's chat head.
//
// Per-user state (lastSeenEventId) is intentionally in-memory: a process
// restart re-baselines from the head of each user's event feed instead of
// replaying old PRs. That's the right tradeoff for a near-real-time presence
// signal — historical PRs don't need to fan out.

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Database } from "../db";
import {
  users,
  repos,
  sessions,
  pullRequests,
  userRepos,
} from "../db/schema";
import { decryptGithubToken } from "../auth/tokens";
import { config } from "../config";
import type { RedisBridge } from "../ws/redis-bridge";
import type {
  PrActivityMessage,
  SessionUpdatedMessage,
} from "@slashtalk/shared";

const POLL_INTERVAL_MS = 60_000;
// Stagger users so we don't pin a single tick at hundreds of req/sec.
const PER_USER_DELAY_MS = 250;

export interface GithubEvent {
  id: string;
  type: string;
  actor: { login: string };
  repo: { name: string }; // "owner/name"
  created_at: string;
  payload: {
    action?: string;
    number?: number;
    pull_request?: {
      merged?: boolean;
      title?: string;
      html_url?: string;
      number?: number;
      state?: "open" | "closed";
      head?: { ref?: string };
      user?: { login?: string };
    };
  };
}

const lastSeenIdByUser = new Map<number, string>();
let timer: ReturnType<typeof setInterval> | null = null;

export function startPrPoller(db: Database, redis: RedisBridge): void {
  if (timer) return;
  // Backfill first so sessions on existing branches have a PR link before the
  // first event poll; then begin polling.
  void backfillOpenPrs(db, redis).then(() => tick(db, redis));
  timer = setInterval(() => void tick(db, redis), POLL_INTERVAL_MS);
}

export function stopPrPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(db: Database, redis: RedisBridge): Promise<void> {
  let userRows: { id: number; githubLogin: string; githubToken: string }[];
  try {
    userRows = await db
      .select({
        id: users.id,
        githubLogin: users.githubLogin,
        githubToken: users.githubToken,
      })
      .from(users)
      .where(isNotNull(users.githubToken));
  } catch (err) {
    console.warn("[pr-poller] failed to load users:", (err as Error).message);
    return;
  }

  for (const u of userRows) {
    await pollUser(db, redis, u);
    await sleep(PER_USER_DELAY_MS);
  }
}

async function pollUser(
  db: Database,
  redis: RedisBridge,
  u: { id: number; githubLogin: string; githubToken: string },
): Promise<void> {
  let token: string;
  try {
    token = await decryptGithubToken(u.githubToken, config.encryptionKey);
  } catch {
    // Old or malformed token — skip rather than spam logs each tick.
    return;
  }

  let res: Response;
  try {
    res = await fetch(
      `https://api.github.com/users/${encodeURIComponent(u.githubLogin)}/events?per_page=30`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `token ${token}`,
          "User-Agent": "slashtalk-pr-poller",
        },
      },
    );
  } catch (err) {
    console.warn(
      `[pr-poller] ${u.githubLogin}: fetch failed:`,
      (err as Error).message,
    );
    return;
  }

  if (res.status === 304) return;
  if (res.status === 401 || res.status === 403) {
    // Token is dead or rate-limited; stay quiet, try again next tick.
    return;
  }
  if (!res.ok) {
    console.warn(`[pr-poller] ${u.githubLogin}: HTTP ${res.status}`);
    return;
  }

  const events = (await res.json()) as GithubEvent[];
  if (!Array.isArray(events) || events.length === 0) return;

  const previous = lastSeenIdByUser.get(u.id);
  lastSeenIdByUser.set(u.id, events[0]!.id);

  // On first poll we still persist PRs we see (so links show up), but skip the
  // celebratory `pr_activity` fan-out to avoid replaying historical pops.
  const isBaselineOnly = !previous;

  const fresh: GithubEvent[] = [];
  for (const ev of events) {
    if (previous && ev.id === previous) break;
    fresh.push(ev);
  }
  if (fresh.length === 0) return;

  for (const ev of fresh) {
    const msg = toPrMessage(ev);
    if (!isBaselineOnly && msg) {
      await fanOut(db, redis, msg);
    }
    await persistPrFromEvent(db, redis, ev);
  }
}

/**
 * One-shot backfill on boot: for every claimed repo that at least one user has
 * an OAuth token for, fetch open PRs and persist them. This closes the gap
 * between server start and the first fresh PullRequestEvent — without it,
 * sessions whose branch already has an open PR would show no link until that
 * PR is touched again.
 *
 * Uses `read:user` tokens which can read public repos fine; private repos
 * without `repo` scope silently 404/403 and are skipped.
 */
export async function backfillOpenPrs(
  db: Database,
  redis: RedisBridge,
): Promise<void> {
  let userRows: { id: number; githubLogin: string; githubToken: string }[];
  try {
    userRows = await db
      .select({
        id: users.id,
        githubLogin: users.githubLogin,
        githubToken: users.githubToken,
      })
      .from(users)
      .where(isNotNull(users.githubToken));
  } catch (err) {
    console.warn("[pr-poller] backfill: load users failed:", (err as Error).message);
    return;
  }
  if (userRows.length === 0) return;

  const userIds = userRows.map((u) => u.id);
  const repoRows = await db
    .select({ id: repos.id, fullName: repos.fullName, userId: userRepos.userId })
    .from(repos)
    .innerJoin(userRepos, eq(userRepos.repoId, repos.id))
    .where(inArray(userRepos.userId, userIds));

  // Pick one token per repo (any claimed user will do for public repos).
  const tokenByUserId = new Map<number, string>();
  for (const u of userRows) {
    try {
      tokenByUserId.set(u.id, await decryptGithubToken(u.githubToken, config.encryptionKey));
    } catch {
      // Skip users whose token can't be decrypted.
    }
  }

  const seenRepo = new Set<number>();
  for (const r of repoRows) {
    if (seenRepo.has(r.id)) continue;
    seenRepo.add(r.id);
    const token = tokenByUserId.get(r.userId);
    if (!token) continue;
    await backfillRepo(db, redis, r.id, r.fullName, token);
    await sleep(PER_USER_DELAY_MS);
  }
}

async function backfillRepo(
  db: Database,
  redis: RedisBridge,
  repoId: number,
  fullName: string,
  token: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.github.com/repos/${fullName}/pulls?state=open&per_page=50`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `token ${token}`,
          "User-Agent": "slashtalk-pr-poller",
        },
      },
    );
  } catch (err) {
    console.warn(`[pr-poller] backfill ${fullName}: fetch failed:`, (err as Error).message);
    return;
  }
  if (!res.ok) {
    // 404/403 → no access (e.g. private repo w/o `repo` scope); just skip.
    return;
  }
  const prs = (await res.json()) as Array<{
    number: number;
    title: string;
    html_url: string;
    state: "open" | "closed";
    head?: { ref?: string };
    user?: { login?: string };
    updated_at: string;
  }>;
  if (!Array.isArray(prs) || prs.length === 0) return;

  for (const pr of prs) {
    const headRef = pr.head?.ref;
    if (!headRef || !pr.number) continue;
    await db
      .insert(pullRequests)
      .values({
        repoId,
        number: pr.number,
        headRef,
        title: pr.title ?? "",
        url: pr.html_url,
        state: "open",
        authorLogin: pr.user?.login ?? "",
        updatedAt: new Date(pr.updated_at),
      })
      .onConflictDoUpdate({
        target: [pullRequests.repoId, pullRequests.number],
        set: {
          headRef,
          title: pr.title ?? "",
          url: pr.html_url,
          state: "open",
          authorLogin: pr.user?.login ?? "",
          updatedAt: new Date(pr.updated_at),
        },
      });

    const matches = await db
      .select({
        sessionId: sessions.sessionId,
        userId: sessions.userId,
        githubLogin: users.githubLogin,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.repoId, repoId), eq(sessions.branch, headRef)));
    for (const m of matches) {
      const upd: SessionUpdatedMessage = {
        type: "session_updated",
        session_id: m.sessionId,
        user_id: m.userId,
        github_login: m.githubLogin,
        repo_id: repoId,
      };
      await redis.publish(`repo:${repoId}`, upd);
    }
  }
  console.log(`[pr-poller] backfilled ${prs.length} open PR(s) for ${fullName}`);
}

/**
 * Upsert the PR into `pull_requests` and publish `session_updated` for every
 * session whose (repo_id, branch) matches the PR's head ref so clients
 * re-fetch and render the new PR link.
 *
 * Accepts opened / reopened / closed events (merged or not) — we want the
 * link visible regardless of state, just marked accordingly. Silently skips
 * if we lack head.ref (some older events omit it).
 */
export async function persistPrFromEvent(
  db: Database,
  redis: RedisBridge,
  ev: GithubEvent,
): Promise<void> {
  if (ev.type !== "PullRequestEvent") return;
  const pr = ev.payload.pull_request;
  const action = ev.payload.action;
  if (!pr) return;
  const headRef = pr.head?.ref;
  if (!headRef) return;
  const number = pr.number ?? ev.payload.number;
  if (!number) return;

  let state: "open" | "closed" | "merged";
  if (action === "opened" || action === "reopened") state = "open";
  else if (action === "closed") state = pr.merged ? "merged" : "closed";
  else return; // ignore edited/labeled/synchronize/etc.

  const [repoRow] = await db
    .select({ id: repos.id })
    .from(repos)
    .where(eqLower(repos.fullName, ev.repo.name))
    .limit(1);
  if (!repoRow) return;

  const url = pr.html_url ?? `https://github.com/${ev.repo.name}/pull/${number}`;
  const authorLogin = pr.user?.login ?? ev.actor.login;

  await db
    .insert(pullRequests)
    .values({
      repoId: repoRow.id,
      number,
      headRef,
      title: pr.title ?? "",
      url,
      state,
      authorLogin,
      updatedAt: new Date(ev.created_at),
    })
    .onConflictDoUpdate({
      target: [pullRequests.repoId, pullRequests.number],
      set: {
        headRef,
        title: pr.title ?? "",
        url,
        state,
        authorLogin,
        updatedAt: new Date(ev.created_at),
      },
    });
  console.log(
    `[pr-poller] upserted PR ${ev.repo.name}#${number} head=${headRef} state=${state}`,
  );

  // Announce to every session on this (repo, branch) so the UI refreshes.
  const matches = await db
    .select({
      sessionId: sessions.sessionId,
      userId: sessions.userId,
      githubLogin: users.githubLogin,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(eq(sessions.repoId, repoRow.id), eq(sessions.branch, headRef)),
    );

  for (const m of matches) {
    const upd: SessionUpdatedMessage = {
      type: "session_updated",
      session_id: m.sessionId,
      user_id: m.userId,
      github_login: m.githubLogin,
      repo_id: repoRow.id,
    };
    await redis.publish(`repo:${repoRow.id}`, upd);
  }
}

export function toPrMessage(ev: GithubEvent): PrActivityMessage | null {
  if (ev.type !== "PullRequestEvent") return null;
  const pr = ev.payload.pull_request;
  if (!pr) return null;
  const action = ev.payload.action;
  let kind: PrActivityMessage["action"] | null = null;
  if (action === "opened" || action === "reopened") kind = "opened";
  else if (action === "closed" && pr.merged) kind = "merged";
  if (!kind) return null;
  return {
    type: "pr_activity",
    action: kind,
    login: ev.actor.login,
    repoFullName: ev.repo.name,
    number: pr.number ?? ev.payload.number ?? 0,
    title: pr.title ?? "",
    url: pr.html_url ?? `https://github.com/${ev.repo.name}`,
    ts: ev.created_at,
  };
}

async function fanOut(
  db: Database,
  redis: RedisBridge,
  msg: PrActivityMessage,
): Promise<void> {
  // Match the event's repo to a claimed repos row. Without that we have no
  // channel to publish on — silently skip (we're the only writer).
  const [row] = await db
    .select({ id: repos.id })
    .from(repos)
    .where(eqLower(repos.fullName, msg.repoFullName))
    .limit(1);
  if (!row) return;
  await redis.publish(`repo:${row.id}`, msg);
}

// Case-insensitive full-name match (GitHub treats "Foo/Bar" === "foo/bar").
function eqLower(col: PgColumn, value: string) {
  return sql`lower(${col}) = lower(${value})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
