import { Elysia } from "elysia";
import { db } from "../db";
import { users, apiKeys, devices, oauthTokens } from "../db/schema";
import { hashToken } from "../auth/tokens";
import { mcpResourceUrl, mcpWwwAuthenticate } from "../oauth/mcp";
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
      if (!auth.ok) {
        set.status = 401;
        set.headers["www-authenticate"] = mcpWwwAuthenticate(
          new URL(request.url).origin,
          auth.reason
            ? { code: "invalid_token", description: auth.reason }
            : undefined,
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

type McpAuthResult =
  | {
      ok: true;
      user: typeof users.$inferSelect;
      device: typeof devices.$inferSelect | null;
      method: "api_key" | "oauth";
    }
  | { ok: false; reason?: string };

async function authenticateMcpRequest(request: Request): Promise<McpAuthResult> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return { ok: false };

  const bearer = authHeader.slice(7);
  const tokenHash = await hashToken(bearer);

  const [apiKey] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, tokenHash))
    .limit(1);
  if (apiKey) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, apiKey.userId))
      .limit(1);
    if (!user) return { ok: false, reason: "unknown user" };

    const [device] = await db
      .select()
      .from(devices)
      .where(eq(devices.id, apiKey.deviceId))
      .limit(1);

    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKey.id));

    return { ok: true, user, device: device ?? null, method: "api_key" };
  }

  const [oauthToken] = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.accessTokenHash, tokenHash))
    .limit(1);
  if (!oauthToken) return { ok: false, reason: "unknown token" };
  if (oauthToken.revokedAt) return { ok: false, reason: "revoked" };
  if (oauthToken.accessExpiresAt < new Date()) {
    return { ok: false, reason: "expired" };
  }

  const expectedResource = mcpResourceUrl(new URL(request.url).origin);
  if (oauthToken.resource !== expectedResource) {
    return { ok: false, reason: "resource mismatch" };
  }
  if (!oauthToken.scope.split(/\s+/).includes("mcp:read")) {
    return { ok: false, reason: "insufficient scope" };
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, oauthToken.userId))
    .limit(1);
  if (!user) return { ok: false, reason: "unknown user" };

  return { ok: true, user, device: null, method: "oauth" };
}
