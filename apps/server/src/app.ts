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
import { spotifyPresenceRoutes, presenceReadRoutes } from "./presence/routes";
import { managedAgentSessionRoutes } from "./managed-agent-sessions/routes";
import { mcpRoutes } from "./mcp/routes";
import { mcpOAuthRoutes } from "./oauth/mcp";
import { wsHandler } from "./ws/handler";
import type { RedisBridge } from "./ws/redis-bridge";

const INSTALL_SCRIPT = await Bun.file(
  new URL("./install/install.sh", import.meta.url).pathname
).text();

export function createApp(db: Database, redis: RedisBridge) {
  return new Elysia()
    .use(
      cors({
        allowedHeaders: [
          "content-type",
          "mcp-session-id",
          "mcp-protocol-version",
          "accept",
          "authorization",
          "cookie",
        ],
        exposeHeaders: ["mcp-session-id", "www-authenticate"],
      }),
    )
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
    .use(managedAgentSessionRoutes(db))
    .use(mcpOAuthRoutes(db))
    .use(mcpRoutes())
    .use(spotifyPresenceRoutes(db, redis))
    .use(presenceReadRoutes(db, redis))
    .use(wsHandler(db, redis));
}
