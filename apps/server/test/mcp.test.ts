import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { db } from "../src/db";
import { RedisBridge } from "../src/ws/redis-bridge";
import { resetDatabase, mockGitHubAuth, getCookie } from "./helpers";

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

  const aliceRes = await fetch(`${baseUrl}/auth/github/callback?code=alice_code`);
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

  const bobRes = await fetch(`${baseUrl}/auth/github/callback?code=bob_code`);
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

describe("root /mcp", () => {
  it("rejects missing and invalid bearer headers", async () => {
    const missing = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initializeRequest()),
    });
    expect(missing.status).toBe(401);

    const invalid = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer bad-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(initializeRequest()),
    });
    expect(invalid.status).toBe(401);
  });

  it("accepts initialize with a valid device API key and returns an MCP session id", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initializeRequest()),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
    const body = await res.text();
    expect(body).toContain("slashtalk");
  });

  it("reuses known sessions and rejects unknown session ids", async () => {
    const init = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initializeRequest()),
    });
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const listTools = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(listTools.status).toBe(200);
    const listToolsBody = await listTools.text();
    expect(listToolsBody).not.toContain("share_workspace");

    const stale = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": crypto.randomUUID(),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    expect(stale.status).toBe(404);
  });

  it("does not let another user reuse an existing MCP session id", async () => {
    const init = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initializeRequest()),
    });
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const crossUser = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bobApiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
    });
    expect(crossUser.status).toBe(404);
  });
});

function initializeRequest() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "server-test", version: "0.0.0" },
    },
  };
}
