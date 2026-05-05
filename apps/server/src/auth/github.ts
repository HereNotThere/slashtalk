import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { eq, and, gt } from "drizzle-orm";
import { config } from "../config";
import type { Database } from "../db";
import { users, setupTokens, devices, apiKeys } from "../db/schema";
import { generateApiKey, hashToken, encryptGithubToken } from "./tokens";
import { issueOAuthState, consumeOAuthState } from "./oauth-state";
import type { RedisBridge } from "../ws/redis-bridge";
import {
  issueSessionTokens,
  rotateSessionTokens,
  revokeRefreshToken,
  revokeAllUserCredentials,
  setSessionCookies,
  clearSessionCookies,
  presentedRefreshToken,
} from "./sessions";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
// Read-only identity scopes. We deliberately do NOT request `repo` — repo
// access is opted into by the user at the app layer (they add local clones
// via the desktop app, which uses the local .git/config to establish repo
// identity). See CLAUDE.md "Repo claims vs. sync".
const SCOPES = "read:user read:org";

/** OAuth + session routes under /auth */
export const githubAuth = (db: Database, redis: RedisBridge) =>
  new Elysia({ prefix: "/auth", name: "auth/github" })
    .use(jwt({ name: "jwt", secret: config.jwtSecret }))

    // GET /auth/github — redirect to GitHub authorize.
    // Optional ?desktop_port=NNNN lets an Electron loopback listener receive
    // the credentials directly instead of relying on cookies.
    // Optional ?return_to=/path lets browser flows resume after sign-in.
    .get(
      "/github",
      async ({ query, redirect }) => {
        const params = new URLSearchParams({
          client_id: config.githubClientId,
          redirect_uri: `${config.baseUrl}/auth/github/callback`,
          scope: SCOPES,
        });
        let port: number | null = null;
        if (query.desktop_port) {
          const candidate = Number(query.desktop_port);
          if (Number.isInteger(candidate) && candidate > 0 && candidate < 65536) {
            port = candidate;
          }
        }
        const nonce =
          port !== null
            ? await issueOAuthState(redis, { kind: "desktop", port })
            : await issueOAuthState(redis, {
                kind: "web",
                returnTo:
                  query.return_to && isSafeReturnTo(query.return_to) ? query.return_to : undefined,
              });
        params.set("state", nonce);
        return redirect(`${GITHUB_AUTHORIZE_URL}?${params}`);
      },
      {
        query: t.Object({
          desktop_port: t.Optional(t.String()),
          return_to: t.Optional(t.String()),
        }),
      },
    )

    // GET /auth/github/callback — handle OAuth callback
    .get(
      "/github/callback",
      async ({ query, jwt, cookie: { session, refresh: refreshCookie }, redirect, set }) => {
        // Reject the callback if we don't recognize the state nonce: a missing,
        // forged, or replayed state means the inbound `code` did not originate
        // from a flow we initiated. Without this, an attacker could trick a
        // signed-in browser into completing OAuth with a code they obtained
        // separately — and steer the desktop loopback redirect at any port.
        const stateValue = query.state;
        const statePayload = stateValue ? await consumeOAuthState(redis, stateValue) : null;
        if (!statePayload) {
          set.status = 400;
          return { error: "invalid_state" };
        }

        const tokenRes = await fetch(GITHUB_TOKEN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            client_id: config.githubClientId,
            client_secret: config.githubClientSecret,
            code: query.code,
          }),
        });
        const tokenData = (await tokenRes.json()) as {
          access_token?: string;
          error?: string;
        };

        if (!tokenData.access_token) {
          set.status = 400;
          return { error: "GitHub OAuth failed", message: tokenData.error };
        }

        const userRes = await fetch(GITHUB_USER_URL, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const ghUser = (await userRes.json()) as {
          id: number;
          login: string;
          avatar_url: string;
          name: string | null;
        };

        const encryptedToken = await encryptGithubToken(
          tokenData.access_token,
          config.encryptionKey,
        );

        const [user] = await db
          .insert(users)
          .values({
            githubId: ghUser.id,
            githubLogin: ghUser.login,
            avatarUrl: ghUser.avatar_url,
            displayName: ghUser.name,
            githubToken: encryptedToken,
          })
          .onConflictDoUpdate({
            target: users.githubId,
            set: {
              githubLogin: ghUser.login,
              avatarUrl: ghUser.avatar_url,
              displayName: ghUser.name,
              githubToken: encryptedToken,
              updatedAt: new Date(),
            },
          })
          .returning();

        const tokens = await issueSessionTokens(db, jwt, user.id);

        // Desktop (loopback) branch: redirect credentials to 127.0.0.1:<port>.
        // Restricted to loopback to keep raw tokens off arbitrary hosts. The
        // port came from the original /auth/github call and was bound to this
        // nonce server-side, so a forged callback can't steer it.
        if (statePayload.kind === "desktop") {
          const params = new URLSearchParams({
            jwt: tokens.jwt,
            refreshToken: tokens.refreshToken,
            login: user.githubLogin,
          });
          return redirect(`http://127.0.0.1:${statePayload.port}/callback?${params}`);
        }

        setSessionCookies({ session, refresh: refreshCookie }, tokens);
        if (statePayload.returnTo && isSafeReturnTo(statePayload.returnTo)) {
          return redirect(statePayload.returnTo);
        }

        return { ok: true, user: { id: user.id, login: user.githubLogin } };
      },
      {
        query: t.Object({
          code: t.String(),
          state: t.Optional(t.String()),
        }),
      },
    )

    // POST /auth/refresh — rotate refresh token, issue new JWT.
    // Accepts the refresh token from either the `refresh` cookie (browser)
    // or the JSON body (desktop / non-browser clients).
    .post(
      "/refresh",
      async ({ jwt, cookie: { session, refresh: refreshCookie }, body, set }) => {
        const presented = presentedRefreshToken(refreshCookie?.value, body);
        if (!presented) {
          set.status = 401;
          return { error: "No refresh token" };
        }

        const rotated = await rotateSessionTokens(db, jwt, presented);
        if (!rotated) {
          clearSessionCookies({ session, refresh: refreshCookie });
          set.status = 401;
          return { error: "Invalid or expired refresh token" };
        }

        setSessionCookies(
          { session, refresh: refreshCookie },
          { jwt: rotated.jwt, refreshToken: rotated.refreshToken },
        );

        // Also return tokens in body for non-browser clients (desktop) that
        // don't have a cookie jar.
        return {
          ok: true,
          jwt: rotated.jwt,
          refreshToken: rotated.refreshToken,
        };
      },
      {
        body: t.Optional(t.Object({ refreshToken: t.Optional(t.String()) })),
      },
    )

    // POST /auth/logout — revoke the presented refresh token and clear
    // cookies. Accepts the token from cookie or body, same as /refresh.
    .post(
      "/logout",
      async ({ cookie: { session, refresh: refreshCookie }, body }) => {
        const presented = presentedRefreshToken(refreshCookie?.value, body);
        if (presented) {
          await revokeRefreshToken(db, presented);
        }
        clearSessionCookies({ session, refresh: refreshCookie });
        return { ok: true };
      },
      {
        body: t.Optional(t.Object({ refreshToken: t.Optional(t.String()) })),
      },
    )

    // POST /auth/logout-everywhere — explicit global revoke. This invalidates
    // all refresh tokens, device API keys, and MCP OAuth grants for the signed-in
    // user; normal /logout intentionally remains scoped to one refresh token.
    .post(
      "/logout-everywhere",
      async ({ jwt, cookie: { session, refresh: refreshCookie }, set }) => {
        const token = session?.value;
        if (typeof token !== "string" || token.length === 0) {
          set.status = 401;
          return { error: "Unauthorized" };
        }

        const payload = await jwt.verify(token);
        if (!payload || !("sub" in payload) || !payload.sub) {
          set.status = 401;
          return { error: "Invalid token" };
        }

        await revokeAllUserCredentials(db, Number(payload.sub), "sign_out_everywhere");
        clearSessionCookies({ session, refresh: refreshCookie });
        return { ok: true };
      },
    );

function isSafeReturnTo(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//");
}

/** CLI token exchange — mounted at /v1/auth to match spec */
export const cliAuth = (db: Database) =>
  new Elysia({ prefix: "/v1/auth", name: "auth/cli" })

    // POST /v1/auth/exchange — exchange setup token for API key
    .post(
      "/exchange",
      async ({ body, set }) => {
        // Claim the row atomically — splitting this into select+update lets two
        // concurrent callers both pass the redeemed check and mint two API keys.
        const tokenHash = await hashToken(body.token);
        const [st] = await db
          .update(setupTokens)
          .set({ redeemed: true })
          .where(
            and(
              eq(setupTokens.token, tokenHash),
              eq(setupTokens.redeemed, false),
              gt(setupTokens.expiresAt, new Date()),
            ),
          )
          .returning();

        if (!st) {
          set.status = 400;
          return { error: "Invalid or expired setup token" };
        }

        // Upsert by (userId, deviceName): a second sign-in on the same
        // machine reuses the existing device row so device_repo_paths and
        // sessions linked to that device survive sign-out/in cycles.
        const [device] = await db
          .insert(devices)
          .values({
            userId: st.userId,
            deviceName: body.deviceName,
            os: body.os ?? null,
            lastSeenAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [devices.userId, devices.deviceName],
            set: { os: body.os ?? null, lastSeenAt: new Date() },
          })
          .returning();

        // One active API key per device. Revoke any prior keys before issuing
        // the new one so an old machine-captured key can't outlive a sign-in.
        await db.delete(apiKeys).where(eq(apiKeys.deviceId, device.id));

        const rawKey = generateApiKey();
        const keyHash = await hashToken(rawKey);
        await db.insert(apiKeys).values({
          userId: st.userId,
          deviceId: device.id,
          keyHash,
        });

        return { apiKey: rawKey, deviceId: device.id };
      },
      {
        body: t.Object({
          token: t.String(),
          deviceName: t.String(),
          os: t.Optional(t.String()),
        }),
      },
    );
