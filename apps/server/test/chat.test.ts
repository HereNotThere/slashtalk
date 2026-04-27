import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { users, repos, userRepos, sessions, sessionInsights, heartbeats } from "../src/db/schema";
import { createApp } from "../src/app";
import { RedisBridge } from "../src/ws/redis-bridge";
import { mockGitHubAuth, resetDatabase, getCookie } from "./helpers";
import { getTeamActivityImpl, getSessionImpl } from "../src/chat/tools";
import { loadSessionCards } from "../src/chat/cards";
import { SUMMARY_ANALYZER } from "../src/analyzers/names";

let redis: RedisBridge;
let app: ReturnType<typeof createApp>;
let baseUrl: string;
let restoreFetch: () => void;

let aliceCookie: string;
let aliceId: number;
let bobId: number;
let commonRepoId: number;
let outsiderRepoId: number;

// UUIDs
const ALICE_SESSION = "b0000000-0000-0000-0000-000000000001";
const BOB_SESSION = "b0000000-0000-0000-0000-000000000002";
const OUTSIDER_SESSION = "b0000000-0000-0000-0000-000000000003";

beforeAll(async () => {
  restoreFetch = mockGitHubAuth();
  await resetDatabase();

  redis = new RedisBridge();
  await redis.connect();

  app = createApp(db, redis);
  app.listen(0);
  const port = app.server!.port;
  baseUrl = `http://localhost:${port}`;

  // Sign in Alice + Bob
  const aliceRes = await fetch(`${baseUrl}/auth/github/callback?code=alice_code`);
  aliceCookie = getCookie(aliceRes, "session")!;
  const bobRes = await fetch(`${baseUrl}/auth/github/callback?code=bob_code`);
  expect(getCookie(bobRes, "session")).toBeTruthy();

  const [alice] = await db.select().from(users).where(eq(users.githubLogin, "alice"));
  const [bob] = await db.select().from(users).where(eq(users.githubLogin, "bob"));
  aliceId = alice.id;
  bobId = bob.id;

  // Two repos — shared (alice+bob) and outsider (bob only)
  const [commonRepo] = await db
    .insert(repos)
    .values({
      githubId: 9001,
      fullName: "team/slashtalk",
      owner: "team",
      name: "slashtalk",
    })
    .returning();
  commonRepoId = commonRepo.id;

  const [outsiderRepo] = await db
    .insert(repos)
    .values({
      githubId: 9002,
      fullName: "other/secret",
      owner: "other",
      name: "secret",
    })
    .returning();
  outsiderRepoId = outsiderRepo.id;

  await db.insert(userRepos).values([
    { userId: aliceId, repoId: commonRepoId, permission: "push" },
    { userId: bobId, repoId: commonRepoId, permission: "push" },
    { userId: bobId, repoId: outsiderRepoId, permission: "push" },
  ]);

  const now = new Date();
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);

  await db.insert(sessions).values([
    {
      sessionId: ALICE_SESSION,
      userId: aliceId,
      source: "claude",
      project: "slashtalk",
      repoId: commonRepoId,
      firstTs: tenMinAgo,
      lastTs: fiveMinAgo,
      inTurn: true,
    },
    {
      sessionId: BOB_SESSION,
      userId: bobId,
      source: "claude",
      project: "slashtalk",
      repoId: commonRepoId,
      firstTs: tenMinAgo,
      lastTs: now,
      inTurn: false,
    },
    {
      sessionId: OUTSIDER_SESSION,
      userId: bobId,
      source: "claude",
      project: "secret",
      repoId: outsiderRepoId,
      firstTs: tenMinAgo,
      lastTs: now,
    },
  ]);

  await db.insert(sessionInsights).values([
    {
      sessionId: BOB_SESSION,
      analyzerName: SUMMARY_ANALYZER,
      analyzerVersion: 1,
      model: "claude-haiku-4-5-20251001",
      inputLineSeq: 0,
      output: {
        title: "Wiring WS reconnect",
        description: "Bob is working on the WebSocket reconnect logic",
      },
    },
  ]);

  // Fresh heartbeat for Bob → should classify as active
  await db.insert(heartbeats).values({
    sessionId: BOB_SESSION,
    userId: bobId,
    pid: 1234,
    kind: "claude-code",
    updatedAt: now,
  });
});

afterAll(async () => {
  restoreFetch();
  app.stop();
  await redis.disconnect();
});

describe("POST /api/chat/ask — request validation", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await fetch(`${baseUrl}/api/chat/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects empty messages array", async () => {
    const res = await fetch(`${baseUrl}/api/chat/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: aliceCookie },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("non-empty");
  });

  it("rejects when last message is not from user", async () => {
    const res = await fetch(`${baseUrl}/api/chat/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: aliceCookie },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello", citations: [] },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("role=user");
  });

  it("rejects oversized message content", async () => {
    const huge = "x".repeat(9000);
    const res = await fetch(`${baseUrl}/api/chat/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: aliceCookie },
      body: JSON.stringify({
        messages: [{ role: "user", content: huge }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects too many messages", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: "x",
    }));
    // ensure last is user
    many.push({ role: "user", content: "final" });
    const res = await fetch(`${baseUrl}/api/chat/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: aliceCookie },
      body: JSON.stringify({ messages: many }),
    });
    expect(res.status).toBe(400);
  });
});

describe("chat tool: get_team_activity", () => {
  it("returns empty for a user with no tracked repos", async () => {
    // Create an orphan user with no user_repos rows
    const [orphan] = await db
      .insert(users)
      .values({
        githubId: 9999,
        githubLogin: "orphan",
        githubToken: "aa:bb",
      })
      .returning();

    const result = await getTeamActivityImpl(db, orphan.id, {});
    expect(result.teammates).toEqual([]);
  });

  it("groups recent sessions by teammate", async () => {
    const result = await getTeamActivityImpl(db, aliceId, { sinceHours: 24 });
    const logins = result.teammates.map((t) => t.login).sort();
    expect(logins).toEqual(["alice", "bob"]);

    const bob = result.teammates.find((t) => t.login === "bob")!;
    expect(bob.isSelf).toBe(false);
    expect(bob.sessions).toHaveLength(1);
    expect(bob.sessions[0].id).toBe(BOB_SESSION);
    // Summary-analyzer output should win as the title
    expect(bob.sessions[0].title).toBe("Wiring WS reconnect");
    expect(bob.sessions[0].repo).toBe("team/slashtalk");

    const alice = result.teammates.find((t) => t.login === "alice")!;
    expect(alice.isSelf).toBe(true);
  });

  it("excludes sessions outside the caller's repo graph", async () => {
    const result = await getTeamActivityImpl(db, aliceId, { sinceHours: 24 });
    const allSessionIds = result.teammates.flatMap((t) => t.sessions.map((s) => s.id));
    expect(allSessionIds).not.toContain(OUTSIDER_SESSION);
  });

  it("honors state filter", async () => {
    const result = await getTeamActivityImpl(db, aliceId, {
      sinceHours: 24,
      state: "active",
    });
    // Only Bob's session has a fresh heartbeat
    const bob = result.teammates.find((t) => t.login === "bob");
    expect(bob?.sessions).toHaveLength(1);
    // Alice's session has no heartbeat → likely idle/recent, so filtered out
    const alice = result.teammates.find((t) => t.login === "alice");
    expect(alice).toBeUndefined();
  });

  it("scopes to a single teammate via login filter", async () => {
    const result = await getTeamActivityImpl(db, aliceId, {
      sinceHours: 24,
      login: "bob",
    });
    expect(result.teammates.map((t) => t.login)).toEqual(["bob"]);
    expect(result.teammates[0].sessions[0].id).toBe(BOB_SESSION);
  });

  it("returns empty when login filter names someone the caller can't see", async () => {
    const result = await getTeamActivityImpl(db, aliceId, {
      sinceHours: 24,
      login: "ghost-user-does-not-exist",
    });
    expect(result.teammates).toEqual([]);
  });

  it("scopes to a single repo via repoFullName filter", async () => {
    const result = await getTeamActivityImpl(db, aliceId, {
      sinceHours: 24,
      repoFullName: "team/slashtalk",
    });
    const sessionIds = result.teammates.flatMap((t) => t.sessions.map((s) => s.id));
    expect(sessionIds).toContain(BOB_SESSION);
    expect(sessionIds).not.toContain(OUTSIDER_SESSION);
  });

  it("returns empty when repoFullName filter names a repo the caller can't see", async () => {
    const result = await getTeamActivityImpl(db, aliceId, {
      sinceHours: 24,
      repoFullName: "other/secret",
    });
    expect(result.teammates).toEqual([]);
  });

  it("includes enriched payload fields (source, topFilesEdited, toolErrors, truncated lastUserPrompt)", async () => {
    const result = await getTeamActivityImpl(db, aliceId, { sinceHours: 24 });
    const bob = result.teammates.find((t) => t.login === "bob")!;
    const s = bob.sessions[0];
    expect(s.source).toBe("claude");
    expect(Array.isArray(s.topFilesEdited)).toBe(true);
    expect(typeof s.toolErrors).toBe("number");
    expect(s.lastUserPrompt === null || typeof s.lastUserPrompt === "string").toBe(true);
  });
});

describe("chat tool: get_session", () => {
  it("returns detail for a session in the caller's repo graph", async () => {
    const result = await getSessionImpl(db, aliceId, {
      sessionId: BOB_SESSION,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.session.id).toBe(BOB_SESSION);
    expect(result.session.repo).toBe("team/slashtalk");
    expect(result.session.user?.login).toBe("bob");
  });

  it("refuses sessions on repos the caller can't see", async () => {
    const result = await getSessionImpl(db, aliceId, {
      sessionId: OUTSIDER_SESSION,
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("not visible");
  });

  it("returns not-found for unknown session ID", async () => {
    const result = await getSessionImpl(db, aliceId, {
      sessionId: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("not found");
  });
});

describe("chat cards: loadSessionCards", () => {
  it("hydrates compact cards for visible sessions in input order", async () => {
    const cards = await loadSessionCards(db, aliceId, [BOB_SESSION, ALICE_SESSION]);
    expect(cards.map((c) => c.id)).toEqual([BOB_SESSION, ALICE_SESSION]);
    const bob = cards[0];
    expect(bob.user.login).toBe("bob");
    expect(bob.repo).toBe("team/slashtalk");
    expect(bob.title).toBe("Wiring WS reconnect");
    expect(bob.source).toBe("claude");
  });

  it("drops sessions outside the caller's repo graph", async () => {
    const cards = await loadSessionCards(db, aliceId, [BOB_SESSION, OUTSIDER_SESSION]);
    expect(cards.map((c) => c.id)).toEqual([BOB_SESSION]);
  });

  it("de-dupes repeated session IDs while preserving first-seen order", async () => {
    const cards = await loadSessionCards(db, aliceId, [
      BOB_SESSION,
      BOB_SESSION,
      ALICE_SESSION,
      BOB_SESSION,
    ]);
    expect(cards.map((c) => c.id)).toEqual([BOB_SESSION, ALICE_SESSION]);
  });

  it("silently skips unknown session IDs", async () => {
    const cards = await loadSessionCards(db, aliceId, [
      BOB_SESSION,
      "00000000-0000-0000-0000-000000000000",
    ]);
    expect(cards.map((c) => c.id)).toEqual([BOB_SESSION]);
  });

  it("returns empty for an empty or all-invisible input", async () => {
    expect(await loadSessionCards(db, aliceId, [])).toEqual([]);
    expect(await loadSessionCards(db, aliceId, [OUTSIDER_SESSION])).toEqual([]);
  });
});
