import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { eq } from "drizzle-orm";
import { config } from "../config";
import type { Database } from "../db";
import { users } from "../db/schema";
import {
  decryptGithubToken,
  encryptGithubToken,
} from "./tokens";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const STATE_COOKIE = "github_app_state";

type GitHubAppConfig = {
  clientId: string;
  clientSecret: string;
};

type JwtVerifier = {
  verify: (token: string) => Promise<
    | false
    | {
        sub?: string | number;
        sessionIssuedAt?: number;
        iat?: number | boolean;
      }
  >;
};

type GitHubAppTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: "missing" | "expired" | "refresh_failed" };

interface GitHubAppTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

export const githubAppAuth = (db: Database) =>
  new Elysia({ prefix: "/auth", name: "auth/github-app" })
    .use(jwt({ name: "jwt", secret: config.jwtSecret }))
    .get(
      "/github-app",
      async ({ jwt, cookie, query, redirect, set }) => {
        const app = githubAppConfig();
        if (!app) {
          set.status = 503;
          return { error: "GitHub App is not configured" };
        }

        const user = await sessionUser(
          db,
          jwt,
          stringCookieValue(cookie.session?.value),
        );
        if (!user) {
          return redirect(
            `/auth/github?${new URLSearchParams({
              return_to: "/auth/github-app",
            })}`,
          );
        }

        const state = crypto.randomUUID();
        cookie[STATE_COOKIE].set({
          value: state,
          httpOnly: true,
          secure: config.baseUrl.startsWith("https"),
          sameSite: "lax",
          maxAge: 10 * 60,
          path: "/auth/github-app",
        });

        if (query.install === "1") {
          const installUrl = githubAppInstallUrl(state);
          if (installUrl) return redirect(installUrl);
        }

        return redirect(githubAppAuthorizeUrl(app, state));
      },
      {
        query: t.Object({
          install: t.Optional(t.String()),
        }),
      },
    )
    .get("/github-app/callback", async ({ jwt, cookie, query, set }) => {
      const app = githubAppConfig();
      if (!app) {
        set.status = 503;
        return { error: "GitHub App is not configured" };
      }

      const expectedState = stringCookieValue(cookie[STATE_COOKIE]?.value);
      cookie[STATE_COOKIE]?.remove();
      if (
        typeof query.state !== "string" ||
        !expectedState ||
        query.state !== expectedState
      ) {
        set.status = 400;
        return { error: "Invalid GitHub App state" };
      }

      const user = await sessionUser(
        db,
        jwt,
        stringCookieValue(cookie.session?.value),
      );
      if (!user) {
        set.status = 401;
        return { error: "Sign in to Slashtalk before connecting GitHub App" };
      }

      if (typeof query.code !== "string" || query.code.length === 0) {
        set.status = 400;
        return {
          error: "GitHub App authorization code missing",
          message:
            "Confirm the GitHub App has 'Request user authorization during installation' enabled.",
        };
      }

      const tokenData = await exchangeGitHubAppCode(app, query.code);
      if (!tokenData.access_token) {
        set.status = 400;
        return {
          error: "GitHub App authorization failed",
          message: tokenData.error_description ?? tokenData.error,
        };
      }

      await storeGitHubAppTokens(db, user.id, tokenData);
      set.headers["content-type"] = "text/html; charset=utf-8";
      return githubAppConnectedHtml();
    });

export function githubAppInstallUrl(state?: string): string | null {
  if (!config.githubAppSlug) return null;
  const url = new URL(
    `https://github.com/apps/${config.githubAppSlug}/installations/new`,
  );
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

export function githubAppConnectUrl(): string {
  return `${config.baseUrl}/auth/github-app`;
}

export function githubAppInstallConnectUrl(): string {
  return `${config.baseUrl}/auth/github-app?install=1`;
}

export async function fetchUserGithubAppToken(
  db: Database,
  userId: number,
): Promise<GitHubAppTokenResult> {
  const [row] = await db
    .select({
      token: users.githubAppUserToken,
      tokenExpiresAt: users.githubAppTokenExpiresAt,
      refreshToken: users.githubAppRefreshToken,
      refreshTokenExpiresAt: users.githubAppRefreshTokenExpiresAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row?.token) return { ok: false, reason: "missing" };

  const now = Date.now();
  if (!row.tokenExpiresAt || row.tokenExpiresAt.getTime() > now + 60_000) {
    return {
      ok: true,
      token: await decryptGithubToken(row.token, config.encryptionKey),
    };
  }

  if (
    !row.refreshToken ||
    (row.refreshTokenExpiresAt && row.refreshTokenExpiresAt.getTime() <= now)
  ) {
    return { ok: false, reason: "expired" };
  }

  const app = githubAppConfig();
  if (!app) return { ok: false, reason: "refresh_failed" };

  const refreshToken = await decryptGithubToken(
    row.refreshToken,
    config.encryptionKey,
  );
  const refreshed = await refreshGitHubAppToken(app, refreshToken);
  if (!refreshed.access_token) {
    return { ok: false, reason: "refresh_failed" };
  }

  await storeGitHubAppTokens(db, userId, refreshed);
  return { ok: true, token: refreshed.access_token };
}

function githubAppConfig(): GitHubAppConfig | null {
  if (!config.githubAppClientId || !config.githubAppClientSecret) return null;
  return {
    clientId: config.githubAppClientId,
    clientSecret: config.githubAppClientSecret,
  };
}

function githubAppAuthorizeUrl(app: GitHubAppConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: githubAppCallbackUrl(),
    state,
  });
  return `${GITHUB_AUTHORIZE_URL}?${params}`;
}

function stringCookieValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function sessionUser(db: Database, jwt: JwtVerifier, token?: string) {
  if (!token) return null;
  const payload = await jwt.verify(token);
  if (!payload || !payload.sub) return null;
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, Number(payload.sub)))
    .limit(1);
  if (!user) return null;
  if (user.credentialsRevokedAt) {
    const issuedAtMs =
      typeof payload.sessionIssuedAt === "number"
        ? payload.sessionIssuedAt
        : typeof payload.iat === "number"
          ? payload.iat * 1000
          : null;
    if (!issuedAtMs || issuedAtMs < user.credentialsRevokedAt.getTime()) {
      return null;
    }
  }
  return user;
}

async function exchangeGitHubAppCode(
  app: GitHubAppConfig,
  code: string,
): Promise<GitHubAppTokenResponse> {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      redirect_uri: githubAppCallbackUrl(),
    }),
  });
  return (await res.json()) as GitHubAppTokenResponse;
}

async function refreshGitHubAppToken(
  app: GitHubAppConfig,
  refreshToken: string,
): Promise<GitHubAppTokenResponse> {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  return (await res.json()) as GitHubAppTokenResponse;
}

async function storeGitHubAppTokens(
  db: Database,
  userId: number,
  tokenData: GitHubAppTokenResponse,
): Promise<void> {
  if (!tokenData.access_token) return;
  const now = new Date();
  await db
    .update(users)
    .set({
      githubAppUserToken: await encryptGithubToken(
        tokenData.access_token,
        config.encryptionKey,
      ),
      githubAppRefreshToken: tokenData.refresh_token
        ? await encryptGithubToken(tokenData.refresh_token, config.encryptionKey)
        : undefined,
      githubAppTokenExpiresAt: tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null,
      githubAppRefreshTokenExpiresAt: tokenData.refresh_token_expires_in
        ? new Date(Date.now() + tokenData.refresh_token_expires_in * 1000)
        : null,
      githubAppConnectedAt: now,
      updatedAt: now,
    })
    .where(eq(users.id, userId));
}

function githubAppCallbackUrl(): string {
  return `${config.baseUrl}/auth/github-app/callback`;
}

function githubAppConnectedHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GitHub App connected · Slashtalk</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #101312;
      --panel: #181d1a;
      --panel-border: rgba(255, 255, 255, 0.10);
      --text: #f2f5f3;
      --muted: #9ba5a0;
      --accent: #2ecf81;
      --accent-ink: #07150d;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f7f8f5;
        --panel: #ffffff;
        --panel-border: rgba(17, 24, 39, 0.10);
        --text: #171a18;
        --muted: #68716b;
        --accent-ink: #ffffff;
      }
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      background:
        radial-gradient(circle at 50% 0%, rgba(46, 207, 129, 0.14), transparent 34%),
        var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    main {
      width: min(420px, 100%);
      padding: 28px;
      border: 1px solid var(--panel-border);
      border-radius: 14px;
      background: var(--panel);
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.22);
      text-align: center;
    }
    .mark {
      width: 48px;
      height: 48px;
      margin: 0 auto 18px;
      display: grid;
      place-items: center;
      border-radius: 14px;
      background: var(--accent);
      color: var(--accent-ink);
      font-size: 27px;
      font-weight: 800;
    }
    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.18;
      letter-spacing: 0;
    }
    p {
      margin: 8px 0 0;
      color: var(--muted);
      line-height: 1.45;
    }
    .next {
      margin-top: 18px;
      padding: 10px 12px;
      border-radius: 8px;
      background: rgba(148, 163, 184, 0.10);
      color: var(--text);
      font-size: 14px;
    }
    .brand {
      margin-top: 22px;
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0;
    }
  </style>
</head>
<body>
  <main>
    <div class="mark">✓</div>
    <h1>GitHub App connected</h1>
    <p>Slashtalk can now verify private repositories included in this GitHub App installation.</p>
    <p class="next">Return to the desktop app. Repo access will update automatically.</p>
    <div class="brand">Slashtalk</div>
  </main>
</body>
</html>`;
}
