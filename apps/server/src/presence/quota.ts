// Per-source quota presence. Mirrors the spotify presence pattern:
// SETEX a small JSON blob in Redis under presence:quota:{source}:user:{userId},
// then publish "presence_updated" so live WS subscribers refresh. Source-keyed
// so adding Claude later is just adding another extractor — readers MGET each
// source they care about.

import { eq } from "drizzle-orm";
import type { QuotaPresence, QuotaSource, QuotaWindow } from "@slashtalk/shared";
import type { Database } from "../db";
import { userRepos } from "../db/schema";
import type { RedisBridge } from "../ws/redis-bridge";

// Quota state changes on the order of minutes-to-hours, not seconds. A long
// TTL means a user who closes their CLI keeps their last-known quota visible
// (which is still semantically correct — the window doesn't reset because they
// stopped working). UI freshness should lean on resetsAt, not updatedAt.
const TTL_SECONDS = 24 * 60 * 60;

export const quotaKey = (userId: number, source: QuotaSource): string =>
  `presence:quota:${source}:user:${userId}`;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Codex labels we recognize. Anything else falls through to a minutes-based
// label so a vendor change won't drop the window — it just renders "{n}m".
function windowLabel(windowMinutes: number | null): string {
  if (windowMinutes === null) return "window";
  if (windowMinutes === 300) return "5h";
  if (windowMinutes === 10080) return "week";
  if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
  return `${windowMinutes}m`;
}

function parseCodexWindow(raw: unknown): QuotaWindow | null {
  if (!isObj(raw)) return null;
  const windowMinutes = asNumber(raw.window_minutes);
  const usedPercent = asNumber(raw.used_percent);
  const resetsEpoch = asNumber(raw.resets_at);
  // Drop entirely-empty windows so we don't render a hollow row.
  if (windowMinutes === null && usedPercent === null && resetsEpoch === null) {
    return null;
  }
  return {
    label: windowLabel(windowMinutes),
    usedPercent,
    resetsAt: resetsEpoch !== null ? new Date(resetsEpoch * 1000).toISOString() : null,
  };
}

/**
 * Extracts a QuotaPresence from a Codex `event_msg.token_count` payload. Both
 * `info` and `rate_limits` live on the same payload; this looks at rate_limits.
 * Returns null when the event has no usable rate-limit info.
 *
 * Shape (from a real session, 2026-04-27):
 *   { rate_limits: {
 *       limit_id, limit_name, plan_type, credits, rate_limit_reached_type,
 *       primary:   { used_percent, window_minutes, resets_at },
 *       secondary: { used_percent, window_minutes, resets_at },
 *     }, ... }
 */
export function extractCodexQuota(payload: unknown): QuotaPresence | null {
  if (!isObj(payload)) return null;
  const rl = payload.rate_limits;
  if (!isObj(rl)) return null;

  const windows: QuotaWindow[] = [];
  const primary = parseCodexWindow(rl.primary);
  if (primary) windows.push(primary);
  const secondary = parseCodexWindow(rl.secondary);
  if (secondary) windows.push(secondary);
  if (windows.length === 0) return null;

  return {
    source: "codex",
    plan: asString(rl.plan_type),
    windows,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Extracts the *latest* quota signal from a batch of accepted Codex events.
 * Multiple `token_count` events can land in one ingest tick — only the last
 * one's quota is interesting since it represents the freshest view.
 */
export function extractCodexQuotaFromBatch(events: unknown[]): QuotaPresence | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!isObj(ev)) continue;
    if (ev.type !== "event_msg") continue;
    const payload = ev.payload;
    if (!isObj(payload)) continue;
    if (payload.type !== "token_count") continue;
    const quota = extractCodexQuota(payload);
    if (quota) return quota;
  }
  return null;
}

/**
 * Soft-fail Redis write — a transient Redis error must never break ingest.
 * Per core-beliefs #7, redis.publish is fire-and-forget; we await setex
 * because the read path depends on it being durable.
 */
export async function writeQuotaPresence(
  redis: RedisBridge,
  userId: number,
  quota: QuotaPresence,
): Promise<void> {
  try {
    await redis.setex(quotaKey(userId, quota.source), TTL_SECONDS, quota);
  } catch (err) {
    console.warn(`[quota] redis setex failed for user=${userId}:`, (err as Error).message);
  }
}

/**
 * Fan out a `presence_updated` to the user's WS channel and every repo channel
 * they participate in. Mirrors the spotify presence pattern so live
 * subscribers refresh without waiting for the next 15s peer-poll. Pure
 * fire-and-forget: redis.publish never throws (already soft-fail), and the
 * userRepos lookup is a small read that's allowed to fail loudly — if it
 * does, the only consequence is a single missed real-time refresh.
 */
export async function publishQuotaUpdate(
  db: Database,
  redis: RedisBridge,
  userId: number,
  githubLogin: string,
  source: QuotaSource,
  presence: QuotaPresence | null,
): Promise<void> {
  const repoRows = await db
    .select({ repoId: userRepos.repoId })
    .from(userRepos)
    .where(eq(userRepos.userId, userId));
  const msg = {
    type: "presence_updated",
    user_id: userId,
    github_login: githubLogin,
    quota: { source, presence },
  } as const;
  void redis.publish(`user:${userId}`, msg);
  for (const r of repoRows) {
    void redis.publish(`repo:${r.repoId}`, msg);
  }
}

/**
 * Combined SETEX + publish — every ingest path that writes a quota also wants
 * the live notification, and the Claude POST endpoint does too. Keeping them
 * in one helper makes "forgot to publish" impossible (the original ingest
 * bug). The Claude POST clear path (presence: null) doesn't go through here
 * because it uses redis.del instead of setex.
 */
export async function writeAndPublishQuotaPresence(
  db: Database,
  redis: RedisBridge,
  userId: number,
  githubLogin: string,
  quota: QuotaPresence,
): Promise<void> {
  await writeQuotaPresence(redis, userId, quota);
  await publishQuotaUpdate(db, redis, userId, githubLogin, quota.source, quota);
}

/** All sources whose quota we accept and surface. Codex is extracted
 *  server-side from JSONL on ingest; Claude is pushed by the desktop
 *  collector via POST /v1/presence/quota since its on-disk state has no
 *  rate-limit windows. */
export const QUOTA_SOURCES: readonly QuotaSource[] = ["codex", "claude"] as const;
