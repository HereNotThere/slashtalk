import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import {
  apiKeys,
  devices,
  oauthTokens,
  refreshTokens,
  users,
} from "../src/db/schema";
import { createApp } from "../src/app";
import { RedisBridge } from "../src/ws/redis-bridge";
import { hashToken } from "../src/auth/tokens";
import { resetDatabase, mockGitHubAuth, getCookie } from "./helpers";

let redis: RedisBridge;
let app: ReturnType<typeof createApp>;
let baseUrl: string;
let restoreFetch: () => void;

beforeAll(async () => {
  restoreFetch = mockGitHubAuth();
  await resetDatabase();
  redis = new RedisBridge();
  await redis.connect();
  app = createApp(db, redis);
  app.listen(0);
  baseUrl = `http://localhost:${app.server!.port}`;
});

afterAll(async () => {
  restoreFetch();
  app.stop();
  await redis.disconnect();
});

// Sign in and extract both cookies + the raw jwt+refreshToken the desktop
// flow would get via the loopback redirect. We call the callback without a
// desktop_port so we stay on the cookie branch; the raw refresh token
// matches the cookie value since cookies are the source of truth.
async function signIn(code: string): Promise<{
  sessionCookie: string;
  refreshCookie: string;
  refreshToken: string;
  userId: number;
}> {
  const res = await fetch(`${baseUrl}/auth/github/callback?code=${code}`);
  expect(res.status).toBe(200);
  const sessionCookie = getCookie(res, "session")!;
  const refreshCookie = getCookie(res, "refresh")!;
  expect(sessionCookie).toBeTruthy();
  expect(refreshCookie).toBeTruthy();
  const refreshToken = refreshCookie.split("=")[1];

  const body = (await res.json()) as { user: { id: number } };
  return {
    sessionCookie,
    refreshCookie,
    refreshToken,
    userId: body.user.id,
  };
}

describe("/auth/refresh", () => {
  it("rotates tokens when presented via cookie (browser flow)", async () => {
    const alice = await signIn("alice_code");

    const res = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { Cookie: alice.refreshCookie },
    });
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      ok: boolean;
      jwt: string;
      refreshToken: string;
    };
    expect(data.ok).toBe(true);
    expect(data.jwt).toBeTruthy();
    expect(data.refreshToken).toBeTruthy();
    expect(data.refreshToken).not.toBe(alice.refreshToken);

    // New cookies are set alongside the body response.
    expect(getCookie(res, "session")).toBeTruthy();
    expect(getCookie(res, "refresh")).toBeTruthy();
  });

  it("rotates tokens when presented via body (desktop flow)", async () => {
    const alice = await signIn("alice_code");

    const res = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: alice.refreshToken }),
    });
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      ok: boolean;
      jwt: string;
      refreshToken: string;
    };
    expect(data.jwt).toBeTruthy();
    expect(data.refreshToken).toBeTruthy();
    expect(data.refreshToken).not.toBe(alice.refreshToken);
  });

  it("rejects replay of a rotated token (401)", async () => {
    const alice = await signIn("alice_code");

    const first = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: alice.refreshToken }),
    });
    expect(first.status).toBe(200);

    const replay = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: alice.refreshToken }),
    });
    expect(replay.status).toBe(401);
  });

  it("returns 401 when no token is presented", async () => {
    const res = await fetch(`${baseUrl}/auth/refresh`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an unknown token", async () => {
    const res = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: crypto.randomUUID() }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired token and deletes the row", async () => {
    const alice = await signIn("alice_code");

    // Manually expire the row.
    await db
      .update(refreshTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(refreshTokens.tokenHash, await hashToken(alice.refreshToken)));

    const res = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: alice.refreshToken }),
    });
    expect(res.status).toBe(401);

    // The expired row is cleaned up opportunistically by the rotation path.
    const [row] = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, await hashToken(alice.refreshToken)));
    expect(row).toBeUndefined();
  });

  it("lets only one of two concurrent refreshes succeed", async () => {
    const alice = await signIn("alice_code");

    const [a, b] = await Promise.all([
      fetch(`${baseUrl}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: alice.refreshToken }),
      }),
      fetch(`${baseUrl}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: alice.refreshToken }),
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
  });

  it("rotation issues exactly one new row per refresh", async () => {
    const alice = await signIn("alice_code");

    const before = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, alice.userId));

    const res = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: alice.refreshToken }),
    });
    expect(res.status).toBe(200);

    const after = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, alice.userId));
    expect(after.length).toBe(before.length);

    const oldHash = await hashToken(alice.refreshToken);
    expect(after.find((r) => r.tokenHash === oldHash)).toBeUndefined();
  });
});

describe("/auth/logout", () => {
  it("revokes the refresh token when presented via cookie", async () => {
    const alice = await signIn("alice_code");

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { Cookie: alice.refreshCookie },
    });
    expect(logout.status).toBe(200);

    const [row] = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, await hashToken(alice.refreshToken)));
    expect(row).toBeUndefined();

    // Subsequent refresh with the revoked token is rejected.
    const refreshRes = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: alice.refreshToken }),
    });
    expect(refreshRes.status).toBe(401);
  });

  it("revokes the refresh token when presented via body (desktop flow)", async () => {
    const alice = await signIn("alice_code");

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: alice.refreshToken }),
    });
    expect(logout.status).toBe(200);

    const [row] = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, await hashToken(alice.refreshToken)));
    expect(row).toBeUndefined();
  });

  it("is a no-op when no token is presented", async () => {
    await signIn("alice_code");
    const before = await db.select().from(refreshTokens);

    const res = await fetch(`${baseUrl}/auth/logout`, { method: "POST" });
    expect(res.status).toBe(200);

    const after = await db.select().from(refreshTokens);
    expect(after.length).toBe(before.length);
  });

  it("does not revoke other refresh tokens, devices, or MCP OAuth grants", async () => {
    const alice = await signIn("alice_code");
    const otherSession = await signIn("alice_code");
    const bundle = await insertCredentialBundle(alice.userId, "logout-scope");

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: alice.refreshToken }),
    });
    expect(logout.status).toBe(200);

    const remainingRefreshes = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, alice.userId));
    const otherSessionHash = await hashToken(otherSession.refreshToken);
    expect(
      remainingRefreshes.some((row) => row.tokenHash === otherSessionHash),
    ).toBe(true);

    const [apiKey] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, await hashToken(bundle.apiKey)));
    expect(apiKey).toBeTruthy();

    const [oauthToken] = await db
      .select()
      .from(oauthTokens)
      .where(
        eq(oauthTokens.accessTokenHash, await hashToken(bundle.accessToken)),
      );
    expect(oauthToken?.revokedAt).toBeNull();

    const setup = await fetch(`${baseUrl}/api/me/setup-token`, {
      method: "POST",
      headers: { Cookie: otherSession.sessionCookie },
    });
    expect(setup.status).toBe(200);
  });
});

describe("device revoke", () => {
  it("revokes only the selected device API key and leaves other grants intact", async () => {
    const alice = await signIn("alice_code");
    const first = await insertCredentialBundle(alice.userId, "device-revoke-1");
    const second = await insertCredentialBundle(alice.userId, "device-revoke-2");

    const res = await fetch(`${baseUrl}/api/me/devices/${first.deviceId}`, {
      method: "DELETE",
      headers: { Cookie: alice.sessionCookie },
    });
    expect(res.status).toBe(200);

    const [deletedKey] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, await hashToken(first.apiKey)));
    expect(deletedKey).toBeUndefined();

    const [keptKey] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, await hashToken(second.apiKey)));
    expect(keptKey).toBeTruthy();

    const [refresh] = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, await hashToken(alice.refreshToken)));
    expect(refresh).toBeTruthy();

    const [oauthToken] = await db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.accessTokenHash, await hashToken(first.accessToken)));
    expect(oauthToken?.revokedAt).toBeNull();
  });
});

describe("/auth/logout-everywhere", () => {
  it("revokes all refresh tokens, device API keys, and MCP OAuth tokens for the signed-in user only", async () => {
    const alice = await signIn("alice_code");
    await signIn("alice_code");
    const bob = await signIn("bob_code");
    const aliceBundle = await insertCredentialBundle(alice.userId, "global-alice");
    const bobBundle = await insertCredentialBundle(bob.userId, "global-bob");

    const before = await mcpInitialize(aliceBundle.accessToken);
    expect(before.status).toBe(200);

    const res = await fetch(`${baseUrl}/auth/logout-everywhere`, {
      method: "POST",
      headers: { Cookie: alice.sessionCookie },
    });
    expect(res.status).toBe(200);

    const aliceRefreshes = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, alice.userId));
    expect(aliceRefreshes).toHaveLength(0);

    const bobRefreshes = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, bob.userId));
    expect(bobRefreshes.length).toBeGreaterThan(0);

    const [aliceKey] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, await hashToken(aliceBundle.apiKey)));
    expect(aliceKey).toBeUndefined();

    const [bobKey] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, await hashToken(bobBundle.apiKey)));
    expect(bobKey).toBeTruthy();

    const [aliceOauth] = await db
      .select()
      .from(oauthTokens)
      .where(
        eq(
          oauthTokens.accessTokenHash,
          await hashToken(aliceBundle.accessToken),
        ),
      );
    expect(aliceOauth?.revokedAt).toBeTruthy();

    const [bobOauth] = await db
      .select()
      .from(oauthTokens)
      .where(
        eq(oauthTokens.accessTokenHash, await hashToken(bobBundle.accessToken)),
      );
    expect(bobOauth?.revokedAt).toBeNull();

    const after = await mcpInitialize(aliceBundle.accessToken);
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toContain(
      'error_description="revoked"',
    );

    const [aliceUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, alice.userId));
    expect(aliceUser.credentialsRevokedAt).toBeTruthy();

    const oldJwtSetup = await fetch(`${baseUrl}/api/me/setup-token`, {
      method: "POST",
      headers: { Cookie: alice.sessionCookie },
    });
    expect(oldJwtSetup.status).toBe(401);

    const freshAlice = await signIn("alice_code");
    const freshJwtSetup = await fetch(`${baseUrl}/api/me/setup-token`, {
      method: "POST",
      headers: { Cookie: freshAlice.sessionCookie },
    });
    expect(freshJwtSetup.status).toBe(200);
  });
});

describe("sign-in issues session + refresh cookies", () => {
  it("emits both cookies on /auth/github/callback", async () => {
    const res = await fetch(`${baseUrl}/auth/github/callback?code=bob_code`);
    expect(res.status).toBe(200);
    expect(getCookie(res, "session")).toBeTruthy();
    expect(getCookie(res, "refresh")).toBeTruthy();

    // The refresh row exists for Bob.
    const [bob] = await db
      .select()
      .from(users)
      .where(eq(users.githubLogin, "bob"));
    const rows = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, bob.id));
    expect(rows.length).toBeGreaterThan(0);
  });
});

async function insertCredentialBundle(userId: number, label: string) {
  const [device] = await db
    .insert(devices)
    .values({ userId, deviceName: `test-${label}`, os: "test" })
    .returning();
  const apiKey = `api-${crypto.randomUUID()}`;
  await db.insert(apiKeys).values({
    userId,
    deviceId: device.id,
    keyHash: await hashToken(apiKey),
  });
  const accessToken = `mcp_at_${crypto.randomUUID()}`;
  const refreshToken = `mcp_rt_${crypto.randomUUID()}`;
  await db.insert(oauthTokens).values({
    userId,
    clientId: `client-${label}`,
    accessTokenHash: await hashToken(accessToken),
    refreshTokenHash: await hashToken(refreshToken),
    scope: "mcp:read mcp:write offline_access",
    resource: `${baseUrl}/mcp`,
    accessExpiresAt: new Date(Date.now() + 60_000),
    refreshExpiresAt: new Date(Date.now() + 60_000),
  });
  return { deviceId: device.id, apiKey, accessToken, refreshToken };
}

function mcpInitialize(token: string) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "refresh-test", version: "0.0.0" },
      },
    }),
  });
}
