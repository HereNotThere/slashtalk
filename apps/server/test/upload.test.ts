import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import type { IngestResponse, SyncStateEntry } from "@slashtalk/shared";
import { db } from "../src/db";
import {
  users,
  repos,
  userRepos,
  deviceRepoPaths,
  sessions,
  setupTokens,
  heartbeats,
} from "../src/db/schema";
import { createApp } from "../src/app";
import { RedisBridge } from "../src/ws/redis-bridge";
import {
  generateApiKey,
  hashToken,
  encryptGithubToken,
  decryptGithubToken,
} from "../src/auth/tokens";
import { classifySessionState } from "../src/sessions/state";
import {
  resetDatabase,
  mockGitHubAuth,
  getCookie,
  makeEvent,
  makeNdjson,
  signInAs,
} from "./helpers";

let redis: RedisBridge;
let app: ReturnType<typeof createApp>;
let baseUrl: string;
let restoreFetch: () => void;

// Test-scoped state
let aliceCookie: string;
let aliceApiKey: string;
let aliceUserId: number;
let aliceDeviceId: number;

const ENC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  restoreFetch = mockGitHubAuth();
  await resetDatabase();

  redis = new RedisBridge();
  await redis.connect();

  app = createApp(db, redis);
  app.listen(0);
  baseUrl = `http://localhost:${app.server!.port}`;

  // Bootstrap a user with an API key for ingest tests
  const loginRes = await signInAs(baseUrl, "alice_code");
  aliceCookie = getCookie(loginRes, "session")!;
  const [alice] = await db.select().from(users).where(eq(users.githubLogin, "alice"));
  aliceUserId = alice.id;

  const setupRes = await fetch(`${baseUrl}/api/me/setup-token`, {
    method: "POST",
    headers: { Cookie: aliceCookie },
  });
  const { token: setupToken } = (await setupRes.json()) as {
    token: string;
  };

  const exchangeRes = await fetch(`${baseUrl}/v1/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: setupToken,
      deviceName: "test-device",
      os: "darwin",
    }),
  });
  const exchangeData = (await exchangeRes.json()) as {
    apiKey: string;
    deviceId: number;
  };
  aliceApiKey = exchangeData.apiKey;
  aliceDeviceId = exchangeData.deviceId;
});

afterAll(async () => {
  restoreFetch();
  app.stop();
  await redis.disconnect();
});

// ── Token Utilities ──────────────────────────────────────────

describe("token utilities", () => {
  it("generateApiKey returns UUID format", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("hashToken produces deterministic 64-char hex", async () => {
    const hash1 = await hashToken("test-token-abc");
    const hash2 = await hashToken("test-token-abc");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashToken produces different output for different inputs", async () => {
    const hash1 = await hashToken("token-a");
    const hash2 = await hashToken("token-b");
    expect(hash1).not.toBe(hash2);
  });

  it("encrypt/decrypt round-trips a GitHub token", async () => {
    const original = "ghp_abc123secretToken";
    const encrypted = await encryptGithubToken(original, ENC_KEY);
    expect(encrypted).toContain(":"); // iv:ciphertext format
    expect(encrypted).not.toContain(original);

    const decrypted = await decryptGithubToken(encrypted, ENC_KEY);
    expect(decrypted).toBe(original);
  });
});

// ── Session State Classification ─────────────────────────────

describe("session state classification", () => {
  const now = new Date("2026-04-22T12:00:00Z");

  it("returns BUSY when heartbeat fresh and in_turn", () => {
    const state = classifySessionState({
      heartbeatUpdatedAt: new Date("2026-04-22T11:59:45Z"), // 15s ago
      inTurn: true,
      lastTs: new Date("2026-04-22T11:59:50Z"),
      now,
    });
    expect(state).toBe("busy");
  });

  it("returns ACTIVE when heartbeat fresh, not in_turn, recent event", () => {
    const state = classifySessionState({
      heartbeatUpdatedAt: new Date("2026-04-22T11:59:45Z"), // 15s ago
      inTurn: false,
      lastTs: new Date("2026-04-22T11:59:55Z"), // 5s ago
      now,
    });
    expect(state).toBe("active");
  });

  it("returns IDLE when heartbeat fresh but no recent event", () => {
    const state = classifySessionState({
      heartbeatUpdatedAt: new Date("2026-04-22T11:59:45Z"), // 15s ago
      inTurn: false,
      lastTs: new Date("2026-04-22T11:58:00Z"), // 2min ago
      now,
    });
    expect(state).toBe("idle");
  });

  it("returns RECENT when heartbeat stale but last event within 1h", () => {
    const state = classifySessionState({
      heartbeatUpdatedAt: new Date("2026-04-22T11:00:00Z"), // 1h ago
      inTurn: false,
      lastTs: new Date("2026-04-22T11:30:00Z"), // 30min ago
      now,
    });
    expect(state).toBe("recent");
  });

  it("returns ENDED when heartbeat stale and old event", () => {
    const state = classifySessionState({
      heartbeatUpdatedAt: new Date("2026-04-22T08:00:00Z"), // 4h ago
      inTurn: false,
      lastTs: new Date("2026-04-22T08:00:00Z"), // 4h ago
      now,
    });
    expect(state).toBe("ended");
  });

  it("returns ENDED when no heartbeat and no lastTs", () => {
    const state = classifySessionState({
      heartbeatUpdatedAt: null,
      inTurn: false,
      lastTs: null,
      now,
    });
    expect(state).toBe("ended");
  });
});

// ── Setup Token Exchange ─────────────────────────────────────

describe("setup token exchange", () => {
  it("rejects expired setup token", async () => {
    // Insert an expired token directly
    await db.insert(setupTokens).values({
      userId: aliceUserId,
      token: "expired-token-test",
      expiresAt: new Date(Date.now() - 60_000), // 1 min ago
      redeemed: false,
    });

    const res = await fetch(`${baseUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "expired-token-test",
        deviceName: "expired-device",
      }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("expired");
  });

  it("rejects already-redeemed setup token", async () => {
    await db.insert(setupTokens).values({
      userId: aliceUserId,
      token: "redeemed-token-test",
      expiresAt: new Date(Date.now() + 600_000),
      redeemed: true,
    });

    const res = await fetch(`${baseUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "redeemed-token-test",
        deviceName: "redeemed-device",
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ── NDJSON Ingest ────────────────────────────────────────────

describe("NDJSON ingest", () => {
  const SESSION_ID = "b0000000-0000-0000-0000-000000000001";

  // Pre-create session for ingest
  beforeAll(async () => {
    await db.insert(sessions).values({
      sessionId: SESSION_ID,
      userId: aliceUserId,
      deviceId: aliceDeviceId,
      source: "claude",
      project: "upload-test",
    });
  });

  it("ingests NDJSON events and returns correct counts", async () => {
    const events = [
      makeEvent({ sessionId: SESSION_ID, type: "user" }),
      makeEvent({ sessionId: SESSION_ID, type: "assistant" }),
      makeEvent({ sessionId: SESSION_ID, type: "user" }),
    ];

    const res = await fetch(
      `${baseUrl}/v1/ingest?project=upload-test&session=${SESSION_ID}&fromLineSeq=0`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          Authorization: `Bearer ${aliceApiKey}`,
        },
        body: makeNdjson(events),
      },
    );
    expect(res.status).toBe(200);

    const data = (await res.json()) as IngestResponse;
    expect(data.acceptedEvents).toBe(3);
    expect(data.duplicateEvents).toBe(0);
    expect(data.serverLineSeq).toBe(3);
  });

  it("deduplicates events on re-ingest from the same line seq", async () => {
    const eventUuid = "c0000000-0000-0000-0000-000000000099";
    const events = [makeEvent({ uuid: eventUuid, sessionId: SESSION_ID, type: "user" })];

    await fetch(`${baseUrl}/v1/ingest?project=upload-test&session=${SESSION_ID}&fromLineSeq=100`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-ndjson",
        Authorization: `Bearer ${aliceApiKey}`,
      },
      body: makeNdjson(events),
    });

    const res = await fetch(
      `${baseUrl}/v1/ingest?project=upload-test&session=${SESSION_ID}&fromLineSeq=100`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          Authorization: `Bearer ${aliceApiKey}`,
        },
        body: makeNdjson(events),
      },
    );
    const data = (await res.json()) as IngestResponse;
    expect(data.acceptedEvents).toBe(0);
    expect(data.duplicateEvents).toBe(1);
  });

  it("aggregates Codex sessions into the existing snapshot shape", async () => {
    const [repo] = await db
      .insert(repos)
      .values({
        githubId: 3011,
        fullName: "shared-org/slashtalk",
        owner: "shared-org",
        name: "slashtalk",
      })
      .returning();

    await db.insert(userRepos).values({
      userId: aliceUserId,
      repoId: repo.id,
      permission: "push",
    });

    const repoRoot = "/Users/alice/work/slashtalk";
    await db.insert(deviceRepoPaths).values({
      deviceId: aliceDeviceId,
      repoId: repo.id,
      localPath: repoRoot,
    });

    const sessionId = "019dbb09-1397-78e1-aaa2-45a904cd7c13";
    const turnId = "019dbb0a-a118-76d3-8a89-90061518a673";
    const cwd = `${repoRoot}/apps/server`;
    const filePath = `${cwd}/src/ingest/routes.ts`;

    const codexEvents = [
      {
        timestamp: "2026-04-23T15:52:09.302Z",
        type: "session_meta",
        payload: {
          id: sessionId,
          timestamp: "2026-04-23T15:50:27.485Z",
          cwd,
          cli_version: "0.122.0",
          model_provider: "openai",
        },
      },
      {
        timestamp: "2026-04-23T15:52:09.302Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: turnId,
          started_at: 1776959529,
        },
      },
      {
        timestamp: "2026-04-23T15:52:09.302Z",
        type: "turn_context",
        payload: {
          turn_id: turnId,
          cwd,
          model: "gpt-5.4",
          approval_policy: "on-request",
        },
      },
      {
        timestamp: "2026-04-23T15:52:09.303Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Please add Codex session upload support to the existing session pipeline.",
        },
      },
      {
        timestamp: "2026-04-23T15:52:15.759Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: "sed -n '1,260p' apps/server/src/ingest/routes.ts",
            workdir: cwd,
          }),
          call_id: "call_33C86MJossOpYI3KWDTxTJeB",
        },
      },
      {
        timestamp: "2026-04-23T15:52:28.480Z",
        type: "event_msg",
        payload: {
          type: "exec_command_end",
          call_id: "call_33C86MJossOpYI3KWDTxTJeB",
          turn_id: turnId,
          cwd,
          exit_code: 0,
          parsed_cmd: [{ type: "read", path: filePath }],
        },
      },
      {
        timestamp: "2026-04-23T15:52:28.889Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "I’m wiring Codex into the existing ingest pipeline.",
        },
      },
      {
        timestamp: "2026-04-23T15:53:03.729Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 42378,
              cached_input_tokens: 34688,
              output_tokens: 231,
              reasoning_output_tokens: 25,
            },
          },
        },
      },
      {
        timestamp: "2026-04-23T15:55:40.691Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: turnId,
          completed_at: 1776959740,
        },
      },
    ];

    const res = await fetch(
      `${baseUrl}/v1/ingest?project=${encodeURIComponent(
        "-Users-alice-work-slashtalk-apps-server",
      )}&session=${sessionId}&fromLineSeq=0&source=codex`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          Authorization: `Bearer ${aliceApiKey}`,
        },
        body: makeNdjson(codexEvents),
      },
    );
    expect(res.status).toBe(200);

    const [session] = await db.select().from(sessions).where(eq(sessions.sessionId, sessionId));

    expect(session.source).toBe("codex");
    expect(session.provider).toBe("openai");
    expect(session.repoId).toBe(repo.id);
    expect(session.cwd).toBe(cwd);
    expect(session.version).toBe("0.122.0");
    expect(session.model).toBe("gpt-5.4");
    expect(session.userMsgs).toBe(1);
    expect(session.assistantMsgs).toBe(1);
    expect(session.toolCalls).toBe(1);
    expect(session.toolErrors).toBe(0);
    expect(session.tokensIn).toBe(42378);
    expect(session.tokensCacheRead).toBe(34688);
    expect(session.tokensOut).toBe(231);
    expect(session.tokensReasoning).toBe(25);
    expect(session.title).toContain("Please add Codex session upload support");
    expect(session.lastUserPrompt).toContain("Codex session upload support");
    expect(session.inTurn).toBe(false);
    expect(session.currentTurnId).toBeNull();
    expect(session.topFilesRead).toEqual({ [filePath]: 1 });
    expect(session.events).toBe(codexEvents.length);
  });

  it("aggregates Cursor transcript sessions into the existing snapshot shape", async () => {
    const [repo] = await db
      .insert(repos)
      .values({
        githubId: 3012,
        fullName: "shared-org/slashtalk-cursor",
        owner: "shared-org",
        name: "slashtalk-cursor",
      })
      .returning();

    await db.insert(userRepos).values({
      userId: aliceUserId,
      repoId: repo.id,
      permission: "push",
    });

    const repoRoot = "/Users/alice/work/slashtalk-cursor";
    await db.insert(deviceRepoPaths).values({
      deviceId: aliceDeviceId,
      repoId: repo.id,
      localPath: repoRoot,
    });

    const sessionId = "2d3e7a61-aab3-4295-b17e-1c4154ec29db";
    const cwd = `${repoRoot}/apps/desktop`;
    const readPath = `${repoRoot}/package.json`;
    const editPath = `${cwd}/src/main/uploader.ts`;

    const cursorEvents = [
      {
        timestamp: "2026-04-24T06:20:00Z",
        role: "user",
        cwd,
        message: {
          content: [
            {
              type: "text",
              text: "<user_query>\nadd Cursor transcript upload support\n</user_query>",
            },
          ],
        },
      },
      {
        timestamp: "2026-04-24T06:20:03Z",
        role: "assistant",
        cwd,
        message: {
          content: [
            { type: "text", text: "Checking the existing uploader." },
            { type: "tool_use", name: "Read", input: { path: readPath } },
          ],
        },
      },
      {
        timestamp: "2026-04-24T06:20:05Z",
        role: "assistant",
        cwd,
        message: {
          content: [
            { type: "text", text: "Applying the first patch." },
            { type: "tool_use", name: "StrReplace", input: { path: editPath } },
          ],
        },
      },
      {
        timestamp: "2026-04-24T06:20:10Z",
        role: "assistant",
        cwd,
        message: {
          content: [{ type: "text", text: "Cursor ingest plumbing is in place." }],
        },
      },
    ];

    const res = await fetch(
      `${baseUrl}/v1/ingest?project=${encodeURIComponent(
        "-Users-alice-work-slashtalk-cursor-apps-desktop",
      )}&session=${sessionId}&fromLineSeq=0&source=cursor`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          Authorization: `Bearer ${aliceApiKey}`,
        },
        body: makeNdjson(cursorEvents),
      },
    );
    expect(res.status).toBe(200);

    const [session] = await db.select().from(sessions).where(eq(sessions.sessionId, sessionId));

    expect(session.source).toBe("cursor");
    expect(session.provider).toBeNull();
    expect(session.repoId).toBe(repo.id);
    expect(session.cwd).toBe(cwd);
    expect(session.userMsgs).toBe(1);
    expect(session.assistantMsgs).toBe(3);
    expect(session.toolCalls).toBe(2);
    expect(session.toolErrors).toBe(0);
    expect(session.title).toContain("add Cursor transcript upload support");
    expect(session.lastUserPrompt).toContain("Cursor transcript upload support");
    expect(session.topFilesRead).toEqual({ [readPath]: 1 });
    expect(session.topFilesEdited).toEqual({ [editPath]: 1 });
    expect(session.events).toBe(cursorEvents.length);
  });
});

describe("ingest authorization", () => {
  it("rejects ingest for a session owned by another user", async () => {
    const bobRes = await signInAs(baseUrl, "bob_code");
    const bobCookie = getCookie(bobRes, "session")!;

    const setupRes = await fetch(`${baseUrl}/api/me/setup-token`, {
      method: "POST",
      headers: { Cookie: bobCookie },
    });
    const { token: bobSetupToken } = (await setupRes.json()) as { token: string };

    const exchangeRes = await fetch(`${baseUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: bobSetupToken, deviceName: "bob-device", os: "darwin" }),
    });
    const { apiKey: bobApiKey } = (await exchangeRes.json()) as { apiKey: string };

    // Alice's session from earlier (created in NDJSON ingest beforeAll).
    const aliceSessionId = "b0000000-0000-0000-0000-000000000001";

    const res = await fetch(
      `${baseUrl}/v1/ingest?project=other&session=${aliceSessionId}&fromLineSeq=999`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          Authorization: `Bearer ${bobApiKey}`,
        },
        body: makeNdjson([makeEvent({ sessionId: aliceSessionId })]),
      },
    );
    expect(res.status).toBe(403);

    // No event row should have been written under Bob's userId.
    const stray = await db
      .select()
      .from(sessions)
      .where(eq(sessions.sessionId, aliceSessionId));
    expect(stray).toHaveLength(1);
    expect(stray[0].userId).toBe(aliceUserId);
  });
});

describe("ingest body size cap", () => {
  it("returns 413 line_too_large when a single line exceeds the per-line cap", async () => {
    const SESSION_ID = "b0000000-0000-0000-0000-0000000000fe";
    await db.insert(sessions).values({
      sessionId: SESSION_ID,
      userId: aliceUserId,
      deviceId: aliceDeviceId,
      source: "claude",
      project: "line-cap",
    });

    // 1.1 MB of newline-free chars — under the 50 MB total cap, over the
    // 1 MB per-line cap. This exercises the same cap-and-cancel code path as
    // the total-bytes guard; testing the smaller cap keeps the test fast and
    // keeps memory pressure off CI.
    const huge = "x".repeat(1_100_000);
    const res = await fetch(
      `${baseUrl}/v1/ingest?project=line-cap&session=${SESSION_ID}&fromLineSeq=0`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          Authorization: `Bearer ${aliceApiKey}`,
        },
        body: huge,
      },
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("line_too_large");
  });
});

// ── Sync State ───────────────────────────────────────────────

describe("sync state", () => {
  it("returns server line seq after ingest", async () => {
    const res = await fetch(`${baseUrl}/v1/sync-state`, {
      headers: { Authorization: `Bearer ${aliceApiKey}` },
    });
    expect(res.status).toBe(200);
    const state = (await res.json()) as Record<string, SyncStateEntry>;

    // Should have the session from the ingest tests
    const sessionId = "b0000000-0000-0000-0000-000000000001";
    expect(state[sessionId]).toBeTruthy();
    expect(state[sessionId].serverLineSeq).toBeGreaterThan(0);
  });
});

describe("device repo registration", () => {
  it("rematches owner-only sessions when repo paths are registered", async () => {
    const [repo] = await db
      .insert(repos)
      .values({
        githubId: 3001,
        fullName: "shared-org/platform",
        owner: "shared-org",
        name: "platform",
      })
      .returning();

    await db.insert(userRepos).values({
      userId: aliceUserId,
      repoId: repo.id,
      permission: "push",
    });

    const sessionId = "a0000000-0000-0000-0000-0000000000aa";
    const repoRoot = "/Users/alice/work/client-monorepo";
    const cwd = `${repoRoot}/apps/web`;
    const project = "-Users-alice-work-client-monorepo-apps-web";

    const ingestRes = await fetch(
      `${baseUrl}/v1/ingest?project=${project}&session=${sessionId}&fromLineSeq=0`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          Authorization: `Bearer ${aliceApiKey}`,
        },
        body: makeNdjson([
          {
            ...makeEvent({
              sessionId,
              timestamp: new Date().toISOString(),
            }),
            cwd,
          },
        ]),
      },
    );
    expect(ingestRes.status).toBe(200);

    let [session] = await db.select().from(sessions).where(eq(sessions.sessionId, sessionId));
    expect(session.repoId).toBeNull();

    const registerRes = await fetch(`${baseUrl}/v1/devices/${aliceDeviceId}/repos`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repoPaths: [{ repoFullName: "shared-org/platform", localPath: repoRoot }],
      }),
    });
    expect(registerRes.status).toBe(200);

    [session] = await db.select().from(sessions).where(eq(sessions.sessionId, sessionId));
    expect(session.repoId).toBe(repo.id);
  });
});

// ── Heartbeat ────────────────────────────────────────────────

describe("heartbeat", () => {
  const HB_SESSION_ID = "d0000000-0000-0000-0000-000000000001";

  beforeAll(async () => {
    await db.insert(sessions).values({
      sessionId: HB_SESSION_ID,
      userId: aliceUserId,
      deviceId: aliceDeviceId,
      source: "claude",
      project: "heartbeat-test",
    });
  });

  it("creates a heartbeat for a session", async () => {
    const res = await fetch(`${baseUrl}/v1/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aliceApiKey}`,
      },
      body: JSON.stringify({
        sessionId: HB_SESSION_ID,
        pid: 12345,
        kind: "interactive",
      }),
    });
    expect(res.status).toBe(200);

    const [hb] = await db.select().from(heartbeats).where(eq(heartbeats.sessionId, HB_SESSION_ID));
    expect(hb).toBeTruthy();
    expect(hb.pid).toBe(12345);
    expect(hb.kind).toBe("interactive");
  });

  it("updates an existing heartbeat", async () => {
    const res = await fetch(`${baseUrl}/v1/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aliceApiKey}`,
      },
      body: JSON.stringify({
        sessionId: HB_SESSION_ID,
        pid: 99999,
        kind: "background",
      }),
    });
    expect(res.status).toBe(200);

    const [hb] = await db.select().from(heartbeats).where(eq(heartbeats.sessionId, HB_SESSION_ID));
    expect(hb.pid).toBe(99999);
    expect(hb.kind).toBe("background");
  });

  it("rejects a heartbeat for a session owned by another user", async () => {
    const bobRes = await signInAs(baseUrl, "bob_code");
    const bobCookie = getCookie(bobRes, "session")!;
    const setupRes = await fetch(`${baseUrl}/api/me/setup-token`, {
      method: "POST",
      headers: { Cookie: bobCookie },
    });
    const { token: bobSetupToken } = (await setupRes.json()) as { token: string };
    const exchangeRes = await fetch(`${baseUrl}/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: bobSetupToken, deviceName: "bob-hb-device", os: "darwin" }),
    });
    const { apiKey: bobApiKey } = (await exchangeRes.json()) as { apiKey: string };

    const before = await db
      .select()
      .from(heartbeats)
      .where(eq(heartbeats.sessionId, HB_SESSION_ID));
    expect(before).toHaveLength(1);
    const beforePid = before[0].pid;

    const res = await fetch(`${baseUrl}/v1/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bobApiKey}`,
      },
      body: JSON.stringify({ sessionId: HB_SESSION_ID, pid: 13, kind: "interactive" }),
    });
    expect(res.status).toBe(404);

    const after = await db
      .select()
      .from(heartbeats)
      .where(eq(heartbeats.sessionId, HB_SESSION_ID));
    expect(after).toHaveLength(1);
    expect(after[0].pid).toBe(beforePid);
    expect(after[0].userId).toBe(aliceUserId);
  });

  it("returns 404 for a heartbeat against a non-existent session", async () => {
    const res = await fetch(`${baseUrl}/v1/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aliceApiKey}`,
      },
      body: JSON.stringify({
        sessionId: "00000000-0000-0000-0000-000000000999",
        pid: 1,
        kind: "interactive",
      }),
    });
    expect(res.status).toBe(404);
  });
});
