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

import { isNotNull, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Database } from "../db";
import { users, repos } from "../db/schema";
import { decryptGithubToken } from "../auth/tokens";
import { config } from "../config";
import type { RedisBridge } from "../ws/redis-bridge";
import type { PrActivityMessage } from "@slashtalk/shared";

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
    };
  };
}

const lastSeenIdByUser = new Map<number, string>();
let timer: ReturnType<typeof setInterval> | null = null;

export function startPrPoller(db: Database, redis: RedisBridge): void {
  if (timer) return;
  void tick(db, redis);
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
  // First poll for this user: baseline only — don't replay history.
  lastSeenIdByUser.set(u.id, events[0]!.id);
  if (!previous) return;

  // Walk newest → oldest until we hit the prior watermark.
  const fresh: GithubEvent[] = [];
  for (const ev of events) {
    if (ev.id === previous) break;
    fresh.push(ev);
  }
  if (fresh.length === 0) return;

  for (const ev of fresh) {
    const msg = toPrMessage(ev);
    if (!msg) continue;
    await fanOut(db, redis, msg);
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
