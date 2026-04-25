import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { db } from "../src/db";
import { oauthAuthorizationCodes, oauthTokens } from "../src/db/schema";
import { hashToken } from "../src/auth/tokens";
import { RedisBridge } from "../src/ws/redis-bridge";
import { resetDatabase, mockGitHubAuth, getCookie } from "./helpers";

let redis: RedisBridge;
let app: ReturnType<typeof createApp>;
let baseUrl: string;
let restoreFetch: () => void;
let aliceApiKey: string;
let bobApiKey: string;
let aliceCookie: string;

beforeAll(async () => {
  restoreFetch = mockGitHubAuth();
  await resetDatabase();

  redis = new RedisBridge();
  await redis.connect();

  app = createApp(db, redis);
  app.listen(0);
  baseUrl = `http://localhost:${app.server!.port}`;

  const aliceRes = await fetch(`${baseUrl}/auth/github/callback?code=alice_code`);
  aliceCookie = getCookie(aliceRes, "session")!;

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
    expect(invalid.headers.get("www-authenticate")).toContain(
      `resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
    );
    expect(invalid.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
    expect(invalid.headers.get("www-authenticate")).toContain(
      'error_description="unknown token"',
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

  it("accepts initialize with a valid MCP OAuth access token", async () => {
    const { accessToken } = await issueMcpOAuthToken();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
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

  it("rejects expired, revoked, wrong-resource, and insufficient-scope OAuth tokens", async () => {
    const expired = await issueMcpOAuthToken();
    await db
      .update(oauthTokens)
      .set({ accessExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(oauthTokens.accessTokenHash, await hashToken(expired.accessToken)));
    await expectMcpInvalidToken(expired.accessToken, "expired");

    const revoked = await issueMcpOAuthToken();
    await db
      .update(oauthTokens)
      .set({ revokedAt: new Date() })
      .where(eq(oauthTokens.accessTokenHash, await hashToken(revoked.accessToken)));
    await expectMcpInvalidToken(revoked.accessToken, "revoked");

    const wrongResource = await issueMcpOAuthToken();
    await db
      .update(oauthTokens)
      .set({ resource: `${baseUrl}/not-mcp` })
      .where(
        eq(oauthTokens.accessTokenHash, await hashToken(wrongResource.accessToken)),
      );
    await expectMcpInvalidToken(wrongResource.accessToken, "resource mismatch");

    const noReadScope = await issueMcpOAuthToken({ scope: "mcp:write" });
    await expectMcpInvalidToken(noReadScope.accessToken, "insufficient scope");
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
    const listToolsBody = await mcpJson(listTools);
    expect(listToolsBody).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [] },
    });
    expect(listToolsBody.error).toBeUndefined();

    const listResources = await mcpSessionRequest({
      apiKey: aliceApiKey,
      sessionId: sessionId!,
      id: 20,
      method: "resources/list",
    });
    expect(listResources).toMatchObject({
      jsonrpc: "2.0",
      id: 20,
      result: { resources: [] },
    });
    expect(listResources.error).toBeUndefined();

    const listResourceTemplates = await mcpSessionRequest({
      apiKey: aliceApiKey,
      sessionId: sessionId!,
      id: 21,
      method: "resources/templates/list",
    });
    expect(listResourceTemplates).toMatchObject({
      jsonrpc: "2.0",
      id: 21,
      result: { resourceTemplates: [] },
    });
    expect(listResourceTemplates.error).toBeUndefined();

    const listPrompts = await mcpSessionRequest({
      apiKey: aliceApiKey,
      sessionId: sessionId!,
      id: 22,
      method: "prompts/list",
    });
    expect(listPrompts).toMatchObject({
      jsonrpc: "2.0",
      id: 22,
      result: { prompts: [] },
    });
    expect(listPrompts.error).toBeUndefined();

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

  it("routes unauthenticated authorization requests through GitHub sign-in and back", async () => {
    const { challenge } = await pkcePair();
    const authorizePath = `/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: "slashtalk-static-claude-code",
      redirect_uri: "http://localhost:37622/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "client-state",
    })}`;

    const loginRequired = await fetch(`${baseUrl}${authorizePath}`, {
      redirect: "manual",
    });
    expect(loginRequired.status).toBe(302);
    const loginLocation = loginRequired.headers.get("location");
    expect(loginLocation).toStartWith("/auth/github?");
    expect(new URLSearchParams(loginLocation!.split("?")[1]).get("return_to")).toBe(
      authorizePath,
    );

    const githubRedirect = await fetch(`${baseUrl}${loginLocation}`, {
      redirect: "manual",
    });
    expect(githubRedirect.status).toBe(302);
    const githubLocation = new URL(githubRedirect.headers.get("location")!);
    const webState = githubLocation.searchParams.get("state");
    expect(webState).toStartWith("web:");

    const callback = await fetch(
      `${baseUrl}/auth/github/callback?${new URLSearchParams({
        code: "alice_code",
        state: webState!,
      })}`,
      { redirect: "manual" },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(authorizePath);
    expect(callback.headers.get("set-cookie")).toContain("session=");
  });

  it("accepts known static clients and rejects unknown static clients at authorize", async () => {
    const { challenge } = await pkcePair();
    const known = await fetch(
      `${baseUrl}/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: "slashtalk-static-claude-code",
        redirect_uri: "http://localhost:37622/callback",
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`,
      { redirect: "manual", headers: { Cookie: aliceCookie } },
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
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`,
      { redirect: "manual", headers: { Cookie: aliceCookie } },
    );
    expect(unknown.status).toBe(400);
  });

  it("exchanges an authorization code with PKCE for MCP tokens", async () => {
    const { clientId, redirectUri } = await registerDynamicOAuthClient();
    const { verifier, challenge } = await pkcePair();
    const code = await authorizeCode({
      clientId,
      redirectUri,
      codeChallenge: challenge,
      scope: "mcp:read mcp:write offline_access",
      resource: `${baseUrl}/mcp`,
    });

    const token = await tokenExchange({
      clientId,
      redirectUri,
      code,
      codeVerifier: verifier,
      resource: `${baseUrl}/mcp`,
    });

    expect(token.status).toBe(200);
    const body = (await token.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      refresh_token: string;
      scope: string;
      resource: string;
    };
    expect(body.access_token).toStartWith("mcp_at_");
    expect(body.refresh_token).toStartWith("mcp_rt_");
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBeGreaterThan(0);
    expect(body.scope).toBe("mcp:read mcp:write offline_access");
    expect(body.resource).toBe(`${baseUrl}/mcp`);
  });

  it("allows token exchange without resource because Codex omits RFC 8707 resource", async () => {
    const { clientId, redirectUri } = await registerDynamicOAuthClient();
    const { verifier, challenge } = await pkcePair();
    const code = await authorizeCode({
      clientId,
      redirectUri,
      codeChallenge: challenge,
      scope: "mcp:read mcp:write",
    });

    const token = await tokenExchange({
      clientId,
      redirectUri,
      code,
      codeVerifier: verifier,
    });

    expect(token.status).toBe(200);
    const body = (await token.json()) as { resource: string };
    expect(body.resource).toBe(`${baseUrl}/mcp`);
  });

  it("rejects token exchange with an invalid PKCE verifier", async () => {
    const { clientId, redirectUri } = await registerDynamicOAuthClient();
    const { challenge } = await pkcePair();
    const code = await authorizeCode({
      clientId,
      redirectUri,
      codeChallenge: challenge,
    });

    const token = await tokenExchange({
      clientId,
      redirectUri,
      code,
      codeVerifier: "wrong-verifier",
    });

    expect(token.status).toBe(400);
    expect(await token.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects reused authorization codes", async () => {
    const { clientId, redirectUri } = await registerDynamicOAuthClient();
    const { verifier, challenge } = await pkcePair();
    const code = await authorizeCode({
      clientId,
      redirectUri,
      codeChallenge: challenge,
    });

    const first = await tokenExchange({
      clientId,
      redirectUri,
      code,
      codeVerifier: verifier,
    });
    expect(first.status).toBe(200);

    const second = await tokenExchange({
      clientId,
      redirectUri,
      code,
      codeVerifier: verifier,
    });
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects expired authorization codes", async () => {
    const { clientId, redirectUri } = await registerDynamicOAuthClient();
    const { verifier, challenge } = await pkcePair();
    const code = await authorizeCode({
      clientId,
      redirectUri,
      codeChallenge: challenge,
    });

    await db
      .update(oauthAuthorizationCodes)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(oauthAuthorizationCodes.codeHash, await hashToken(code)));

    const token = await tokenExchange({
      clientId,
      redirectUri,
      code,
      codeVerifier: verifier,
    });

    expect(token.status).toBe(400);
    expect(await token.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects token exchange when a supplied resource does not match /mcp", async () => {
    const { clientId, redirectUri } = await registerDynamicOAuthClient();
    const { verifier, challenge } = await pkcePair();
    const code = await authorizeCode({
      clientId,
      redirectUri,
      codeChallenge: challenge,
      resource: `${baseUrl}/mcp`,
    });

    const token = await tokenExchange({
      clientId,
      redirectUri,
      code,
      codeVerifier: verifier,
      resource: `${baseUrl}/not-mcp`,
    });

    expect(token.status).toBe(400);
    expect(await token.json()).toMatchObject({ error: "invalid_target" });
  });

  it("rotates MCP OAuth refresh tokens and returns a fresh access token", async () => {
    const issued = await issueMcpOAuthToken();
    const refreshed = await refreshTokenExchange({
      clientId: issued.clientId,
      refreshToken: issued.refreshToken,
      resource: `${baseUrl}/mcp`,
    });

    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
      resource: string;
    };
    expect(body.access_token).toStartWith("mcp_at_");
    expect(body.access_token).not.toBe(issued.accessToken);
    expect(body.refresh_token).toStartWith("mcp_rt_");
    expect(body.refresh_token).not.toBe(issued.refreshToken);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBeGreaterThan(0);
    expect(body.scope).toBe("mcp:read mcp:write offline_access");
    expect(body.resource).toBe(`${baseUrl}/mcp`);

    const mcp = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${body.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initializeRequest()),
    });
    expect(mcp.status).toBe(200);
  });

  it("rejects refresh token replay, expiry, client mismatch, and resource mismatch", async () => {
    const replay = await issueMcpOAuthToken();
    const first = await refreshTokenExchange({
      clientId: replay.clientId,
      refreshToken: replay.refreshToken,
    });
    expect(first.status).toBe(200);
    const second = await refreshTokenExchange({
      clientId: replay.clientId,
      refreshToken: replay.refreshToken,
    });
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: "invalid_grant" });

    const expired = await issueMcpOAuthToken();
    await db
      .update(oauthTokens)
      .set({ refreshExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(oauthTokens.refreshTokenHash, await hashToken(expired.refreshToken)));
    const expiredRefresh = await refreshTokenExchange({
      clientId: expired.clientId,
      refreshToken: expired.refreshToken,
    });
    expect(expiredRefresh.status).toBe(400);
    expect(await expiredRefresh.json()).toMatchObject({ error: "invalid_grant" });

    const wrongClient = await issueMcpOAuthToken();
    const clientMismatch = await refreshTokenExchange({
      clientId: "unknown-client",
      refreshToken: wrongClient.refreshToken,
    });
    expect(clientMismatch.status).toBe(400);
    expect(await clientMismatch.json()).toMatchObject({ error: "invalid_grant" });

    const wrongResource = await issueMcpOAuthToken();
    const resourceMismatch = await refreshTokenExchange({
      clientId: wrongResource.clientId,
      refreshToken: wrongResource.refreshToken,
      resource: `${baseUrl}/not-mcp`,
    });
    expect(resourceMismatch.status).toBe(400);
    expect(await resourceMismatch.json()).toMatchObject({
      error: "invalid_target",
    });
  });

  it("emits structured OAuth audit logs without raw token material", async () => {
    const logs = await captureAuthAuditLogs(async () => {
      const { clientId, redirectUri } = await registerDynamicOAuthClient();
      const { verifier, challenge } = await pkcePair();
      const code = await authorizeCode({
        clientId,
        redirectUri,
        codeChallenge: challenge,
        scope: "mcp:read mcp:write offline_access",
        resource: `${baseUrl}/mcp`,
      });
      const token = await tokenExchange({
        clientId,
        redirectUri,
        code,
        codeVerifier: verifier,
        resource: `${baseUrl}/mcp`,
      });
      expect(token.status).toBe(200);
      const issued = (await token.json()) as {
        access_token: string;
        refresh_token: string;
      };
      const refresh = await refreshTokenExchange({
        clientId,
        refreshToken: issued.refresh_token,
      });
      expect(refresh.status).toBe(200);
      const replay = await refreshTokenExchange({
        clientId,
        refreshToken: issued.refresh_token,
      });
      expect(replay.status).toBe(400);
    });

    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "mcp_oauth_client_registered",
        clientKind: "dynamic",
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "mcp_oauth_authorization_code_issued",
        scope: "mcp:read mcp:write offline_access",
        resource: `${baseUrl}/mcp`,
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "mcp_oauth_token_issued",
        grantType: "authorization_code",
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "mcp_oauth_token_refreshed",
        grantType: "refresh_token",
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "mcp_oauth_token_rejected",
        error: "invalid_grant",
      }),
    );
    for (const log of logs) {
      expect(JSON.stringify(log)).not.toContain("mcp_at_");
      expect(JSON.stringify(log)).not.toContain("mcp_rt_");
      expect(JSON.stringify(log)).not.toContain("mcp_code_");
    }
  });

  it("emits structured audit logs for MCP bearer rejection reasons", async () => {
    const logs = await captureAuthAuditLogs(async () => {
      await expectMcpInvalidToken("bad-oauth-token", "unknown token");
    });

    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "mcp_token_rejected",
        reason: "unknown token",
        route: "/mcp",
      }),
    );
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

async function mcpSessionRequest({
  apiKey,
  sessionId,
  id,
  method,
}: {
  apiKey: string;
  sessionId: string;
  id: number;
  method: string;
}) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method }),
  });
  expect(res.status).toBe(200);
  return mcpJson(res);
}

async function mcpJson(res: Response) {
  const text = await res.text();
  if (text.startsWith("event:")) {
    const dataLine = text
      .split("\n")
      .find((line) => line.startsWith("data: "));
    expect(dataLine).toBeTruthy();
    return JSON.parse(dataLine!.slice("data: ".length));
  }
  return JSON.parse(text);
}

async function registerDynamicOAuthClient() {
  const redirectUri = `http://127.0.0.1:${40_000 + Math.floor(Math.random() * 1_000)}/callback`;
  const res = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Codex",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp:read mcp:write offline_access",
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string };
  return { clientId: body.client_id, redirectUri };
}

async function authorizeCode({
  clientId,
  redirectUri,
  codeChallenge,
  scope = "mcp:read mcp:write",
  resource,
}: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope?: string;
  resource?: string;
}) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope,
    state: "state-123",
  });
  if (resource) params.set("resource", resource);

  const res = await fetch(`${baseUrl}/oauth/authorize?${params}`, {
    redirect: "manual",
    headers: { Cookie: aliceCookie },
  });
  expect(res.status).toBe(302);
  const location = res.headers.get("location");
  expect(location).toBeTruthy();
  const redirect = new URL(location!);
  expect(redirect.searchParams.get("state")).toBe("state-123");
  const code = redirect.searchParams.get("code");
  expect(code).toBeTruthy();
  return code!;
}

async function tokenExchange({
  clientId,
  redirectUri,
  code,
  codeVerifier,
  resource,
}: {
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  resource?: string;
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
    code_verifier: codeVerifier,
  });
  if (resource) body.set("resource", resource);
  return fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

async function refreshTokenExchange({
  clientId,
  refreshToken,
  resource,
}: {
  clientId: string;
  refreshToken: string;
  resource?: string;
}) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });
  if (resource) body.set("resource", resource);
  return fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

async function issueMcpOAuthToken({
  scope = "mcp:read mcp:write offline_access",
}: {
  scope?: string;
} = {}) {
  const { clientId, redirectUri } = await registerDynamicOAuthClient();
  const { verifier, challenge } = await pkcePair();
  const code = await authorizeCode({
    clientId,
    redirectUri,
    codeChallenge: challenge,
    scope,
    resource: `${baseUrl}/mcp`,
  });
  const token = await tokenExchange({
    clientId,
    redirectUri,
    code,
    codeVerifier: verifier,
    resource: `${baseUrl}/mcp`,
  });
  expect(token.status).toBe(200);
  const body = (await token.json()) as {
    access_token: string;
    refresh_token: string;
  };
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    clientId,
  };
}

async function expectMcpInvalidToken(token: string, reason: string) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(initializeRequest()),
  });

  expect(res.status).toBe(401);
  const header = res.headers.get("www-authenticate");
  expect(header).toContain(
    `resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
  );
  expect(header).toContain('error="invalid_token"');
  expect(header).toContain(`error_description="${reason}"`);
}

async function captureAuthAuditLogs(fn: () => Promise<void>) {
  const originalWrite = process.stderr.write;
  const chunks: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = originalWrite;
  }

  return chunks
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.msg === "auth_audit");
}

async function pkcePair(verifier = `verifier-${crypto.randomUUID()}`) {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const challenge = Buffer.from(digest).toString("base64url");
  return { verifier, challenge };
}
