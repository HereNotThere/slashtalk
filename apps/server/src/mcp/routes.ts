import { Elysia } from "elysia";
import { config } from "../config";
import { db } from "../db";
import type { AuthDevice, AuthUser } from "../auth/resolvers";
import { authAudit } from "../auth/audit";
import { authInstance } from "../auth/instance";
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
      user: AuthUser;
      device: AuthDevice | null;
      method: "api_key" | "oauth";
    }
  | { ok: false; reason?: string };

async function authenticateMcpRequest(request: Request): Promise<McpAuthResult> {
  const bearer = authInstance.bearerToken(request.headers.get("authorization"));
  if (!bearer) return { ok: false };

  const apiKey = await authInstance.resolveApiKey(bearer, { touchLastUsedAt: true });
  if (apiKey.ok) {
    return {
      ok: true,
      user: apiKey.value.user,
      device: apiKey.value.device,
      method: "api_key",
    };
  }
  if (apiKey.reason === "unknown_user") return { ok: false, reason: "unknown user" };

  const oauth = await authInstance.resolveMcpAccessToken(
    bearer,
    mcpResourceUrl(mcpOrigin(request)),
  );
  if (!oauth.ok) return { ok: false, reason: oauth.reason };

  return { ok: true, user: oauth.user, device: null, method: "oauth" };
}
