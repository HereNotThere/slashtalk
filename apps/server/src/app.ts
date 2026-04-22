import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import type { Database } from "./db";
import { githubAuth } from "./auth/github";
import { ingestRoutes } from "./ingest/routes";
import { socialRoutes } from "./social/routes";
import { sessionRoutes } from "./sessions/routes";
import { userRoutes } from "./user/routes";
import { wsHandler } from "./ws/handler";
import type { RedisBridge } from "./ws/redis-bridge";

export function createApp(db: Database, redis: RedisBridge) {
  return new Elysia()
    .use(cors())
    .use(openapi())
    .get("/health", () => ({ status: "ok" }))
    .use(githubAuth(db))
    .use(ingestRoutes(db, redis))
    .use(socialRoutes(db))
    .use(sessionRoutes(db))
    .use(userRoutes(db))
    .use(wsHandler(db, redis));
}
