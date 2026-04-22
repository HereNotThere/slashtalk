import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { eq } from "drizzle-orm";
import { config } from "../config";
import type { Database } from "../db";
import { users, apiKeys, userRepos } from "../db/schema";
import { hashToken } from "../auth/tokens";
import type { RedisBridge } from "./redis-bridge";

const PING_INTERVAL_MS = 30_000;

export const wsHandler = (db: Database, redis: RedisBridge) =>
  new Elysia({ name: "ws" })
    .use(jwt({ name: "jwt", secret: config.jwtSecret }))
    .ws("/ws", {
      query: t.Object({
        token: t.String(),
      }),

      async open(ws) {
        const token = ws.data.query.token;
        let userId: number | null = null;

        // Try JWT first
        const jwtPlugin = ws.data as any;
        if (jwtPlugin.jwt) {
          const payload = await jwtPlugin.jwt.verify(token);
          if (payload?.sub) {
            userId = Number(payload.sub);
          }
        }

        // Try API key if JWT didn't work
        if (!userId) {
          const keyHash = await hashToken(token);
          const [apiKey] = await db
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.keyHash, keyHash))
            .limit(1);
          if (apiKey) {
            userId = apiKey.userId;
          }
        }

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
