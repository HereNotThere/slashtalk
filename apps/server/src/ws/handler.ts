import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { eq } from "drizzle-orm";
import { config } from "../config";
import type { Database } from "../db";
import { users, apiKeys, userRepos } from "../db/schema";
import {
  isSessionCredentialFresh,
  type SessionJwtVerifier,
  verifySessionJwt,
} from "../auth/session";
import { hashToken } from "../auth/tokens";
import type { RedisBridge } from "./redis-bridge";

const PING_INTERVAL_MS = 30_000;
const BASE_ORIGIN = new URL(config.baseUrl).origin;
const BASE_IS_LOOPBACK = isLoopbackHost(new URL(config.baseUrl).hostname);

export const wsHandler = (db: Database, redis: RedisBridge) =>
  new Elysia({ name: "ws" }).use(jwt({ name: "jwt", secret: config.jwtSecret })).ws("/ws", {
    query: t.Object({
      token: t.Optional(t.String()),
    }),

    async open(ws) {
      const jwtPlugin = ws.data as any;
      const queryToken = ws.data.query.token;
      const cookieToken = jwtPlugin.cookie?.session?.value;
      const origin = jwtPlugin.headers?.origin;
      const userId = queryToken
        ? await authenticateQueryToken(db, jwtPlugin.jwt, queryToken)
        : typeof cookieToken === "string"
          ? isAllowedCookieWebSocketOrigin(origin)
            ? await authenticateJwt(db, jwtPlugin.jwt, cookieToken)
            : null
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
  jwtVerifier: SessionJwtVerifier | undefined,
  token: string,
): Promise<number | null> {
  return (await authenticateJwt(db, jwtVerifier, token)) ?? authenticateApiKey(db, token);
}

async function authenticateJwt(
  db: Database,
  jwtVerifier: SessionJwtVerifier | undefined,
  token: string,
): Promise<number | null> {
  const payload = await verifySessionJwt(jwtVerifier, token);
  if (!payload) return null;

  const [user] = await db
    .select({
      id: users.id,
      credentialsRevokedAt: users.credentialsRevokedAt,
    })
    .from(users)
    .where(eq(users.id, Number(payload.sub)))
    .limit(1);
  if (!user) return null;
  if (!isSessionCredentialFresh(user, payload)) return null;

  return user.id;
}

export function isAllowedCookieWebSocketOrigin(origin: string | undefined): boolean {
  if (!origin) return false;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (parsed.origin === BASE_ORIGIN) return true;
  return BASE_IS_LOOPBACK && isLoopbackHost(parsed.hostname);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

async function authenticateApiKey(db: Database, token: string): Promise<number | null> {
  const keyHash = await hashToken(token);
  const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);
  return apiKey?.userId ?? null;
}
