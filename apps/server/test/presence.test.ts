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
  const port = app.server!.port;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  restoreFetch();
  app.stop();
  await redis.disconnect();
});

describe("spotify presence", () => {
  let aliceCookie: string;
  let bobCookie: string;
  let aliceApiKey: string;

  const aliceTrack = {
    trackId: "4U4YIDoopcrqZq8CCzdgjd",
    name: "Yonaguni",
    artist: "Greg Foat",
    url: "https://open.spotify.com/track/4U4YIDoopcrqZq8CCzdgjd",
    isPlaying: true,
  };

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
    const aliceRes = await signInAs(baseUrl, "alice_code");
    expect(aliceRes.status).toBe(200);
    aliceCookie = getCookie(aliceRes, "session")!;

    const bobRes = await signInAs(baseUrl, "bob_code");
    expect(bobRes.status).toBe(200);
    bobCookie = getCookie(bobRes, "session")!;

    const [alice] = await db.select().from(users).where(eq(users.githubLogin, "alice"));
    const [bob] = await db.select().from(users).where(eq(users.githubLogin, "bob"));

    const [shared] = await db
      .insert(repos)
      .values({
        githubId: 9001,
        fullName: "presence-test/shared",
        owner: "presence-test",
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

  it("rejects POST /v1/presence/spotify without an API key", async () => {
    const res = await fetch(`${baseUrl}/v1/presence/spotify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ track: aliceTrack }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts a track POST from Alice and exposes it to Bob via /api/presence/peers", async () => {
    const postRes = await fetch(`${baseUrl}/v1/presence/spotify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ track: aliceTrack }),
    });
    expect(postRes.status).toBe(200);

    const bobRes = await fetch(`${baseUrl}/api/presence/peers`, {
      headers: { Cookie: bobCookie },
    });
    expect(bobRes.status).toBe(200);
    const body = (await bobRes.json()) as Record<string, Record<string, unknown>>;
    expect(body.alice).toBeTruthy();
    expect(body.alice.trackId).toBe(aliceTrack.trackId);
    expect(body.alice.name).toBe(aliceTrack.name);
    expect(body.alice.artist).toBe(aliceTrack.artist);
    expect(body.alice.url).toBe(aliceTrack.url);
    expect(body.alice.isPlaying).toBe(true);
    // updatedAt is server-stamped — don't compare a value, just confirm shape.
    expect(typeof body.alice.updatedAt).toBe("string");
  });

  it("also returns the caller's own presence in /api/presence/peers", async () => {
    const aliceRes = await fetch(`${baseUrl}/api/presence/peers`, {
      headers: { Cookie: aliceCookie },
    });
    const body = (await aliceRes.json()) as Record<string, unknown>;
    expect(body.alice).toBeTruthy();
  });

  it("clears presence when Alice POSTs track: null", async () => {
    const postRes = await fetch(`${baseUrl}/v1/presence/spotify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ track: null }),
    });
    expect(postRes.status).toBe(200);

    const bobRes = await fetch(`${baseUrl}/api/presence/peers`, {
      headers: { Cookie: bobCookie },
    });
    const body = (await bobRes.json()) as Record<string, unknown>;
    expect(body.alice).toBeUndefined();
  });

  it("does not leak presence to users who share no repos with the caller", async () => {
    // Alice starts playing again
    await fetch(`${baseUrl}/v1/presence/spotify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ track: aliceTrack }),
    });

    // Create a third user who shares no repos with Alice
    // (mockGitHubAuth only knows alice_code and bob_code, so we fabricate by
    //  inserting a user row + signing a session for them would require
    //  extra plumbing — instead, verify from Bob's side that Alice only
    //  appears because they share the `shared` repo, by dropping that row.)
    const [alice] = await db.select().from(users).where(eq(users.githubLogin, "alice"));
    const [shared] = await db
      .select()
      .from(repos)
      .where(eq(repos.fullName, "presence-test/shared"));

    await db.delete(userRepos).where(eq(userRepos.userId, alice.id));

    const bobRes = await fetch(`${baseUrl}/api/presence/peers`, {
      headers: { Cookie: bobCookie },
    });
    const body = (await bobRes.json()) as Record<string, unknown>;
    expect(body.alice).toBeUndefined();

    // Restore for any downstream tests in the file.
    await db.insert(userRepos).values({ userId: alice.id, repoId: shared.id, permission: "push" });
  });

  it("rejects malformed track payload with 422", async () => {
    const res = await fetch(`${baseUrl}/v1/presence/spotify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ track: { trackId: "x" } }), // missing fields
    });
    expect(res.status).toBe(422);
  });
});
