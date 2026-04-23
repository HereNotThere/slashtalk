import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import type { Database } from "./db";
import { githubAuth, cliAuth } from "./auth/github";
import { ingestRoutes } from "./ingest/routes";
import { socialRoutes } from "./social/routes";
import { sessionRoutes } from "./sessions/routes";
import { userRoutes, deviceReposRoutes } from "./user/routes";
import { chatRoutes } from "./chat/routes";
import { wsHandler } from "./ws/handler";
import type { RedisBridge } from "./ws/redis-bridge";

const INSTALL_SCRIPT = await Bun.file(
  new URL("./install/install.sh", import.meta.url).pathname
).text();

export function createApp(db: Database, redis: RedisBridge) {
  return new Elysia()
    .use(cors())
    .use(openapi())
    .get("/health", () => ({ status: "ok" }))
    .get("/install.sh", ({ set }) => {
      set.headers["content-type"] = "text/plain";
      return INSTALL_SCRIPT;
    })
    .use(githubAuth(db))
    .use(cliAuth(db))
    .use(ingestRoutes(db, redis))
    .use(socialRoutes(db))
    .use(sessionRoutes(db))
    .use(userRoutes(db))
    .use(deviceReposRoutes(db))
    .use(chatRoutes(db))
    .use(wsHandler(db, redis));
}
