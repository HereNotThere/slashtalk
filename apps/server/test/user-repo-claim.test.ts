import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { createApp } from "../src/app";
import { RedisBridge } from "../src/ws/redis-bridge";
import { __clearOrgCaches } from "../src/user/routes";
import { config } from "../src/config";
import {
  apiKeys,
  devices,
  oauthTokens,
  refreshTokens,
  repos,
  userRepos,
  users,
} from "../src/db/schema";
import { encryptGithubToken, hashToken } from "../src/auth/tokens";
import { resetDatabase, getCookie } from "./helpers";

let redis: RedisBridge;
let app: ReturnType<typeof createApp>;
let baseUrl: string;
let originalFetch: typeof globalThis.fetch;
let aliceCookie: string;
let aliceUserId: number;

// Mock state (reset per-test)
let repoFetchCount = 0;
let appInstallationsFetchCount = 0;
let appInstallationReposFetchCount = 0;
let lastAppInstallationsAuthorization: string | null = null;
type RepoResponse =
  | { status: number; body: unknown }
  | ((authorization: string | null) => { status: number; body: unknown });
let repoResponse: RepoResponse = { status: 200, body: {} };
let appInstallationsResponses: Array<{
  status: number;
  body: unknown;
  link?: string;
}> = [{ status: 200, body: { installations: [] } }];
let appInstallationReposResponses: Array<{
  status: number;
  body: unknown;
  link?: string;
}> = [{ status: 200, body: { repositories: [] } }];
let refreshTokenResponse: {
  status: number;
  body: unknown;
} = {
  status: 200,
  body: {
    access_token: "ghu_app_refreshed",
    expires_in: 28_800,
    refresh_token: "ghr_app_refreshed",
    refresh_token_expires_in: 15_768_000,
  },
};

const ALICE = {
  id: 9101,
  login: "alice",
  avatar_url: "https://avatars.test/alice",
  name: "Alice",
};

beforeAll(async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(init?.body as string);
      if (body.grant_type === "refresh_token") {
        return new Response(JSON.stringify(refreshTokenResponse.body), {
          status: refreshTokenResponse.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ access_token: "ghtoken_alice_code" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify(ALICE), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.startsWith("https://api.github.com/repos/")) {
      repoFetchCount += 1;
      const response =
        typeof repoResponse === "function"
          ? repoResponse(authorizationHeader(init?.headers))
          : repoResponse;
      return new Response(JSON.stringify(response.body ?? {}), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.startsWith("https://api.github.com/user/installations?")) {
      appInstallationsFetchCount += 1;
      lastAppInstallationsAuthorization = authorizationHeader(init?.headers);
      const response =
        appInstallationsResponses[appInstallationsFetchCount - 1] ??
        appInstallationsResponses[appInstallationsResponses.length - 1]!;
      return new Response(JSON.stringify(response.body ?? {}), {
        status: response.status,
        headers: jsonHeaders(response.link),
      });
    }
    if (url.startsWith("https://api.github.com/user/installations/100/repositories?")) {
      appInstallationReposFetchCount += 1;
      const response =
        appInstallationReposResponses[appInstallationReposFetchCount - 1] ??
        appInstallationReposResponses[appInstallationReposResponses.length - 1]!;
      return new Response(JSON.stringify(response.body ?? {}), {
        status: response.status,
        headers: jsonHeaders(response.link),
      });
    }

    // Pass through (local Elysia server, etc.)
    return originalFetch(input, init);
  };

  await resetDatabase();
  redis = new RedisBridge();
  await redis.connect();
  app = createApp(db, redis);
  app.listen(0);
  const port = app.server!.port;
  baseUrl = `http://localhost:${port}`;

  // Sign alice in so she has an encrypted GitHub token in the DB.
  const res = await fetch(`${baseUrl}/auth/github/callback?code=alice_code`);
  expect(res.status).toBe(200);
  aliceCookie = getCookie(res, "session")!;
  expect(aliceCookie).toBeTruthy();

  const [aliceRow] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.githubLogin, "alice"))
    .limit(1);
  aliceUserId = aliceRow.id;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  app.stop();
  await redis.disconnect();
});

beforeEach(async () => {
  __clearOrgCaches();
  repoFetchCount = 0;
  appInstallationsFetchCount = 0;
  appInstallationReposFetchCount = 0;
  lastAppInstallationsAuthorization = null;
  repoResponse = { status: 200, body: {} };
  appInstallationsResponses = [{ status: 200, body: { installations: [] } }];
  appInstallationReposResponses = [{ status: 200, body: { repositories: [] } }];
  refreshTokenResponse = {
    status: 200,
    body: {
      access_token: "ghu_app_refreshed",
      expires_in: 28_800,
      refresh_token: "ghr_app_refreshed",
      refresh_token_expires_in: 15_768_000,
    },
  };
  // Drop any user_repos / repos rows from prior cases so counts are exact.
  await db.delete(userRepos).where(eq(userRepos.userId, aliceUserId));
  await db.delete(repos);
  await db
    .update(users)
    .set({
      githubAppUserToken: null,
      githubAppRefreshToken: null,
      githubAppTokenExpiresAt: null,
      githubAppRefreshTokenExpiresAt: null,
      githubAppConnectedAt: null,
    })
    .where(eq(users.id, aliceUserId));
});

async function claim(fullName: string): Promise<Response> {
  return fetch(`${baseUrl}/api/me/repos`, {
    method: "POST",
    headers: {
      Cookie: aliceCookie,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fullName }),
  });
}

function repoOkBody(fullName: string, id: number, priv = false): unknown {
  const [owner, name] = fullName.split("/");
  return {
    id,
    full_name: fullName,
    name,
    owner: { login: owner },
    private: priv,
  };
}

async function expectError(res: Response, status: number, kind: string): Promise<void> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe(kind);
}

function authorizationHeader(headers: HeadersInit | undefined): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get("authorization");
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === "authorization");
    return found?.[1] ?? null;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization") return value;
  }
  return null;
}

function jsonHeaders(link?: string): Record<string, string> {
  return link
    ? { "Content-Type": "application/json", Link: link }
    : { "Content-Type": "application/json" };
}

async function storeGitHubAppToken(
  token: string,
  options: {
    tokenExpiresAt?: Date | null;
    refreshToken?: string | null;
    refreshTokenExpiresAt?: Date | null;
  } = {},
): Promise<void> {
  const refreshToken = options.refreshToken ?? "ghr_app_alice";
  await db
    .update(users)
    .set({
      githubAppUserToken: await encryptGithubToken(token, config.encryptionKey),
      githubAppRefreshToken: refreshToken
        ? await encryptGithubToken(refreshToken, config.encryptionKey)
        : null,
      githubAppTokenExpiresAt: options.tokenExpiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
      githubAppRefreshTokenExpiresAt:
        options.refreshTokenExpiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
      githubAppConnectedAt: new Date(),
    })
    .where(eq(users.id, aliceUserId));
}

describe("POST /api/me/repos — claim gate", () => {
  it("accepts a claim when GitHub returns 200 and persists canonical metadata", async () => {
    repoResponse = { status: 200, body: repoOkBody("Acme/Alpha", 12345, true) };

    const res = await claim("Acme/Alpha");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repoId: number;
      fullName: string;
      owner: string;
      name: string;
      private: boolean;
      permission: string;
    };
    // Stored lowercase (normalizeFullName), but owner/name casing from GitHub.
    expect(body.fullName).toBe("acme/alpha");
    expect(body.owner).toBe("Acme");
    expect(body.name).toBe("Alpha");
    expect(body.private).toBe(true);
    expect(body.permission).toBe("claimed");

    // user_repos row exists, repos.github_id populated.
    const rows = await db
      .select({ repoId: userRepos.repoId, githubId: repos.githubId })
      .from(userRepos)
      .innerJoin(repos, eq(repos.id, userRepos.repoId))
      .where(eq(userRepos.userId, aliceUserId));
    expect(rows.length).toBe(1);
    expect(rows[0].githubId).toBe(12345);
    expect(repoFetchCount).toBe(1);
  });

  it("asks the user to connect the GitHub App when OAuth cannot see the repo", async () => {
    repoResponse = { status: 404, body: { message: "Not Found" } };

    const res = await claim("acme/secret");
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: string;
      requiresGithubApp?: boolean;
      connectUrl?: string;
    };
    expect(body.error).toBe("no_access");
    expect(body.requiresGithubApp).toBe(true);
    expect(body.connectUrl).toStartWith("http://localhost:10000/auth/github-app?intent=");

    const rows = await db.select().from(userRepos).where(eq(userRepos.userId, aliceUserId));
    expect(rows.length).toBe(0);
    expect(repoFetchCount).toBe(1);
  });

  it("accepts a private repo claim with the GitHub App user token when OAuth cannot see it", async () => {
    await storeGitHubAppToken("ghu_app_alice");
    repoResponse = { status: 404, body: { message: "Not Found" } };
    appInstallationsResponses = [
      {
        status: 200,
        body: {
          installations: [{ id: 100, app_slug: config.githubAppSlug, suspended_at: null }],
        },
      },
    ];
    appInstallationReposResponses = [
      {
        status: 200,
        body: { repositories: [repoOkBody("Acme/Secret", 333, true)] },
      },
    ];

    const res = await claim("acme/secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fullName: string; private: boolean };
    expect(body.fullName).toBe("acme/secret");
    expect(body.private).toBe(true);
    expect(repoFetchCount).toBe(1);
    expect(appInstallationsFetchCount).toBe(1);
    expect(appInstallationReposFetchCount).toBe(1);
  });

  it("rejects no_access when the connected GitHub App token also cannot see the repo", async () => {
    await storeGitHubAppToken("ghu_app_alice");
    repoResponse = { status: 404, body: { message: "Not Found" } };
    appInstallationsResponses = [
      {
        status: 200,
        body: {
          installations: [{ id: 100, app_slug: config.githubAppSlug, suspended_at: null }],
        },
      },
    ];
    appInstallationReposResponses = [
      {
        status: 200,
        body: { repositories: [repoOkBody("Acme/Other", 444, true)] },
      },
    ];

    const res = await claim("acme/secret");
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: string;
      message: string;
      connectUrl: string;
    };
    expect(body.error).toBe("no_access");
    expect(body.message).toContain("GitHub App");
    expect(body.connectUrl).toContain("http://localhost:10000/auth/github-app?intent=");
    expect(body.connectUrl).toContain("install=1");
    expect(repoFetchCount).toBe(1);
    expect(appInstallationsFetchCount).toBe(1);
    expect(appInstallationReposFetchCount).toBe(1);
  });

  it("refreshes an expired GitHub App user token before verifying private repo access", async () => {
    await storeGitHubAppToken("ghu_app_expired", {
      tokenExpiresAt: new Date(Date.now() - 60_000),
      refreshToken: "ghr_app_alice",
      refreshTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    repoResponse = { status: 404, body: { message: "Not Found" } };
    appInstallationsResponses = [
      {
        status: 200,
        body: {
          installations: [{ id: 100, app_slug: config.githubAppSlug, suspended_at: null }],
        },
      },
    ];
    appInstallationReposResponses = [
      {
        status: 200,
        body: { repositories: [repoOkBody("Acme/Refreshed", 556, true)] },
      },
    ];

    const res = await claim("acme/refreshed");
    expect(res.status).toBe(200);

    const [alice] = await db.select().from(users).where(eq(users.id, aliceUserId));
    expect(alice.githubAppTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(lastAppInstallationsAuthorization).toBe("Bearer ghu_app_refreshed");
    expect(appInstallationsFetchCount).toBe(1);
    expect(appInstallationReposFetchCount).toBe(1);
  });

  it("reports disconnected when the GitHub App token and refresh token are expired", async () => {
    await storeGitHubAppToken("ghu_app_expired", {
      tokenExpiresAt: new Date(Date.now() - 60_000),
      refreshToken: "ghr_app_alice",
      refreshTokenExpiresAt: new Date(Date.now() - 1_000),
    });

    const status = await fetch(`${baseUrl}/api/me/github-app/status`, {
      headers: { Cookie: aliceCookie },
    });
    expect(status.status).toBe(200);
    const body = (await status.json()) as {
      configured: boolean;
      connected: boolean;
      installUrl: string | null;
      connectUrl: string;
    };
    expect(body.configured).toBe(true);
    expect(body.connected).toBe(false);
    expect(body.installUrl).toBe(
      `https://github.com/apps/${config.githubAppSlug}/installations/new`,
    );
    expect(body.connectUrl).toStartWith("http://localhost:10000/auth/github-app?intent=");
  });

  it("follows GitHub App pagination when verifying installed repositories", async () => {
    await storeGitHubAppToken("ghu_app_alice");
    repoResponse = { status: 404, body: { message: "Not Found" } };
    appInstallationsResponses = [
      {
        status: 200,
        body: { installations: [] },
        link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next"',
      },
      {
        status: 200,
        body: {
          installations: [{ id: 100, app_slug: config.githubAppSlug, suspended_at: null }],
        },
      },
    ];
    appInstallationReposResponses = [
      {
        status: 200,
        body: { repositories: [] },
        link: '<https://api.github.com/user/installations/100/repositories?per_page=100&page=2>; rel="next"',
      },
      {
        status: 200,
        body: { repositories: [repoOkBody("Acme/Paged", 555, true)] },
      },
    ];

    const res = await claim("acme/paged");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fullName: string; private: boolean };
    expect(body.fullName).toBe("acme/paged");
    expect(body.private).toBe(true);
    expect(repoFetchCount).toBe(1);
    expect(appInstallationsFetchCount).toBe(2);
    expect(appInstallationReposFetchCount).toBe(2);
  });

  it("rejects with 401 token_expired when GitHub returns 401", async () => {
    repoResponse = { status: 401, body: { message: "Bad credentials" } };
    const derived = await insertDerivedCredentials("github-401");

    await expectError(await claim("acme/x"), 401, "token_expired");

    const rows = await db.select().from(userRepos).where(eq(userRepos.userId, aliceUserId));
    expect(rows.length).toBe(0);

    const refreshRows = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, aliceUserId));
    expect(refreshRows).toHaveLength(0);

    const [apiKey] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, await hashToken(derived.apiKey)));
    expect(apiKey).toBeUndefined();

    const [oauthToken] = await db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.accessTokenHash, await hashToken(derived.accessToken)));
    expect(oauthToken?.revokedAt).toBeTruthy();

    const [alice] = await db.select().from(users).where(eq(users.id, aliceUserId));
    expect(alice.credentialsRevokedAt).toBeTruthy();

    const setup = await fetch(`${baseUrl}/api/me/setup-token`, {
      method: "POST",
      headers: { Cookie: aliceCookie },
    });
    expect(setup.status).toBe(401);

    const fresh = await fetch(`${baseUrl}/auth/github/callback?code=alice_code`);
    expect(fresh.status).toBe(200);
    aliceCookie = getCookie(fresh, "session")!;
  });

  it("rejects with 502 upstream_unavailable on GitHub 5xx", async () => {
    repoResponse = { status: 503, body: { message: "Service Unavailable" } };
    await expectError(await claim("acme/x"), 502, "upstream_unavailable");
  });

  it("rejects with 400 invalid_full_name before hitting GitHub", async () => {
    await expectError(await claim("not-a-valid-slug"), 400, "invalid_full_name");
    expect(repoFetchCount).toBe(0);
  });

  it("caches a successful verification — repeat claim within TTL hits GitHub once", async () => {
    repoResponse = { status: 200, body: repoOkBody("acme/beta", 222) };

    await claim("acme/beta");
    await claim("acme/beta");
    expect(repoFetchCount).toBe(1);
  });

  it("rate-limits at 30 claims per hour per user", async () => {
    // 30 successful claims for distinct repos, then the 31st (also a valid
    // fullName, GitHub would 200) should be blocked.
    for (let i = 0; i < 30; i++) {
      repoResponse = { status: 200, body: repoOkBody(`acme/r${i}`, 1000 + i) };
      const r = await claim(`acme/r${i}`);
      expect(r.status).toBe(200);
    }
    repoResponse = { status: 200, body: repoOkBody("acme/r30", 1030) };
    await expectError(await claim("acme/r30"), 429, "rate_limited");
  });
});

async function insertDerivedCredentials(label: string) {
  const [device] = await db
    .insert(devices)
    .values({ userId: aliceUserId, deviceName: `test-${label}`, os: "test" })
    .returning();
  const apiKey = `api-${crypto.randomUUID()}`;
  await db.insert(apiKeys).values({
    userId: aliceUserId,
    deviceId: device.id,
    keyHash: await hashToken(apiKey),
  });
  const accessToken = `mcp_at_${crypto.randomUUID()}`;
  const refreshToken = `mcp_rt_${crypto.randomUUID()}`;
  await db.insert(oauthTokens).values({
    userId: aliceUserId,
    clientId: `client-${label}`,
    accessTokenHash: await hashToken(accessToken),
    refreshTokenHash: await hashToken(refreshToken),
    scope: "mcp:read mcp:write offline_access",
    resource: `${baseUrl}/mcp`,
    accessExpiresAt: new Date(Date.now() + 60_000),
    refreshExpiresAt: new Date(Date.now() + 60_000),
  });
  return { apiKey, accessToken, refreshToken };
}
