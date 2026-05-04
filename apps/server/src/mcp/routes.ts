import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { users, apiKeys, devices, oauthTokens } from "../db/schema";
import { authAudit } from "../auth/audit";
import { hashToken } from "../auth/tokens";
import { mcpOrigin, mcpResourceUrl, mcpWwwAuthenticate } from "./auth";
import { McpPresenceStore } from "./presence";
import { McpSessionPool } from "./session-pool";

type McpRouteOptions = {
  requestQuotaMax?: number;
  requestQuotaWindowMs?: number;
  maxConcurrentSessionsPerUser?: number;
};

export const mcpRoutes = (options: McpRouteOptions = {}) => {
  const presence = new McpPresenceStore();
  const limiter = new PerUserRequestLimiter({
    max: options.requestQuotaMax ?? config.mcpRequestQuotaMax,
    windowMs: options.requestQuotaWindowMs ?? config.mcpRequestQuotaWindowMs,
  });
  const pool = new McpSessionPool({
    name: "slashtalk",
    version: "0.0.1",
    db,
    presence,
    maxSessionsPerUser:
      options.maxConcurrentSessionsPerUser ?? config.mcpMaxConcurrentSessionsPerUser,
  });

  return new Elysia({ name: "mcp" })
    .all("/mcp", async ({ request, set }) => {
      const auth = await authenticateMcpRequest(request);
      if (!auth.ok) {
        authAudit("mcp_token_rejected", {
          route: "/mcp",
          reason: auth.reason ?? "missing bearer token",
        });
        set.status = 401;
        set.headers["www-authenticate"] = mcpWwwAuthenticate(
          mcpOrigin(request),
          auth.reason ? { code: "invalid_token", description: auth.reason } : undefined,
        );
        return "Invalid or missing bearer token";
      }

      const quota = limiter.record(auth.user.id);
      if (!quota.ok) {
        authAudit("mcp_request_rate_limited", {
          userId: auth.user.id,
          route: "/mcp",
          limit: quota.limit,
          windowMs: quota.windowMs,
        });
        set.status = 429;
        return { error: "mcp_rate_limited" };
      }

      return pool.handleRequest(request, {
        userId: auth.user.githubLogin,
        userDbId: auth.user.id,
        profile: {
          ...(auth.user.displayName ? { name: auth.user.displayName } : {}),
          ...(auth.user.avatarUrl ? { avatar: auth.user.avatarUrl } : {}),
        },
      });
    })
    .onStop(() => {
      pool.shutdown();
    });
};

class PerUserRequestLimiter {
  private buckets = new Map<number, number[]>();

  constructor(private options: { max: number; windowMs: number }) {}

  record(userId: number): { ok: true } | { ok: false; limit: number; windowMs: number } {
    const now = Date.now();
    const cutoff = now - this.options.windowMs;
    const bucket = this.buckets.get(userId)?.filter((ts) => ts > cutoff) ?? [];
    if (bucket.length >= this.options.max) {
      this.buckets.set(userId, bucket);
      return {
        ok: false,
        limit: this.options.max,
        windowMs: this.options.windowMs,
      };
    }

    bucket.push(now);
    this.buckets.set(userId, bucket);
    return { ok: true };
  }
}

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

  const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, tokenHash)).limit(1);
  if (apiKey) {
    const [user] = await db.select().from(users).where(eq(users.id, apiKey.userId)).limit(1);
    if (!user) return { ok: false, reason: "unknown user" };

    const [device] = await db
      .select()
      .from(devices)
      .where(eq(devices.id, apiKey.deviceId))
      .limit(1);

    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, apiKey.id));

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

  const expectedResource = mcpResourceUrl(mcpOrigin(request));
  if (oauthToken.resource !== expectedResource) {
    return { ok: false, reason: "resource mismatch" };
  }
  if (!oauthToken.scope.split(/\s+/).includes("mcp:read")) {
    return { ok: false, reason: "insufficient scope" };
  }

  const [user] = await db.select().from(users).where(eq(users.id, oauthToken.userId)).limit(1);
  if (!user) return { ok: false, reason: "unknown user" };

  return { ok: true, user, device: null, method: "oauth" };
}
