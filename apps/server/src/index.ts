import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { config } from "./config";
import { db } from "./db";
import { githubAuth } from "./auth/github";
import { ingestRoutes } from "./ingest/routes";
import { socialRoutes } from "./social/routes";
import { sessionRoutes } from "./sessions/routes";
import { userRoutes } from "./user/routes";
import { wsHandler } from "./ws/handler";
import { RedisBridge } from "./ws/redis-bridge";

const redis = new RedisBridge();
await redis.connect();

const app = new Elysia()
  .use(cors())
  .use(openapi())
  .get("/health", () => ({ status: "ok" }))
  .use(githubAuth(db))
  .use(ingestRoutes(db))
  .use(socialRoutes(db))
  .use(sessionRoutes(db))
  .use(userRoutes(db))
  .use(wsHandler(db, redis))
  .listen(config.port);

console.log(`slashtalk server running on port ${config.port}`);

export type App = typeof app;
