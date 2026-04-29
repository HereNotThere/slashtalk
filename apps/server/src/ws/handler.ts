import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { eq } from "drizzle-orm";
import { config } from "../config";
import type { Database } from "../db";
import { users, apiKeys, userRepos } from "../db/schema";
import { hashToken } from "../auth/tokens";
import type { RedisBridge } from "./redis-bridge";

const PING_INTERVAL_MS = 30_000;

type SessionJwtPayload = {
  sub?: string | number;
  iat?: number | boolean;
  sessionIssuedAt?: number;
};

export const wsHandler = (db: Database, redis: RedisBridge) =>
  new Elysia({ name: "ws" }).use(jwt({ name: "jwt", secret: config.jwtSecret })).ws("/ws", {
    query: t.Object({
      token: t.Optional(t.String()),
    }),

    async open(ws) {
      const jwtPlugin = ws.data as any;
      const queryToken = ws.data.query.token;
      const cookieToken = jwtPlugin.cookie?.session?.value;
      const userId = queryToken
        ? await authenticateQueryToken(db, jwtPlugin.jwt, queryToken)
        : typeof cookieToken === "string"
          ? await authenticateJwt(db, jwtPlugin.jwt, cookieToken)
          : null;

      if (!userId) {
        ws.close(4001, "Unauthorized");
        return;
      }

      // Subscribe to all user's repo channels
      const repoRows = await db
        .select({ repoId: userRepos.repoId })
        .from(userRepos)
        .where(eq(userRepos.userId, userId));

      const handler = (_channel: string, message: string) => {
        ws.send(message);
      };

      // Store handler reference for cleanup
      (ws.data as any)._redisHandler = handler;
      (ws.data as any)._userId = userId;

      for (const row of repoRows) {
        await redis.subscribe(`repo:${row.repoId}`, handler);
      }
      // Also subscribe to personal channel
      await redis.subscribe(`user:${userId}`, handler);

      // Start ping keepalive
      const pingTimer = setInterval(() => {
        ws.send(JSON.stringify({ type: "ping" }));
      }, PING_INTERVAL_MS);
      (ws.data as any)._pingTimer = pingTimer;
    },

    async close(ws) {
      const handler = (ws.data as any)._redisHandler;
      const pingTimer = (ws.data as any)._pingTimer;

      if (pingTimer) clearInterval(pingTimer);
      if (handler) await redis.unsubscribeAll(handler);
    },

    message(_ws, _message) {
      // Server → Client only; ignore client messages
    },
  });

async function authenticateQueryToken(
  db: Database,
  jwtVerifier: { verify: (token: string) => Promise<false | SessionJwtPayload> } | undefined,
  token: string,
): Promise<number | null> {
  return (await authenticateJwt(db, jwtVerifier, token)) ?? authenticateApiKey(db, token);
}

async function authenticateJwt(
  db: Database,
  jwtVerifier: { verify: (token: string) => Promise<false | SessionJwtPayload> } | undefined,
  token: string,
): Promise<number | null> {
  if (!jwtVerifier) return null;
  let payload: false | SessionJwtPayload;
  try {
    payload = await jwtVerifier.verify(token);
  } catch {
    return null;
  }
  if (payload === false || !payload.sub) return null;

  const [user] = await db
    .select({
      id: users.id,
      credentialsRevokedAt: users.credentialsRevokedAt,
    })
    .from(users)
    .where(eq(users.id, Number(payload.sub)))
    .limit(1);
  if (!user) return null;

  if (user.credentialsRevokedAt) {
    const issuedAtMs =
      typeof payload.sessionIssuedAt === "number"
        ? payload.sessionIssuedAt
        : typeof payload.iat === "number"
          ? payload.iat * 1000
          : null;
    if (!issuedAtMs || issuedAtMs < user.credentialsRevokedAt.getTime()) return null;
  }

  return user.id;
}

async function authenticateApiKey(db: Database, token: string): Promise<number | null> {
  const keyHash = await hashToken(token);
  const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);
  return apiKey?.userId ?? null;
}
