// Ephemeral "now playing on Spotify" presence.
//
// Desktop clients POST /v1/presence/spotify (apiKey auth) whenever their
// current track changes or every ~minute as a keepalive. We cache it in
// Redis with a short TTL so peers can see it without ever hitting Postgres.
// Readers GET /api/presence/peers (jwt) — returns presence keyed by
// github_login for the signed-in user plus every peer who shares a claimed
// repo.

import { Elysia, t } from "elysia";
import { eq, inArray } from "drizzle-orm";
import type {
  PeerPresenceEntry,
  PeerPresenceResponse,
  QuotaByLogin,
  QuotaPresence,
  QuotaSource,
  SpotifyPresence,
} from "@slashtalk/shared";
import type { Database } from "../db";
import { apiKeyAuth, jwtAuth } from "../auth/middleware";
import type { RedisBridge } from "../ws/redis-bridge";
import { userRepos, users } from "../db/schema";
import { publishQuotaUpdate, quotaKey, QUOTA_SOURCES, writeAndPublishQuotaPresence } from "./quota";

const TTL_SECONDS = 120;

function key(userId: number): string {
  return `presence:spotify:user:${userId}`;
}

async function publishPresence(
  db: Database,
  redis: RedisBridge,
  userId: number,
  githubLogin: string,
  spotify: SpotifyPresence | null,
): Promise<void> {
  const repoRows = await db
    .select({ repoId: userRepos.repoId })
    .from(userRepos)
    .where(eq(userRepos.userId, userId));

  const msg = {
    type: "presence_updated",
    user_id: userId,
    github_login: githubLogin,
    spotify,
  } as const;

  void redis.publish(`user:${userId}`, msg);
  for (const r of repoRows) {
    void redis.publish(`repo:${r.repoId}`, msg);
  }
}

export const spotifyPresenceRoutes = (db: Database, redis: RedisBridge) =>
  new Elysia({ prefix: "/v1", name: "spotify-presence" }).use(apiKeyAuth).post(
    "/presence/spotify",
    async ({ body, user }) => {
      if (body.track === null) {
        await redis.del(key(user.id));
        await publishPresence(db, redis, user.id, user.githubLogin, null);
        return { ok: true as const };
      }
      const payload: SpotifyPresence = {
        trackId: body.track.trackId,
        name: body.track.name,
        artist: body.track.artist,
        url: body.track.url,
        isPlaying: body.track.isPlaying,
        updatedAt: new Date().toISOString(),
      };
      await redis.setex(key(user.id), TTL_SECONDS, payload);
      await publishPresence(db, redis, user.id, user.githubLogin, payload);
      return { ok: true as const };
    },
    {
      body: t.Object({
        track: t.Union([
          t.Null(),
          t.Object({
            trackId: t.String(),
            name: t.String(),
            artist: t.String(),
            url: t.String(),
            isPlaying: t.Boolean(),
          }),
        ]),
      }),
    },
  );

// Peer set = every user who shares ≥1 claimed repo with me. Self is always
// included so the caller can render its own card without a second fetch.
async function getPeerUserIds(db: Database, userId: number): Promise<number[]> {
  const myRepoIds = db
    .select({ repoId: userRepos.repoId })
    .from(userRepos)
    .where(eq(userRepos.userId, userId));
  const peerRows = await db
    .selectDistinct({ userId: userRepos.userId })
    .from(userRepos)
    .where(inArray(userRepos.repoId, myRepoIds));
  return [...new Set([userId, ...peerRows.map((r) => r.userId)])];
}

// Sources the POST endpoint will accept. Mirrors QUOTA_SOURCES but exposed as
// a t.Union for elysia validation. Sources outside this set are rejected with
// 422 — keeps the wire contract honest with what the read path will surface.
const acceptedQuotaSourceSchema = t.Union(QUOTA_SOURCES.map((s) => t.Literal(s)));

const quotaWindowSchema = t.Object({
  label: t.String(),
  usedPercent: t.Union([t.Null(), t.Number()]),
  resetsAt: t.Union([t.Null(), t.String()]),
});

const quotaBodySchema = t.Object({
  source: acceptedQuotaSourceSchema,
  // null = clear my quota for this source. Passed-through wins out over
  // arguing about whether 0% means "no quota left" vs "no data".
  presence: t.Union([
    t.Null(),
    t.Object({
      plan: t.Union([t.Null(), t.String()]),
      windows: t.Array(quotaWindowSchema),
    }),
  ]),
});

export const quotaPresenceRoutes = (db: Database, redis: RedisBridge) =>
  new Elysia({ prefix: "/v1", name: "quota-presence" }).use(apiKeyAuth).post(
    "/presence/quota",
    async ({ body, user }) => {
      if (body.presence === null) {
        await redis.del(quotaKey(user.id, body.source));
        await publishQuotaUpdate(db, redis, user.id, user.githubLogin, body.source, null);
        return { ok: true as const };
      }
      const stamped: QuotaPresence = {
        source: body.source,
        plan: body.presence.plan,
        windows: body.presence.windows,
        updatedAt: new Date().toISOString(),
      };
      await writeAndPublishQuotaPresence(db, redis, user.id, user.githubLogin, stamped);
      return { ok: true as const };
    },
    { body: quotaBodySchema },
  );

async function loadPeerEntry(
  redis: RedisBridge,
  userId: number,
): Promise<PeerPresenceEntry | null> {
  const [spotify, ...quotaResults] = await Promise.all([
    redis.getJson<SpotifyPresence>(key(userId)),
    ...QUOTA_SOURCES.map((s) => redis.getJson<QuotaPresence>(quotaKey(userId, s))),
  ]);

  let quota: QuotaByLogin | undefined;
  for (let i = 0; i < QUOTA_SOURCES.length; i++) {
    const q = quotaResults[i];
    if (q) {
      quota ??= {};
      quota[QUOTA_SOURCES[i]!] = q;
    }
  }

  if (!spotify && !quota) return null;
  const entry: PeerPresenceEntry = {};
  if (spotify) entry.spotify = spotify;
  if (quota) entry.quota = quota;
  return entry;
}

export const presenceReadRoutes = (db: Database, redis: RedisBridge) =>
  new Elysia({ prefix: "/api", name: "presence-read" })
    .use(jwtAuth)
    .get("/presence/peers", async ({ user }): Promise<PeerPresenceResponse> => {
      const ids = await getPeerUserIds(db, user.id);
      if (ids.length === 0) return {};

      const userRows = await db
        .select({ id: users.id, githubLogin: users.githubLogin })
        .from(users)
        .where(inArray(users.id, ids));

      const entries = await Promise.all(
        userRows.map(async (u) => {
          const entry = await loadPeerEntry(redis, u.id);
          return [u.githubLogin, entry] as const;
        }),
      );
      const result: PeerPresenceResponse = {};
      for (const [login, entry] of entries) {
        if (entry) result[login] = entry;
      }
      return result;
    })
    .get("/presence/locations", async ({ user }) => {
      // Reads persisted timezone+city off the users table (no redis).
      const ids = await getPeerUserIds(db, user.id);
      type Loc = { timezone: string | null; city: string | null };
      if (ids.length === 0) return {} as Record<string, Loc>;

      const rows = await db
        .select({
          githubLogin: users.githubLogin,
          timezone: users.timezone,
          city: users.city,
        })
        .from(users)
        .where(inArray(users.id, ids));

      const result: Record<string, Loc> = {};
      for (const r of rows) {
        if (!r.timezone && !r.city) continue;
        result[r.githubLogin] = { timezone: r.timezone, city: r.city };
      }
      return result;
    });
