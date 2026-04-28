import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { createApp } from "../src/app";
import { RedisBridge } from "../src/ws/redis-bridge";
import { resetDatabase, mockGitHubAuth, getCookie, signInAs } from "./helpers";

let redis: RedisBridge;
let app: ReturnType<typeof createApp>;
let baseUrl: string;
let restoreFetch: () => void;
let aliceApiKey: string;
let bobApiKey: string;

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

  const bobRes = await signInAs(baseUrl, "bob_code");
  const bobCookie = getCookie(bobRes, "session")!;
  const bobSetupRes = await fetch(`${baseUrl}/api/me/setup-token`, {
    method: "POST",
    headers: { Cookie: bobCookie },
  });
  const { token: bobToken } = (await bobSetupRes.json()) as { token: string };
  const bobExchangeRes = await fetch(`${baseUrl}/v1/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: bobToken, deviceName: "bob-laptop", os: "darwin" }),
  });
  const { apiKey: bobKey } = (await bobExchangeRes.json()) as { apiKey: string };
  bobApiKey = bobKey;
});

afterAll(async () => {
  restoreFetch();
  app.stop();
  await redis.disconnect();
});

describe("managed-agent session ingest", () => {
  it("rejects missing and invalid API keys", async () => {
    const missing = await fetch(`${baseUrl}/v1/managed-agent-sessions`);
    expect(missing.status).toBe(401);

    const invalid = await fetch(`${baseUrl}/v1/managed-agent-sessions`, {
      headers: { Authorization: "Bearer not-a-real-key" },
    });
    expect(invalid.status).toBe(401);
  });

  it("upserts a team-visible agent session idempotently", async () => {
    const first = await fetch(`${baseUrl}/v1/managed-agent-sessions`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentId: "agent-1",
        sessionId: "session-1",
        mode: "cloud",
        visibility: "team",
        name: "first name",
        startedAt: "2026-04-25T10:00:00.000Z",
        lastActivity: "2026-04-25T10:01:00.000Z",
      }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${baseUrl}/v1/managed-agent-sessions`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentId: "agent-1",
        sessionId: "session-1",
        mode: "cloud",
        visibility: "team",
        startedAt: "2026-04-25T10:00:00.000Z",
        lastActivity: "2026-04-25T10:02:00.000Z",
        endedAt: "2026-04-25T10:03:00.000Z",
        summary: "done",
        summaryModel: "claude-haiku-4-5-20251001",
        summaryTs: "2026-04-25T10:04:00.000Z",
      }),
    });
    expect(second.status).toBe(200);

    const rows = await db.execute(sql`
      select user_login, agent_id, session_id, visibility, name, summary
      from agent_sessions
      where session_id = 'session-1'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      user_login: "alice",
      agent_id: "agent-1",
      session_id: "session-1",
      visibility: "team",
      name: "first name",
      summary: "done",
    });
  });

  it("scopes session id conflicts by user", async () => {
    const payload = {
      agentId: "agent-collision",
      sessionId: "shared-session-id",
      mode: "cloud",
      visibility: "team",
      startedAt: "2026-04-25T12:00:00.000Z",
      lastActivity: "2026-04-25T12:01:00.000Z",
    };
    const alice = await fetch(`${baseUrl}/v1/managed-agent-sessions`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...payload, name: "alice session" }),
    });
    expect(alice.status).toBe(200);

    const bob = await fetch(`${baseUrl}/v1/managed-agent-sessions`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${bobApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...payload, name: "bob session" }),
    });
    expect(bob.status).toBe(200);

    const rows = await db.execute(sql`
      select user_login, session_id, name
      from agent_sessions
      where session_id = 'shared-session-id'
      order by user_login
    `);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.user_login)).toEqual(["alice", "bob"]);
    expect(rows.map((row) => row.name)).toEqual(["alice session", "bob session"]);
  });

  it("lists only the caller's team-visible rows by default and filters by agent", async () => {
    await fetch(`${baseUrl}/v1/managed-agent-sessions`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentId: "agent-list",
        sessionId: "list-session",
        mode: "cloud",
        visibility: "team",
        startedAt: "2026-04-25T10:00:00.000Z",
      }),
    });
    await fetch(`${baseUrl}/v1/managed-agent-sessions`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentId: "agent-private",
        sessionId: "private-session",
        mode: "local",
        visibility: "private",
        startedAt: "2026-04-25T11:00:00.000Z",
      }),
    });

    const list = await fetch(`${baseUrl}/v1/managed-agent-sessions`, {
      headers: { Authorization: `Bearer ${aliceApiKey}` },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { sessions: Array<{ sessionId: string }> };
    expect(body.sessions.map((s) => s.sessionId)).toContain("list-session");
    expect(body.sessions.map((s) => s.sessionId)).not.toContain("private-session");

    const filtered = await fetch(`${baseUrl}/v1/managed-agent-sessions?agentId=agent-private`, {
      headers: { Authorization: `Bearer ${aliceApiKey}` },
    });
    const filteredBody = (await filtered.json()) as { sessions: unknown[] };
    expect(filteredBody.sessions).toEqual([]);
  });

  it("rejects invalid mode values", async () => {
    const res = await fetch(`${baseUrl}/v1/managed-agent-sessions`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentId: "agent-bad-mode",
        sessionId: "bad-mode-session",
        mode: "remote",
        visibility: "team",
        startedAt: "2026-04-25T11:00:00.000Z",
      }),
    });
    expect(res.status).not.toBe(200);
  });

  it("does not allow cross-user list reads", async () => {
    const bobPut = await fetch(`${baseUrl}/v1/managed-agent-sessions`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${bobApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentId: "agent-bob",
        sessionId: "bob-team-session",
        mode: "cloud",
        visibility: "team",
        startedAt: "2026-04-25T11:30:00.000Z",
      }),
    });
    expect(bobPut.status).toBe(200);

    const list = await fetch(`${baseUrl}/v1/managed-agent-sessions?userLogin=bob`, {
      headers: { Authorization: `Bearer ${aliceApiKey}` },
    });
    expect(list.status).toBe(403);
  });
});
