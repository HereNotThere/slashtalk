import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import type { IngestResponse, SyncStateEntry } from "@slashtalk/shared";
import { db } from "../src/db";
import {
  users,
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

const ENC_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  restoreFetch = mockGitHubAuth();
  await resetDatabase();

  redis = new RedisBridge();
  await redis.connect();

  app = createApp(db, redis);
  app.listen(0);
  baseUrl = `http://localhost:${app.server!.port}`;

  // Bootstrap a user with an API key for ingest tests
  const loginRes = await fetch(
    `${baseUrl}/auth/github/callback?code=alice_code`
  );
  aliceCookie = getCookie(loginRes, "session")!;
  const [alice] = await db
    .select()
    .from(users)
    .where(eq(users.githubLogin, "alice"));
  aliceUserId = alice.id;

  const setupRes = await fetch(`${baseUrl}/api/me/setup-token`, {
    method: "POST",
    headers: { Cookie: aliceCookie },
  });
  const { token: setupToken } = (await setupRes.json()) as {
    token: string;
  };

  const exchangeRes = await fetch(`${baseUrl}/auth/exchange`, {
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
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
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

    const res = await fetch(`${baseUrl}/auth/exchange`, {
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

    const res = await fetch(`${baseUrl}/auth/exchange`, {
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
      }
    );
    expect(res.status).toBe(200);

    const data = (await res.json()) as IngestResponse;
    expect(data.acceptedEvents).toBe(3);
    expect(data.duplicateEvents).toBe(0);
    expect(data.serverLineSeq).toBe(3);
  });

  it("deduplicates events on re-ingest from the same line seq", async () => {
    const eventUuid = "c0000000-0000-0000-0000-000000000099";
    const events = [
      makeEvent({ uuid: eventUuid, sessionId: SESSION_ID, type: "user" }),
    ];

    await fetch(
      `${baseUrl}/v1/ingest?project=upload-test&session=${SESSION_ID}&fromLineSeq=100`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          Authorization: `Bearer ${aliceApiKey}`,
        },
        body: makeNdjson(events),
      }
    );

    const res = await fetch(
      `${baseUrl}/v1/ingest?project=upload-test&session=${SESSION_ID}&fromLineSeq=100`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          Authorization: `Bearer ${aliceApiKey}`,
        },
        body: makeNdjson(events),
      }
    );
    const data = (await res.json()) as IngestResponse;
    expect(data.acceptedEvents).toBe(0);
    expect(data.duplicateEvents).toBe(1);
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

    const [hb] = await db
      .select()
      .from(heartbeats)
      .where(eq(heartbeats.sessionId, HB_SESSION_ID));
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

    const [hb] = await db
      .select()
      .from(heartbeats)
      .where(eq(heartbeats.sessionId, HB_SESSION_ID));
    expect(hb.pid).toBe(99999);
    expect(hb.kind).toBe("background");
  });
});
