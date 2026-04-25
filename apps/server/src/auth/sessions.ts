import { and, eq, isNull } from "drizzle-orm";
import { config } from "../config";
import type { Database } from "../db";
import { apiKeys, oauthTokens, refreshTokens, users } from "../db/schema";
import { authAudit } from "./audit";
import { hashToken } from "./tokens";

export const JWT_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

interface JwtSigner {
  sign: (payload: {
    sub: string;
    exp: number;
    iat: true;
    sessionIssuedAt: number;
  }) => Promise<string>;
}

export async function issueSessionTokens(
  db: Database,
  jwt: JwtSigner,
  userId: number,
): Promise<{ jwt: string; refreshToken: string }> {
  const now = Date.now();
  const token = await jwt.sign({
    sub: String(userId),
    exp: Math.floor(now / 1000) + JWT_TTL_SECONDS,
    iat: true,
    sessionIssuedAt: now,
  });
  const refreshToken = crypto.randomUUID();
  await db.insert(refreshTokens).values({
    userId,
    tokenHash: await hashToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
  });
  return { jwt: token, refreshToken };
}

/**
 * Atomically consume a refresh token and issue a fresh pair. The DELETE
 * is the synchronization point: concurrent refreshes with the same token
 * race on the row, and only one wins. Returns null for missing, expired,
 * or already-rotated tokens — all treated as "sign in again".
 */
export async function rotateSessionTokens(
  db: Database,
  jwt: JwtSigner,
  presented: string,
): Promise<{ jwt: string; refreshToken: string; userId: number } | null> {
  const hash = await hashToken(presented);
  const [rt] = await db
    .delete(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hash))
    .returning();
  if (!rt || rt.expiresAt < new Date()) return null;
  const issued = await issueSessionTokens(db, jwt, rt.userId);
  return { ...issued, userId: rt.userId };
}

export async function revokeRefreshToken(
  db: Database,
  presented: string,
): Promise<void> {
  const hash = await hashToken(presented);
  const [revoked] = await db
    .delete(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hash))
    .returning();
  if (revoked) {
    authAudit("refresh_token_revoked", {
      userId: revoked.userId,
      scope: "single",
    });
  }
}

export async function revokeAllUserCredentials(
  db: Database,
  userId: number,
  reason: "sign_out_everywhere" | "github_grant_revoked",
): Promise<void> {
  const counts = await db.transaction(async (tx) => {
    const revokedAt = new Date();
    await tx
      .update(users)
      .set({ credentialsRevokedAt: revokedAt, updatedAt: revokedAt })
      .where(eq(users.id, userId));
    const refreshRows = await tx
      .delete(refreshTokens)
      .where(eq(refreshTokens.userId, userId))
      .returning({ id: refreshTokens.id });
    const apiKeyRows = await tx
      .delete(apiKeys)
      .where(eq(apiKeys.userId, userId))
      .returning({ id: apiKeys.id });
    const oauthRows = await tx
      .update(oauthTokens)
      .set({ revokedAt })
      .where(and(eq(oauthTokens.userId, userId), isNull(oauthTokens.revokedAt)))
      .returning({ id: oauthTokens.id });

    return {
      refreshTokens: refreshRows.length,
      deviceApiKeys: apiKeyRows.length,
      mcpOauthTokens: oauthRows.length,
    };
  });

  authAudit("credentials_revoked", {
    userId,
    scope: "global",
    reason,
    refreshTokens: counts.refreshTokens,
    deviceApiKeys: counts.deviceApiKeys,
    mcpOauthTokens: counts.mcpOauthTokens,
  });
}

/**
 * Read a refresh token presented by either a browser (cookie) or a
 * non-browser client (JSON body). Cookie wins when both are present.
 */
export function presentedRefreshToken(
  cookieValue: unknown,
  body: { refreshToken?: string } | null | undefined,
): string | undefined {
  if (typeof cookieValue === "string" && cookieValue.length > 0) {
    return cookieValue;
  }
  return body?.refreshToken;
}

type CookieSetter = {
  set: (opts: {
    value: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "lax" | "strict" | "none";
    maxAge: number;
    path: string;
  }) => void;
  remove: () => void;
};

interface AuthCookies {
  session: CookieSetter;
  refresh: CookieSetter;
}

export function setSessionCookies(
  cookies: AuthCookies,
  tokens: { jwt: string; refreshToken: string },
): void {
  const isSecure = config.baseUrl.startsWith("https");
  cookies.session.set({
    value: tokens.jwt,
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    maxAge: JWT_TTL_SECONDS,
    path: "/",
  });
  cookies.refresh.set({
    value: tokens.refreshToken,
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    maxAge: REFRESH_TTL_SECONDS,
    path: "/auth",
  });
}

export function clearSessionCookies(cookies: AuthCookies): void {
  cookies.session.remove();
  cookies.refresh.remove();
}
