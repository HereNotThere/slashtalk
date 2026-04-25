import { Elysia } from "elysia";
import { db } from "../db";
import { users, apiKeys, devices } from "../db/schema";
import { hashToken } from "../auth/tokens";
import { mcpWwwAuthenticate } from "../oauth/mcp";
import { McpPresenceStore } from "./presence";
import { McpSessionPool } from "./session-pool";
import { eq } from "drizzle-orm";

export const mcpRoutes = () => {
  const presence = new McpPresenceStore();
  const pool = new McpSessionPool({
    name: "slashtalk",
    version: "0.0.1",
    presence,
  });

  return new Elysia({ name: "mcp" })
    .all("/mcp", async ({ request, set }) => {
      const auth = await authenticateMcpRequest(request);
      if (!auth) {
        set.status = 401;
        set.headers["www-authenticate"] = mcpWwwAuthenticate(
          new URL(request.url).origin,
        );
        return "Invalid or missing bearer token";
      }

      return pool.handleRequest(request, {
        userId: auth.user.githubLogin,
        profile: {
          ...(auth.user.displayName ? { name: auth.user.displayName } : {}),
          ...(auth.user.avatarUrl ? { avatar: auth.user.avatarUrl } : {}),
        },
      });
    })
    .get("/mcp/presence", () => ({ states: presence.snapshot() }))
    .onStop(() => {
      pool.shutdown();
    });
};

async function authenticateMcpRequest(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const key = authHeader.slice(7);
  const keyHash = await hashToken(key);

  const [apiKey] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);
  if (!apiKey) return null;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, apiKey.userId))
    .limit(1);
  if (!user) return null;

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, apiKey.deviceId))
    .limit(1);

  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, apiKey.id));

  return { user, device: device ?? null };
}
