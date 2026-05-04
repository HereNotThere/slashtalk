import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { config } from "../config";
import type { Database } from "../db";
import { createAuthInstanceForDb } from "../auth/instance";
import type { SessionJwtVerifier } from "../auth/session";
import { visibleRepoIdsForUser } from "../repo/visibility";
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
      const auth = createAuthInstanceForDb(db);
      const userId = queryToken
        ? await authenticateQueryToken(auth, jwtPlugin.jwt, queryToken)
        : typeof cookieToken === "string"
          ? isAllowedCookieWebSocketOrigin(origin)
            ? ((await auth.resolveSessionJwt(jwtPlugin.jwt, cookieToken))?.id ?? null)
            : null
          : null;

      if (!userId) {
        ws.close(4001, "Unauthorized");
        return;
      }

      // Subscribe to all user's repo channels
      const repoIds = await visibleRepoIdsForUser(db, userId);

      const handler = (_channel: string, message: string) => {
        ws.send(message);
      };

      // Store handler reference for cleanup
      (ws.data as any)._redisHandler = handler;
      (ws.data as any)._userId = userId;

      for (const repoId of repoIds) {
        await redis.subscribe(`repo:${repoId}`, handler);
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
  auth: ReturnType<typeof createAuthInstanceForDb>,
  jwtVerifier: SessionJwtVerifier | undefined,
  token: string,
): Promise<number | null> {
  const sessionUser = await auth.resolveSessionJwt(jwtVerifier, token);
  if (sessionUser) return sessionUser.id;
  const apiKey = await auth.resolveApiKey(token, { touchLastUsedAt: false });
  return apiKey.ok ? apiKey.value.user.id : null;
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
