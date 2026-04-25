const port = Number(process.env["MCP_OAUTH_SPIKE_PORT"] ?? 37620);
const host = process.env["HOST"] ?? "127.0.0.1";
const issuer = process.env["MCP_OAUTH_SPIKE_ISSUER"] ?? `http://${host}:${port}`;
const resource = process.env["MCP_OAUTH_SPIKE_RESOURCE"] ?? `${issuer}/mcp`;
const validAccessToken = "slashtalk-oauth-spike-access";
const validRefreshToken = "slashtalk-oauth-spike-refresh";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = key.toLowerCase() === "authorization" ? "<redacted>" : value;
  });
  return out;
}

async function bodyPreview(req: Request): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const text = await req.clone().text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 1_000);
  }
}

async function logRequest(req: Request): Promise<void> {
  const url = new URL(req.url);
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      msg: "mcp_oauth_spike_request",
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: redactHeaders(req.headers),
      body: await bodyPreview(req),
    }),
  );
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "authorization, content-type, accept, mcp-session-id, mcp-protocol-version");
  headers.set("access-control-expose-headers", "www-authenticate, mcp-session-id");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function text(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("access-control-allow-origin", "*");
  return new Response(body, { ...init, headers });
}

function unauthorized(): Response {
  return json(
    { error: "missing_oauth_token", message: "OAuth discovery spike requires a bearer token" },
    {
      status: 401,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}

function protectedResourceMetadata(): Response {
  return json({
    resource,
    authorization_servers: [issuer],
    scopes_supported: ["mcp:read", "mcp:write"],
    bearer_methods_supported: ["header"],
  });
}

function authorizationServerMetadata(): Response {
  return json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp:read", "mcp:write", "offline_access"],
    protected_resources: [resource],
  });
}

async function registerClient(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const redirectUris = Array.isArray(body["redirect_uris"])
    ? body["redirect_uris"]
    : [];
  return json(
    {
      client_id: "slashtalk-oauth-spike-client",
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_name: body["client_name"] ?? "Slashtalk OAuth Spike Client",
    },
    { status: 201 },
  );
}

function authorize(req: Request): Response {
  const url = new URL(req.url);
  const redirectUri = url.searchParams.get("redirect_uri");
  if (!redirectUri) return text("missing redirect_uri", { status: 400 });
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", "slashtalk-oauth-spike-code");
  const state = url.searchParams.get("state");
  if (state) redirect.searchParams.set("state", state);
  return Response.redirect(redirect, 302);
}

async function token(req: Request): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  const fields = contentType.includes("application/json")
    ? ((await req.json().catch(() => ({}))) as Record<string, string>)
    : Object.fromEntries((await req.formData()).entries());
  const grantType = String(fields["grant_type"] ?? "");

  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    return json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  return json({
    access_token: validAccessToken,
    refresh_token: validRefreshToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope: "mcp:read mcp:write",
  });
}

async function handleMcp(req: Request): Promise<Response> {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${validAccessToken}`) return unauthorized();

  const request = (await req.json().catch(() => ({}))) as JsonRpcRequest;
  const headers = {
    "mcp-session-id": req.headers.get("mcp-session-id") ?? crypto.randomUUID(),
  };

  if (request.method === "initialize") {
    return json(
      {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "slashtalk-oauth-spike", version: "0.0.1" },
        },
      },
      { headers },
    );
  }

  if (request.method === "tools/list") {
    return json(
      { jsonrpc: "2.0", id: request.id ?? null, result: { tools: [] } },
      { headers },
    );
  }

  if (request.method?.startsWith("notifications/")) {
    return new Response(null, { status: 202, headers });
  }

  return json(
    {
      jsonrpc: "2.0",
      id: request.id ?? null,
      error: { code: -32601, message: "Method not found" },
    },
    { status: 404, headers },
  );
}

const server = Bun.serve({
  hostname: host,
  port,
  async fetch(req) {
    await logRequest(req);
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return json({}, { status: 204 });
    if (url.pathname === "/mcp") return handleMcp(req);
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return protectedResourceMetadata();
    }
    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration"
    ) {
      return authorizationServerMetadata();
    }
    if (url.pathname === "/oauth/register" && req.method === "POST") {
      return registerClient(req);
    }
    if (url.pathname === "/oauth/authorize" && req.method === "GET") {
      return authorize(req);
    }
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      return token(req);
    }
    return text("not found", { status: 404 });
  },
});

console.log(
  JSON.stringify({
    ts: new Date().toISOString(),
    msg: "mcp_oauth_spike_listening",
    url: `http://${server.hostname}:${server.port}`,
    resource,
  }),
);
