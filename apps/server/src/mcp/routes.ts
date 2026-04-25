import { Elysia } from "elysia";
import { apiKeyAuth } from "../auth/middleware";
import { McpPresenceStore } from "./presence";
import { McpSessionPool } from "./session-pool";

export const mcpRoutes = () => {
  const presence = new McpPresenceStore();
  const pool = new McpSessionPool({
    name: "slashtalk",
    version: "0.0.1",
    presence,
  });

  return new Elysia({ name: "mcp" })
    .use(apiKeyAuth)
    .all("/mcp", async ({ request, user }) => {
      return pool.handleRequest(request, {
        userId: user.githubLogin,
        profile: {
          ...(user.displayName ? { name: user.displayName } : {}),
          ...(user.avatarUrl ? { avatar: user.avatarUrl } : {}),
        },
      });
    })
    .get("/mcp/presence", () => ({ states: presence.snapshot() }))
    .onStop(() => {
      pool.shutdown();
    });
};
