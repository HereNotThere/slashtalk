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
  it("rejects missing and invalid bearer headers with OAuth discovery metadata", async () => {
    const missing = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initializeRequest()),
    });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
    );

    const invalid = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer bad-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(initializeRequest()),
    });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
    );
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

describe("MCP OAuth discovery", () => {
  it("serves protected-resource metadata for root /mcp", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
      bearer_methods_supported: string[];
    };
    expect(body.resource).toBe(`${baseUrl}/mcp`);
    expect(body.authorization_servers).toEqual([baseUrl]);
    expect(body.scopes_supported).toEqual(["mcp:read", "mcp:write"]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp",
    "/mcp/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
    "/.well-known/openid-configuration/mcp",
    "/mcp/.well-known/openid-configuration",
  ]) {
    it(`serves authorization-server metadata at ${path}`, async () => {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        issuer: string;
        authorization_endpoint: string;
        token_endpoint: string;
        registration_endpoint: string;
        code_challenge_methods_supported: string[];
        token_endpoint_auth_methods_supported: string[];
        scopes_supported: string[];
        protected_resources: string[];
      };
      expect(body.issuer).toBe(baseUrl);
      expect(body.authorization_endpoint).toBe(`${baseUrl}/oauth/authorize`);
      expect(body.token_endpoint).toBe(`${baseUrl}/oauth/token`);
      expect(body.registration_endpoint).toBe(`${baseUrl}/oauth/register`);
      expect(body.code_challenge_methods_supported).toEqual(["S256"]);
      expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
      expect(body.scopes_supported).toEqual([
        "mcp:read",
        "mcp:write",
        "offline_access",
      ]);
      expect(body.protected_resources).toEqual([`${baseUrl}/mcp`]);
    });
  }

  it("registers dynamic public OAuth clients", async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Codex",
        redirect_uris: ["http://127.0.0.1:56466/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "mcp:read mcp:write",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      client_id: string;
      client_id_issued_at: number;
      client_name: string;
      redirect_uris: string[];
      grant_types: string[];
      response_types: string[];
      token_endpoint_auth_method: string;
      scope: string;
    };
    expect(body.client_id).toStartWith("dyn_");
    expect(body.client_id_issued_at).toBeGreaterThan(0);
    expect(body.client_name).toBe("Codex");
    expect(body.redirect_uris).toEqual(["http://127.0.0.1:56466/callback"]);
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(body.response_types).toEqual(["code"]);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.scope).toBe("mcp:read mcp:write");
  });

  it("rejects invalid dynamic client registration requests", async () => {
    const secretClient = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Bad",
        redirect_uris: ["http://127.0.0.1:56466/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    });
    expect(secretClient.status).toBe(400);

    const badRedirect = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Bad",
        redirect_uris: ["https://evil.example/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(badRedirect.status).toBe(400);
  });

  it("accepts known static clients and rejects unknown static clients at authorize", async () => {
    const known = await fetch(
      `${baseUrl}/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: "slashtalk-static-claude-code",
        redirect_uri: "http://localhost:37622/callback",
        code_challenge: "abc",
        code_challenge_method: "S256",
      })}`,
      { redirect: "manual" },
    );
    expect(known.status).toBe(302);
    expect(known.headers.get("location")).toStartWith(
      "http://localhost:37622/callback?code=",
    );

    const unknown = await fetch(
      `${baseUrl}/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: "unknown-client",
        redirect_uri: "http://localhost:37622/callback",
        code_challenge: "abc",
        code_challenge_method: "S256",
      })}`,
      { redirect: "manual" },
    );
    expect(unknown.status).toBe(400);
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
