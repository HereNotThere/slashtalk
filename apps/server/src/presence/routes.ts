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
import type { SpotifyPresence } from "@slashtalk/shared";
import type { Database } from "../db";
import { apiKeyAuth, jwtAuth } from "../auth/middleware";
import type { RedisBridge } from "../ws/redis-bridge";
import { userRepos, users } from "../db/schema";

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

export const presenceReadRoutes = (db: Database, redis: RedisBridge) =>
  new Elysia({ prefix: "/api", name: "presence-read" })
    .use(jwtAuth)
    .get("/presence/peers", async ({ user }) => {
      // Peers = every user who shares ≥1 claimed repo with me. Include self
      // so the caller can also render its own card without a second fetch.
      const myRepoIds = db
        .select({ repoId: userRepos.repoId })
        .from(userRepos)
        .where(eq(userRepos.userId, user.id));
      const peerRows = await db
        .selectDistinct({ userId: userRepos.userId })
        .from(userRepos)
        .where(inArray(userRepos.repoId, myRepoIds));

      const ids = [...new Set([user.id, ...peerRows.map((r) => r.userId)])];
      if (ids.length === 0) return {} as Record<string, SpotifyPresence>;

      const userRows = await db
        .select({ id: users.id, githubLogin: users.githubLogin })
        .from(users)
        .where(inArray(users.id, ids));

      const entries = await Promise.all(
        userRows.map(async (u) => {
          const presence = await redis.getJson<SpotifyPresence>(key(u.id));
          return [u.githubLogin, presence] as const;
        }),
      );
      const result: Record<string, SpotifyPresence> = {};
      for (const [login, presence] of entries) {
        if (presence) result[login] = presence;
      }
      return result;
    });
