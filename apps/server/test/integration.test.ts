import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { users, repos, userRepos, sessions } from "../src/db/schema";
import { createApp } from "../src/app";
import { RedisBridge } from "../src/ws/redis-bridge";
import {
  resetDatabase,
  mockGitHubAuth,
  getCookie,
  makeEvent,
  makeNdjson,
} from "./helpers";

let redis: RedisBridge;
let app: ReturnType<typeof createApp>;
let baseUrl: string;
let restoreFetch: () => void;

// ── Test data IDs ────────────────────────────────────────────
const COMMON_SESSION_ID = "a0000000-0000-0000-0000-000000000001";
const REPO_A_SESSION_ID = "a0000000-0000-0000-0000-000000000002";

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

describe("social feed integration", () => {
  let aliceCookie: string;
  let bobCookie: string;
  let aliceApiKey: string;
  let aliceUserId: number;
  let bobUserId: number;
  let repoAId: number;
  let repoBId: number;
  let commonRepoId: number;

  it("authenticates two users via mock GitHub OAuth", async () => {
    // Alice logs in
    const aliceRes = await fetch(
      `${baseUrl}/auth/github/callback?code=alice_code`
    );
    expect(aliceRes.status).toBe(200);
    aliceCookie = getCookie(aliceRes, "session")!;
    expect(aliceCookie).toBeTruthy();

    // Bob logs in
    const bobRes = await fetch(
      `${baseUrl}/auth/github/callback?code=bob_code`
    );
    expect(bobRes.status).toBe(200);
    bobCookie = getCookie(bobRes, "session")!;
    expect(bobCookie).toBeTruthy();

    // Verify users exist
    const [alice] = await db
      .select()
      .from(users)
      .where(eq(users.githubLogin, "alice"));
    const [bob] = await db
      .select()
      .from(users)
      .where(eq(users.githubLogin, "bob"));
    expect(alice).toBeTruthy();
    expect(bob).toBeTruthy();
    aliceUserId = alice.id;
    bobUserId = bob.id;
  });

  it("sets up repos with shared access", async () => {
    // Create 3 repos: repo-a (Alice), repo-b (Bob), repo-common (both)
    const [repoA] = await db
      .insert(repos)
      .values({
        githubId: 2001,
        fullName: "alice-org/repo-a",
        owner: "alice-org",
        name: "repo-a",
      })
      .returning();
    const [repoB] = await db
      .insert(repos)
      .values({
        githubId: 2002,
        fullName: "bob-org/repo-b",
        owner: "bob-org",
        name: "repo-b",
      })
      .returning();
    const [repoCommon] = await db
      .insert(repos)
      .values({
        githubId: 2003,
        fullName: "shared-org/repo-common",
        owner: "shared-org",
        name: "repo-common",
      })
      .returning();

    repoAId = repoA.id;
    repoBId = repoB.id;
    commonRepoId = repoCommon.id;

    // Alice -> repo-a, repo-common
    await db
      .insert(userRepos)
      .values([
        { userId: aliceUserId, repoId: repoAId, permission: "push" },
        { userId: aliceUserId, repoId: commonRepoId, permission: "push" },
      ]);

    // Bob -> repo-b, repo-common
    await db
      .insert(userRepos)
      .values([
        { userId: bobUserId, repoId: repoBId, permission: "push" },
        { userId: bobUserId, repoId: commonRepoId, permission: "push" },
      ]);
  });

  it("Alice gets an API key via setup token exchange", async () => {
    // Generate setup token
    const setupRes = await fetch(`${baseUrl}/api/me/setup-token`, {
      method: "POST",
      headers: { Cookie: aliceCookie },
    });
    expect(setupRes.status).toBe(200);
    const { token: setupToken } = (await setupRes.json()) as {
      token: string;
    };
    expect(setupToken).toBeTruthy();

    // Exchange for API key
    const exchangeRes = await fetch(`${baseUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: setupToken,
        deviceName: "alice-laptop",
        os: "darwin",
      }),
    });
    expect(exchangeRes.status).toBe(200);
    const exchangeData = (await exchangeRes.json()) as {
      apiKey: string;
      deviceId: number;
    };
    aliceApiKey = exchangeData.apiKey;
    expect(aliceApiKey).toBeTruthy();

    // Pre-create sessions linked to repos
    await db.insert(sessions).values([
      {
        sessionId: COMMON_SESSION_ID,
        userId: aliceUserId,
        deviceId: exchangeData.deviceId,
        source: "claude",
        project: "test-project-common",
        repoId: commonRepoId,
      },
      {
        sessionId: REPO_A_SESSION_ID,
        userId: aliceUserId,
        deviceId: exchangeData.deviceId,
        source: "claude",
        project: "test-project-a",
        repoId: repoAId,
      },
    ]);
  });

  it("Bob receives WebSocket push when Alice ingests to shared repo", async () => {
    // Bob gets API key for WebSocket auth
    const bobSetupRes = await fetch(`${baseUrl}/api/me/setup-token`, {
      method: "POST",
      headers: { Cookie: bobCookie },
    });
    const { token: bobSetupToken } = (await bobSetupRes.json()) as {
      token: string;
    };
    const bobExchangeRes = await fetch(`${baseUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: bobSetupToken,
        deviceName: "bob-laptop",
        os: "linux",
      }),
    });
    const { apiKey: bobApiKey } = (await bobExchangeRes.json()) as {
      apiKey: string;
    };

    // Connect Bob's WebSocket
    const wsUrl = `${baseUrl.replace("http", "ws")}/ws?token=${bobApiKey}`;
    const ws = new WebSocket(wsUrl);
    const messages: any[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
      setTimeout(() => reject(new Error("WS timeout")), 5000);
    });

    ws.onmessage = (e) => {
      const data = JSON.parse(e.data as string);
      if (data.type !== "ping") messages.push(data);
    };

    // Wait for Redis subscriptions to propagate
    await new Promise((r) => setTimeout(r, 300));

    // Alice ingests events to the SHARED repo session
    const commonEvents = [
      makeEvent({
        sessionId: COMMON_SESSION_ID,
        type: "user",
        timestamp: new Date().toISOString(),
      }),
    ];
    const ingestRes = await fetch(
      `${baseUrl}/v1/ingest?project=test-project-common&session=${COMMON_SESSION_ID}&fromLineSeq=0`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          Authorization: `Bearer ${aliceApiKey}`,
        },
        body: makeNdjson(commonEvents),
      }
    );
    expect(ingestRes.status).toBe(200);
    const ingestData = (await ingestRes.json()) as {
      acceptedEvents: number;
    };
    expect(ingestData.acceptedEvents).toBe(1);

    // Wait for Redis -> WebSocket propagation
    await new Promise((r) => setTimeout(r, 500));

    // Bob should have received the session_updated message
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const sessionUpdate = messages.find(
      (m) => m.type === "session_updated"
    );
    expect(sessionUpdate).toBeTruthy();
    expect(sessionUpdate.session_id).toBe(COMMON_SESSION_ID);

    // Alice ingests events to repo-a (Alice-only)
    const repoAEvents = [
      makeEvent({
        sessionId: REPO_A_SESSION_ID,
        type: "user",
        timestamp: new Date().toISOString(),
      }),
    ];
    const prevMessageCount = messages.length;
    await fetch(
      `${baseUrl}/v1/ingest?project=test-project-a&session=${REPO_A_SESSION_ID}&fromLineSeq=0`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          Authorization: `Bearer ${aliceApiKey}`,
        },
        body: makeNdjson(repoAEvents),
      }
    );

    // Wait and confirm Bob did NOT get notified about repo-a
    await new Promise((r) => setTimeout(r, 300));
    const newMessages = messages
      .slice(prevMessageCount)
      .filter((m) => m.type === "session_updated");
    expect(newMessages).toHaveLength(0);

    ws.close();
  });

  it("Bob's feed shows shared-repo session but not Alice-only session", async () => {
    const feedRes = await fetch(`${baseUrl}/api/feed`, {
      headers: { Cookie: bobCookie },
    });
    expect(feedRes.status).toBe(200);
    const feed = (await feedRes.json()) as { id: string }[];

    const sessionIds = feed.map((s) => s.id);
    expect(sessionIds).toContain(COMMON_SESSION_ID);
    expect(sessionIds).not.toContain(REPO_A_SESSION_ID);
  });
});
