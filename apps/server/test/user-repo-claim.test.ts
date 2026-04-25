import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { createApp } from "../src/app";
import { RedisBridge } from "../src/ws/redis-bridge";
import { __clearOrgCaches } from "../src/user/routes";
import {
  apiKeys,
  devices,
  oauthTokens,
  refreshTokens,
  repos,
  userRepos,
  users,
} from "../src/db/schema";
import { hashToken } from "../src/auth/tokens";
import { resetDatabase, getCookie } from "./helpers";

let redis: RedisBridge;
let app: ReturnType<typeof createApp>;
let baseUrl: string;
let originalFetch: typeof globalThis.fetch;
let aliceCookie: string;
let aliceUserId: number;

// Mock state (reset per-test)
let repoFetchCount = 0;
let repoResponse: { status: number; body: unknown } = { status: 200, body: {} };

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
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (url === "https://github.com/login/oauth/access_token") {
      return new Response(
        JSON.stringify({ access_token: "ghtoken_alice_code" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify(ALICE), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.startsWith("https://api.github.com/repos/")) {
      repoFetchCount += 1;
      return new Response(JSON.stringify(repoResponse.body ?? {}), {
        status: repoResponse.status,
        headers: { "Content-Type": "application/json" },
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
  repoResponse = { status: 200, body: {} };
  // Drop any user_repos / repos rows from prior cases so counts are exact.
  await db.delete(userRepos).where(eq(userRepos.userId, aliceUserId));
  await db.delete(repos);
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

async function expectError(
  res: Response,
  status: number,
  kind: string,
): Promise<void> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe(kind);
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

  it("rejects with 403 no_access when GitHub returns 404 — no user_repos row created", async () => {
    repoResponse = { status: 404, body: { message: "Not Found" } };

    await expectError(await claim("acme/secret"), 403, "no_access");

    const rows = await db
      .select()
      .from(userRepos)
      .where(eq(userRepos.userId, aliceUserId));
    expect(rows.length).toBe(0);
    expect(repoFetchCount).toBe(1);
  });

  it("rejects with 401 token_expired when GitHub returns 401", async () => {
    repoResponse = { status: 401, body: { message: "Bad credentials" } };
    const derived = await insertDerivedCredentials("github-401");

    await expectError(await claim("acme/x"), 401, "token_expired");

    const rows = await db
      .select()
      .from(userRepos)
      .where(eq(userRepos.userId, aliceUserId));
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
      .where(
        eq(oauthTokens.accessTokenHash, await hashToken(derived.accessToken)),
      );
    expect(oauthToken?.revokedAt).toBeTruthy();
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
