import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
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
import { resetDatabase, getCookie, signInAs } from "./helpers";

let redis: RedisBridge;
let app: ReturnType<typeof createApp>;
let baseUrl: string;
let originalFetch: typeof globalThis.fetch;
let aliceCookie: string;
let aliceUserId: number;

// Mock state (reset per-test)
let orgMembershipsFetchCount = 0;
let orgMembershipsResponses: Array<{
  status: number;
  body: unknown;
  link?: string;
}> = [{ status: 200, body: [] }];

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
      return new Response(JSON.stringify({ access_token: "ghtoken_alice_code" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify(ALICE), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.startsWith("https://api.github.com/user/memberships/orgs?")) {
      orgMembershipsFetchCount += 1;
      const response =
        orgMembershipsResponses[orgMembershipsFetchCount - 1] ??
        orgMembershipsResponses[orgMembershipsResponses.length - 1]!;
      return new Response(JSON.stringify(response.body ?? []), {
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
  const res = await signInAs(baseUrl, "alice_code");
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
  orgMembershipsFetchCount = 0;
  orgMembershipsResponses = [{ status: 200, body: [] }];
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

function activeMembership(orgLogin: string): unknown {
  return {
    state: "active",
    organization: { login: orgLogin },
  };
}

async function expectError(res: Response, status: number, kind: string): Promise<void> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe(kind);
}

function jsonHeaders(link?: string): Record<string, string> {
  return link
    ? { "Content-Type": "application/json", Link: link }
    : { "Content-Type": "application/json" };
}

describe("POST /api/me/repos — org-or-self gate", () => {
  it("accepts a claim when owner is in the caller's active org memberships", async () => {
    orgMembershipsResponses = [
      { status: 200, body: [activeMembership("Acme"), activeMembership("Other")] },
    ];

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
    // Stored lowercase (normalizeFullName) but owner/name preserve user-input casing.
    expect(body.fullName).toBe("acme/alpha");
    expect(body.owner).toBe("Acme");
    expect(body.name).toBe("Alpha");
    // No GitHub /repos call → no canonical metadata; defaults to false.
    expect(body.private).toBe(false);
    expect(body.permission).toBe("claimed");

    const rows = await db
      .select({ repoId: userRepos.repoId, githubId: repos.githubId })
      .from(userRepos)
      .innerJoin(repos, eq(repos.id, userRepos.repoId))
      .where(eq(userRepos.userId, aliceUserId));
    expect(rows.length).toBe(1);
    // githubId is null for new claims under the org-or-self gate.
    expect(rows[0].githubId).toBeNull();
    expect(orgMembershipsFetchCount).toBe(1);
  });

  it("accepts a claim in the caller's personal namespace without calling GitHub", async () => {
    // No orgs configured; this should still succeed via the personal-namespace
    // branch, which is short-circuited before any GitHub call.
    const res = await claim("alice/personal-thing");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fullName: string; owner: string };
    expect(body.fullName).toBe("alice/personal-thing");
    expect(body.owner).toBe("alice");
    expect(orgMembershipsFetchCount).toBe(0);

    const rows = await db.select().from(userRepos).where(eq(userRepos.userId, aliceUserId));
    expect(rows.length).toBe(1);
  });

  it("matches personal-namespace case-insensitively (Alice can claim ALICE/foo)", async () => {
    const res = await claim("ALICE/Foo");
    expect(res.status).toBe(200);
    expect(orgMembershipsFetchCount).toBe(0);
  });

  it("rejects 403 no_access when owner is neither an org nor the caller's login", async () => {
    orgMembershipsResponses = [{ status: 200, body: [activeMembership("Acme")] }];

    const res = await claim("vercel/next.js");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("no_access");
    expect(body.message).toContain("orgs");

    const rows = await db.select().from(userRepos).where(eq(userRepos.userId, aliceUserId));
    expect(rows.length).toBe(0);
    expect(orgMembershipsFetchCount).toBe(1);
  });

  it("ignores pending memberships (only state=active counts)", async () => {
    orgMembershipsResponses = [
      {
        status: 200,
        body: [{ state: "pending", organization: { login: "acme" } }, activeMembership("other")],
      },
    ];

    await expectError(await claim("acme/foo"), 403, "no_access");
  });

  it("matches org membership case-insensitively (GitHub is case-insensitive on org login)", async () => {
    orgMembershipsResponses = [{ status: 200, body: [activeMembership("Acme")] }];

    // User claims with lowercased owner; gate matches against lowercased orgs.
    const res = await claim("acme/Foo");
    expect(res.status).toBe(200);
  });

  it("caches membership lookups — repeat claims hit GitHub once within TTL", async () => {
    orgMembershipsResponses = [{ status: 200, body: [activeMembership("acme")] }];

    await claim("acme/alpha");
    await claim("acme/beta");
    await claim("acme/gamma");
    expect(orgMembershipsFetchCount).toBe(1);
  });

  it("follows pagination on the memberships endpoint", async () => {
    orgMembershipsResponses = [
      {
        status: 200,
        body: [activeMembership("first")],
        link: '<https://api.github.com/user/memberships/orgs?state=active&per_page=100&page=2>; rel="next"',
      },
      {
        status: 200,
        body: [activeMembership("acme")],
      },
    ];

    const res = await claim("acme/alpha");
    expect(res.status).toBe(200);
    expect(orgMembershipsFetchCount).toBe(2);
  });

  it("rejects with 401 token_expired and revokes credentials when GitHub returns 401", async () => {
    orgMembershipsResponses = [{ status: 401, body: { message: "Bad credentials" } }];
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

    const fresh = await signInAs(baseUrl, "alice_code");
    expect(fresh.status).toBe(200);
    aliceCookie = getCookie(fresh, "session")!;
  });

  it("rejects with 502 upstream_unavailable on GitHub 5xx", async () => {
    orgMembershipsResponses = [{ status: 503, body: { message: "Service Unavailable" } }];
    await expectError(await claim("acme/x"), 502, "upstream_unavailable");
  });

  it("rejects with 502 upstream_unavailable on GitHub 403 (rate-limit / abuse)", async () => {
    orgMembershipsResponses = [{ status: 403, body: { message: "API rate limit exceeded" } }];
    await expectError(await claim("acme/x"), 502, "upstream_unavailable");
  });

  it("rejects with 400 invalid_full_name before hitting GitHub", async () => {
    await expectError(await claim("not-a-valid-slug"), 400, "invalid_full_name");
    expect(orgMembershipsFetchCount).toBe(0);
  });

  it("rate-limits at 30 claims per hour per user", async () => {
    orgMembershipsResponses = [{ status: 200, body: [activeMembership("acme")] }];

    for (let i = 0; i < 30; i++) {
      const r = await claim(`acme/r${i}`);
      expect(r.status).toBe(200);
    }
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
