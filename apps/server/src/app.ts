import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { pingDatabase, type Database } from "./db";
import { githubAuth, cliAuth } from "./auth/github";
import { ingestRoutes } from "./ingest/routes";
import { socialRoutes } from "./social/routes";
import { sessionRoutes } from "./sessions/routes";
import { userRoutes, deviceReposRoutes } from "./user/routes";
import { claimRoutes } from "./user/claim";
import { orgsRoutes } from "./user/orgs";
import { chatRoutes } from "./chat/routes";
import { spotifyPresenceRoutes, presenceReadRoutes } from "./presence/routes";
import { managedAgentSessionRoutes } from "./managed-agent-sessions/routes";
import { mcpRoutes } from "./mcp/routes";
import { mcpOAuthRoutes } from "./oauth/mcp";
import { wsHandler } from "./ws/handler";
import type { RedisBridge } from "./ws/redis-bridge";

const INSTALL_SCRIPT = await Bun.file(
  new URL("./install/install.sh", import.meta.url).pathname,
).text();

export function createApp(db: Database, redis: RedisBridge) {
  return (
    new Elysia()
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
      // Liveness — process is up enough to answer HTTP. Intentionally cheap so
      // a saturated dependency (DB pool exhausted, Redis paused) doesn't get
      // the orchestrator to kill an otherwise-recoverable replica.
      .get("/health", () => ({ status: "ok" }))
      // Readiness — process is fit to serve traffic. Pings each load-bearing
      // dependency with a short timeout. Orchestrators should route traffic
      // only when this returns 200; a 503 here means "drain me" without
      // necessarily restarting.
      .get("/ready", async ({ set }) => {
        const [database, redisOk] = await Promise.all([pingDatabase(), redis.ping()]);
        const ok = database && redisOk;
        if (!ok) set.status = 503;
        return { status: ok ? "ready" : "degraded", database, redis: redisOk };
      })
      .get("/install.sh", ({ set }) => {
        set.headers["content-type"] = "text/plain";
        return INSTALL_SCRIPT;
      })
      .use(githubAuth(db, redis))
      .use(cliAuth(db))
      .use(ingestRoutes(db, redis))
      .use(socialRoutes(db))
      .use(sessionRoutes(db))
      .use(userRoutes(db))
      .use(claimRoutes(db))
      .use(orgsRoutes(db))
      .use(deviceReposRoutes(db))
      .use(chatRoutes(db))
      .use(managedAgentSessionRoutes(db))
      .use(mcpOAuthRoutes(db))
      .use(mcpRoutes())
      .use(spotifyPresenceRoutes(db, redis))
      .use(presenceReadRoutes(db, redis))
      .use(wsHandler(db, redis))
  );
}
