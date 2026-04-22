import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { eq, and } from "drizzle-orm";
import { config } from "../config";
import type { Database } from "../db";
import {
  users,
  refreshTokens,
  setupTokens,
  devices,
  apiKeys,
  userRepos,
} from "../db/schema";
import {
  generateApiKey,
  hashToken,
  encryptGithubToken,
} from "./tokens";
import { syncUserRepos } from "../social/github-sync";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const SCOPES = "read:user read:org repo";

/** OAuth + session routes under /auth */
export const githubAuth = (db: Database) =>
  new Elysia({ prefix: "/auth", name: "auth/github" })
    .use(jwt({ name: "jwt", secret: config.jwtSecret }))

    // GET /auth/github — redirect to GitHub authorize
    .get("/github", ({ redirect }) => {
      const params = new URLSearchParams({
        client_id: config.githubClientId,
        redirect_uri: `${config.baseUrl}/auth/github/callback`,
        scope: SCOPES,
      });
      return redirect(`${GITHUB_AUTHORIZE_URL}?${params}`);
    })

    // GET /auth/github/callback — handle OAuth callback
    .get(
      "/github/callback",
      async ({ query, jwt, cookie: { session }, set }) => {
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
          config.encryptionKey
        );

        // Upsert user
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

        // Issue JWT
        const token = await jwt.sign({
          sub: String(user.id),
          exp: Math.floor(Date.now() / 1000) + 3600,
        });

        // Issue refresh token
        const refreshToken = crypto.randomUUID();
        const refreshHash = await hashToken(refreshToken);
        await db.insert(refreshTokens).values({
          userId: user.id,
          tokenHash: refreshHash,
          expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        });

        // Set session cookie
        session.set({
          value: token,
          httpOnly: true,
          secure: config.baseUrl.startsWith("https"),
          sameSite: "lax",
          maxAge: 3600,
          path: "/",
        });

        // Auto-sync repos on first login (no user_repos yet)
        const existingRepos = await db
          .select()
          .from(userRepos)
          .where(eq(userRepos.userId, user.id))
          .limit(1);
        if (existingRepos.length === 0) {
          try {
            await syncUserRepos(db, user);
          } catch {
            // Non-fatal — user can manually sync later
          }
        }

        return { ok: true, user: { id: user.id, login: user.githubLogin } };
      },
      { query: t.Object({ code: t.String() }) }
    )

    // POST /auth/refresh — exchange refresh token for new JWT
    .post(
      "/refresh",
      async ({ body, jwt, cookie: { session }, set }) => {
        const hash = await hashToken(body.refreshToken);
        const [rt] = await db
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenHash, hash))
          .limit(1);

        if (!rt || rt.expiresAt < new Date()) {
          set.status = 401;
          return { error: "Invalid or expired refresh token" };
        }

        const token = await jwt.sign({
          sub: String(rt.userId),
          exp: Math.floor(Date.now() / 1000) + 3600,
        });

        session.set({
          value: token,
          httpOnly: true,
          secure: config.baseUrl.startsWith("https"),
          sameSite: "lax",
          maxAge: 3600,
          path: "/",
        });

        return { ok: true };
      },
      { body: t.Object({ refreshToken: t.String() }) }
    )

    // POST /auth/logout — revoke refresh token
    .post(
      "/logout",
      async ({ body, cookie: { session } }) => {
        const hash = await hashToken(body.refreshToken);
        await db
          .delete(refreshTokens)
          .where(eq(refreshTokens.tokenHash, hash));

        session.remove();
        return { ok: true };
      },
      { body: t.Object({ refreshToken: t.String() }) }
    );

/** CLI token exchange — mounted at /v1/auth to match spec */
export const cliAuth = (db: Database) =>
  new Elysia({ prefix: "/v1/auth", name: "auth/cli" })

    // POST /v1/auth/exchange — exchange setup token for API key
    .post(
      "/exchange",
      async ({ body, set }) => {
        const [st] = await db
          .select()
          .from(setupTokens)
          .where(
            and(
              eq(setupTokens.token, body.token),
              eq(setupTokens.redeemed, false)
            )
          )
          .limit(1);

        if (!st || st.expiresAt < new Date()) {
          set.status = 400;
          return { error: "Invalid or expired setup token" };
        }

        await db
          .update(setupTokens)
          .set({ redeemed: true })
          .where(eq(setupTokens.id, st.id));

        const [device] = await db
          .insert(devices)
          .values({
            userId: st.userId,
            deviceName: body.deviceName,
            os: body.os ?? null,
            lastSeenAt: new Date(),
          })
          .returning();

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
      }
    );
