import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { users, repos, userRepos } from "../src/db/schema";
import { createApp } from "../src/app";
import { RedisBridge } from "../src/ws/redis-bridge";
import { resetDatabase, mockGitHubAuth, getCookie, signInAs } from "./helpers";

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

describe("user location", () => {
  let aliceCookie: string;
  let bobCookie: string;
  let aliceApiKey: string;

  async function exchangeApiKey(cookie: string, deviceName: string): Promise<string> {
    const setupRes = await fetch(`${baseUrl}/api/me/setup-token`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    const { token } = (await setupRes.json()) as { token: string };
    const exchangeRes = await fetch(`${baseUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, deviceName, os: "darwin" }),
    });
    const { apiKey } = (await exchangeRes.json()) as { apiKey: string };
    return apiKey;
  }

  it("sets up two users sharing a repo", async () => {
    aliceCookie = getCookie(await signInAs(baseUrl, "alice_code"), "session")!;
    bobCookie = getCookie(await signInAs(baseUrl, "bob_code"), "session")!;
    expect(aliceCookie).toBeTruthy();
    expect(bobCookie).toBeTruthy();

    const [alice] = await db.select().from(users).where(eq(users.githubLogin, "alice"));
    const [bob] = await db.select().from(users).where(eq(users.githubLogin, "bob"));

    const [shared] = await db
      .insert(repos)
      .values({
        githubId: 9101,
        fullName: "loc-test/shared",
        owner: "loc-test",
        name: "shared",
      })
      .returning();
    await db.insert(userRepos).values([
      { userId: alice.id, repoId: shared.id, permission: "push" },
      { userId: bob.id, repoId: shared.id, permission: "push" },
    ]);

    aliceApiKey = await exchangeApiKey(aliceCookie, "alice-laptop");
    expect(aliceApiKey).toBeTruthy();
  });

  it("rejects POST /v1/me/location without an API key", async () => {
    const res = await fetch(`${baseUrl}/v1/me/location`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "America/New_York", city: "New York" }),
    });
    expect(res.status).toBe(401);
  });

  it("persists a valid IANA timezone + city to the users row", async () => {
    const res = await fetch(`${baseUrl}/v1/me/location`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ timezone: "Europe/Paris", city: "Paris" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const [alice] = await db.select().from(users).where(eq(users.githubLogin, "alice"));
    expect(alice.timezone).toBe("Europe/Paris");
    expect(alice.city).toBe("Paris");
  });

  it("rejects an unknown timezone with 400 and leaves the row untouched", async () => {
    const res = await fetch(`${baseUrl}/v1/me/location`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ timezone: "lol/notreal", city: "Paris" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: "invalid_timezone" });

    const [alice] = await db.select().from(users).where(eq(users.githubLogin, "alice"));
    expect(alice.timezone).toBe("Europe/Paris");
  });

  it("accepts null timezone + city to clear the row", async () => {
    const res = await fetch(`${baseUrl}/v1/me/location`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ timezone: null, city: null }),
    });
    expect(res.status).toBe(200);

    const [alice] = await db.select().from(users).where(eq(users.githubLogin, "alice"));
    expect(alice.timezone).toBeNull();
    expect(alice.city).toBeNull();
  });

  it("returns peer location to a user who shares a repo", async () => {
    await fetch(`${baseUrl}/v1/me/location`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ timezone: "Europe/Paris", city: "Paris" }),
    });

    const res = await fetch(`${baseUrl}/api/presence/locations`, {
      headers: { Cookie: bobCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, { timezone: string; city: string }>;
    expect(body.alice).toEqual({ timezone: "Europe/Paris", city: "Paris" });
  });

  it("does not leak peer location to users with no shared repo", async () => {
    const [alice] = await db.select().from(users).where(eq(users.githubLogin, "alice"));
    const [shared] = await db.select().from(repos).where(eq(repos.fullName, "loc-test/shared"));

    // Drop Alice's membership so Bob no longer shares any repo with her.
    await db.delete(userRepos).where(eq(userRepos.userId, alice.id));

    const res = await fetch(`${baseUrl}/api/presence/locations`, {
      headers: { Cookie: bobCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.alice).toBeUndefined();

    // Restore — keeps the suite re-runnable in any order.
    await db.insert(userRepos).values({ userId: alice.id, repoId: shared.id, permission: "push" });
  });
});
