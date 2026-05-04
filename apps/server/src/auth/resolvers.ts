import { eq } from "drizzle-orm";
import type { Database } from "../db";
import { apiKeys, devices, oauthTokens, users } from "../db/schema";
import type { SessionJwtVerifier } from "./session";
import { isSessionCredentialFresh, verifySessionJwt } from "./session";
import { hashToken } from "./tokens";

export type AuthUser = typeof users.$inferSelect;
export type AuthDevice = typeof devices.$inferSelect;
export type AuthApiKey = typeof apiKeys.$inferSelect;

export type ResolvedApiKey = {
  apiKey: AuthApiKey;
  user: AuthUser;
  device: AuthDevice | null;
};

export type ApiKeyResolveFailure = "unknown_key" | "unknown_user";

export type ResolveApiKeyResult =
  | { ok: true; value: ResolvedApiKey }
  | { ok: false; reason: ApiKeyResolveFailure };

export type McpAccessTokenFailure =
  | "unknown token"
  | "revoked"
  | "expired"
  | "resource mismatch"
  | "insufficient scope"
  | "unknown user";

export type ResolveMcpAccessTokenResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: McpAccessTokenFailure };

export type AuthResolverDeps = {
  db: Database;
  now?: () => Date;
};

export function bearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

export async function resolveSessionJwt(
  deps: AuthResolverDeps,
  jwtVerifier: SessionJwtVerifier | undefined,
  token: string | undefined,
): Promise<AuthUser | null> {
  if (!token) return null;
  const payload = await verifySessionJwt(jwtVerifier, token);
  if (!payload) return null;

  const [user] = await deps.db
    .select()
    .from(users)
    .where(eq(users.id, Number(payload.sub)))
    .limit(1);
  if (!user) return null;
  if (!isSessionCredentialFresh(user, payload)) return null;
  return user;
}

export async function resolveApiKey(
  deps: AuthResolverDeps,
  token: string,
  options: { touchLastUsedAt: boolean },
): Promise<ResolveApiKeyResult> {
  const keyHash = await hashToken(token);
  const [apiKey] = await deps.db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);
  if (!apiKey) return { ok: false, reason: "unknown_key" };

  const [user] = await deps.db.select().from(users).where(eq(users.id, apiKey.userId)).limit(1);
  if (!user) return { ok: false, reason: "unknown_user" };

  const [device] = await deps.db
    .select()
    .from(devices)
    .where(eq(devices.id, apiKey.deviceId))
    .limit(1);

  if (options.touchLastUsedAt) {
    await deps.db
      .update(apiKeys)
      .set({ lastUsedAt: deps.now?.() ?? new Date() })
      .where(eq(apiKeys.id, apiKey.id));
  }

  return { ok: true, value: { apiKey, user, device: device ?? null } };
}

export async function resolveMcpAccessToken(
  deps: AuthResolverDeps,
  token: string,
  expectedResource: string,
): Promise<ResolveMcpAccessTokenResult> {
  const tokenHash = await hashToken(token);
  const [oauthToken] = await deps.db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.accessTokenHash, tokenHash))
    .limit(1);
  if (!oauthToken) return { ok: false, reason: "unknown token" };
  if (oauthToken.revokedAt) return { ok: false, reason: "revoked" };
  if (oauthToken.accessExpiresAt < (deps.now?.() ?? new Date())) {
    return { ok: false, reason: "expired" };
  }
  if (oauthToken.resource !== expectedResource) {
    return { ok: false, reason: "resource mismatch" };
  }
  if (!oauthToken.scope.split(/\s+/).includes("mcp:read")) {
    return { ok: false, reason: "insufficient scope" };
  }

  const [user] = await deps.db.select().from(users).where(eq(users.id, oauthToken.userId)).limit(1);
  if (!user) return { ok: false, reason: "unknown user" };

  return { ok: true, user };
}
