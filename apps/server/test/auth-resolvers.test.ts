import { beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createAuthInstance } from "../src/auth/instance";
import { hashToken } from "../src/auth/tokens";
import { db } from "../src/db";
import { apiKeys, devices, oauthTokens, users } from "../src/db/schema";
import { resetDatabase } from "./helpers";

const NOW = new Date("2026-05-04T19:00:00.000Z");

let userId: number;
let touchDeviceId: number;
let noTouchDeviceId: number;
let touchKey = "";
let noTouchKey = "";
let mcpAccessToken = "";

beforeAll(async () => {
  await resetDatabase();

  const [user] = await db
    .insert(users)
    .values({
      githubId: 41_001,
      githubLogin: "resolver-user",
      avatarUrl: "https://avatars.test/resolver-user",
      displayName: "Resolver User",
      githubToken: "encrypted-token",
    })
    .returning();
  userId = user.id;

  const [touchDevice, noTouchDevice] = await db
    .insert(devices)
    .values([
      { userId, deviceName: "resolver-laptop", os: "darwin" },
      { userId, deviceName: "resolver-desktop", os: "linux" },
    ])
    .returning();
  touchDeviceId = touchDevice.id;
  noTouchDeviceId = noTouchDevice.id;

  touchKey = `resolver_touch_${crypto.randomUUID()}`;
  noTouchKey = `resolver_no_touch_${crypto.randomUUID()}`;
  await db.insert(apiKeys).values([
    {
      userId,
      deviceId: touchDeviceId,
      keyHash: await hashToken(touchKey),
      lastUsedAt: null,
    },
    {
      userId,
      deviceId: noTouchDeviceId,
      keyHash: await hashToken(noTouchKey),
      lastUsedAt: null,
    },
  ]);

  mcpAccessToken = `mcp_at_${crypto.randomUUID()}`;
  await db.insert(oauthTokens).values({
    userId,
    clientId: "resolver-client",
    accessTokenHash: await hashToken(mcpAccessToken),
    refreshTokenHash: await hashToken(`mcp_rt_${crypto.randomUUID()}`),
    scope: "mcp:read mcp:write offline_access",
    resource: "http://localhost:10000/mcp",
    accessExpiresAt: new Date(NOW.getTime() + 60_000),
    refreshExpiresAt: new Date(NOW.getTime() + 120_000),
  });
});

describe("auth resolvers", () => {
  it("resolves session JWTs through the shared credential-freshness path", async () => {
    const auth = createAuthInstance({ db, now: () => NOW });
    const user = await auth.resolveSessionJwt(
      {
        verify: async (token) =>
          token === "good-session" ? { sub: userId, sessionIssuedAt: NOW.getTime() } : false,
      },
      "good-session",
    );

    expect(user?.id).toBe(userId);
    expect(await auth.resolveSessionJwt({ verify: async () => false }, "bad-session")).toBeNull();
  });

  it("makes API-key last_used_at updates an explicit per-call policy", async () => {
    const auth = createAuthInstance({ db, now: () => NOW });

    const untouched = await auth.resolveApiKey(noTouchKey, { touchLastUsedAt: false });
    expect(untouched.ok).toBe(true);
    const [untouchedRow] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, await hashToken(noTouchKey)));
    expect(untouchedRow.lastUsedAt).toBeNull();

    const touched = await auth.resolveApiKey(touchKey, { touchLastUsedAt: true });
    expect(touched.ok).toBe(true);
    const [touchedRow] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, await hashToken(touchKey)));
    expect(touchedRow.lastUsedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("resolves MCP OAuth access tokens with resource, expiry, and scope checks", async () => {
    const auth = createAuthInstance({ db, now: () => NOW });

    const resolved = await auth.resolveMcpAccessToken(mcpAccessToken, "http://localhost:10000/mcp");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.user.id).toBe(userId);

    const wrongResource = await auth.resolveMcpAccessToken(
      mcpAccessToken,
      "http://localhost:10000/not-mcp",
    );
    expect(wrongResource).toEqual({ ok: false, reason: "resource mismatch" });
  });
});
