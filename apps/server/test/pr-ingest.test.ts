import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { db } from "../src/db";
import { pullRequests, repos, userRepos, users } from "../src/db/schema";
import { RedisBridge } from "../src/ws/redis-bridge";
import { getCookie, mockGitHubAuth, resetDatabase, signInAs } from "./helpers";

let redis: RedisBridge;
let app: ReturnType<typeof createApp>;
let baseUrl: string;
let restoreFetch: () => void;
let aliceApiKey: string;
let aliceId: number;

beforeAll(async () => {
  restoreFetch = mockGitHubAuth();
  await resetDatabase();

  redis = new RedisBridge();
  await redis.connect();

  app = createApp(db, redis);
  app.listen(0);
  baseUrl = `http://localhost:${app.server!.port}`;

  const aliceRes = await signInAs(baseUrl, "alice_code");
  const aliceCookie = getCookie(aliceRes, "session")!;
  const [alice] = await db.select().from(users).where(eq(users.githubLogin, "alice")).limit(1);
  aliceId = alice.id;

  const setupRes = await fetch(`${baseUrl}/api/me/setup-token`, {
    method: "POST",
    headers: { Cookie: aliceCookie },
  });
  const { token } = (await setupRes.json()) as { token: string };

  const exchangeRes = await fetch(`${baseUrl}/v1/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, deviceName: "alice-laptop", os: "darwin" }),
  });
  const { apiKey } = (await exchangeRes.json()) as { apiKey: string };
  aliceApiKey = apiKey;
});

afterAll(async () => {
  app?.stop();
  await redis?.disconnect();
  restoreFetch?.();
});

describe("POST /v1/me/prs", () => {
  it("only accepts PR metadata for repos claimed by the caller", async () => {
    await db.insert(repos).values([
      { fullName: "acme/visible", owner: "acme", name: "visible" },
      { fullName: "acme/secret", owner: "acme", name: "secret" },
    ]);
    const [visible] = await db
      .select()
      .from(repos)
      .where(eq(repos.fullName, "acme/visible"))
      .limit(1);
    await db.insert(userRepos).values({
      userId: aliceId,
      repoId: visible.id,
      permission: "claimed",
    });

    const res = await fetch(`${baseUrl}/v1/me/prs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prs: [
          {
            repoFullName: "acme/visible",
            number: 1,
            title: "Visible PR",
            url: "https://github.com/acme/visible/pull/1",
            state: "open",
            updatedAt: new Date().toISOString(),
            headRef: "feature",
          },
          {
            repoFullName: "acme/secret",
            number: 2,
            title: "Hidden PR",
            url: "https://github.com/acme/secret/pull/2",
            state: "open",
            updatedAt: new Date().toISOString(),
            headRef: "feature",
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ upserted: 1, unknownRepos: 1 });

    const rows = await db.select().from(pullRequests);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.repoId).toBe(visible.id);
    expect(rows[0]?.authorLogin).toBe("alice");
  });
});
