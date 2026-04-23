import { createHash, randomBytes } from "node:crypto";
import { base64urlEncode, issueToken, randomState, type AuthConfig } from "./auth.ts";
import { exchangeCode, fetchGithubUser } from "./github-oauth.ts";
import { log } from "./server.ts";

type RegisteredClient = {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: number;
};

type PendingMcpAuth = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  state?: string;
  scope?: string;
  resource?: string;
};

type McpAuthCode = PendingMcpAuth & {
  sub: string;
  gid: number;
  name?: string;
  avatar?: string;
  expiresAt: number;
};

const AUTH_CODE_TTL_MS = 60_000;
const PENDING_TTL_MS = 10 * 60_000;

const clients = new Map<string, RegisteredClient>();
const pendingAuth = new Map<string, PendingMcpAuth>();
const authCodes = new Map<string, McpAuthCode>();

export function protectedResourceMetadata(config: AuthConfig): Response {
  return json(
    {
      resource: config.publicUrl,
      authorization_servers: [config.publicUrl],
      bearer_methods_supported: ["header"],
      resource_documentation: `${config.publicUrl}/healthz`,
    },
    200,
  );
}

export function authorizationServerMetadata(config: AuthConfig): Response {
  return json(
    {
      issuer: config.publicUrl,
      authorization_endpoint: `${config.publicUrl}/authorize`,
      token_endpoint: `${config.publicUrl}/token`,
      registration_endpoint: `${config.publicUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    },
    200,
  );
}

export async function handleRegister(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return oauthError("invalid_client_metadata", "request body must be JSON", 400);
  }
  const { redirect_uris, client_name } = body as {
    redirect_uris?: unknown;
    client_name?: unknown;
  };
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return oauthError("invalid_redirect_uri", "redirect_uris required", 400);
  }
  const uris: string[] = [];
  for (const u of redirect_uris) {
    if (typeof u !== "string" || !isAllowedRedirectUri(u)) {
      return oauthError("invalid_redirect_uri", `invalid redirect_uri: ${String(u)}`, 400);
    }
    uris.push(u);
  }

  const clientId = `mcp_${base64urlEncode(randomBytes(16))}`;
  const issuedAt = Math.floor(Date.now() / 1000);
  clients.set(clientId, {
    clientId,
    redirectUris: uris,
    clientName: typeof client_name === "string" ? client_name : undefined,
    createdAt: issuedAt,
  });
  log("info", "dcr_registered", { clientId, clientName: client_name, uris });

  return json(
    {
      client_id: clientId,
      client_id_issued_at: issuedAt,
      redirect_uris: uris,
      client_name: typeof client_name === "string" ? client_name : undefined,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
    201,
  );
}

export function handleAuthorize(config: AuthConfig, url: URL): Response {
  sweepPending();
  const p = url.searchParams;
  const clientId = p.get("client_id");
  const redirectUri = p.get("redirect_uri");
  const responseType = p.get("response_type");
  const codeChallenge = p.get("code_challenge");
  const codeChallengeMethod = p.get("code_challenge_method");
  const state = p.get("state") ?? undefined;
  const scope = p.get("scope") ?? undefined;
  const resource = p.get("resource") ?? undefined;

  if (!clientId) return errorPage("missing client_id");
  const client = clients.get(clientId);
  if (!client) return errorPage("unknown client_id");
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return errorPage("redirect_uri not registered for client");
  }
  if (responseType !== "code") {
    return redirectWithError(redirectUri, "unsupported_response_type", "only response_type=code is supported", state);
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return redirectWithError(redirectUri, "invalid_request", "PKCE required (S256)", state);
  }

  const githubState = randomState();
  pendingAuth.set(githubState, {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod: "S256",
    state,
    scope,
    resource,
  });

  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.searchParams.set("client_id", config.githubClientId);
  gh.searchParams.set("redirect_uri", `${config.publicUrl}/auth/github/callback`);
  gh.searchParams.set("scope", "read:user");
  gh.searchParams.set("state", githubState);
  gh.searchParams.set("allow_signup", "true");
  return Response.redirect(gh.toString(), 302);
}

export async function handleGithubCallback(config: AuthConfig, url: URL): Promise<Response> {
  sweepPending();
  const code = url.searchParams.get("code");
  const ghState = url.searchParams.get("state");
  const ghError = url.searchParams.get("error");
  if (ghError) return errorPage(`GitHub: ${ghError}`);
  if (!code || !ghState) return errorPage("missing code or state");

  const pending = pendingAuth.get(ghState);
  if (!pending) return errorPage("invalid or expired state");
  pendingAuth.delete(ghState);

  let accessToken: string;
  try {
    accessToken = await exchangeCode(config, code);
  } catch (e) {
    log("error", "github_exchange_failed", { err: String(e) });
    return redirectWithError(pending.redirectUri, "server_error", "GitHub exchange failed", pending.state);
  }

  let ghUser: Awaited<ReturnType<typeof fetchGithubUser>>;
  try {
    ghUser = await fetchGithubUser(accessToken);
  } catch (e) {
    log("error", "github_user_fetch_failed", { err: String(e) });
    return redirectWithError(pending.redirectUri, "server_error", "GitHub user fetch failed", pending.state);
  }

  sweepAuthCodes();
  const mcpCode = `mcpc_${base64urlEncode(randomBytes(24))}`;
  authCodes.set(mcpCode, {
    ...pending,
    sub: ghUser.login,
    gid: ghUser.id,
    name: ghUser.name ?? undefined,
    avatar: ghUser.avatar_url,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });

  const dest = new URL(pending.redirectUri);
  dest.searchParams.set("code", mcpCode);
  if (pending.state !== undefined) dest.searchParams.set("state", pending.state);
  log("info", "mcp_auth_code_issued", { clientId: pending.clientId, login: ghUser.login });
  return Response.redirect(dest.toString(), 302);
}

export async function handleToken(config: AuthConfig, req: Request): Promise<Response> {
  sweepAuthCodes();
  const params = await readFormOrJson(req);
  if (!params) return oauthError("invalid_request", "could not parse body", 400);

  const grantType = params.get("grant_type");
  if (grantType !== "authorization_code") {
    return oauthError("unsupported_grant_type", `unsupported grant_type: ${grantType}`, 400);
  }
  const code = params.get("code");
  const redirectUri = params.get("redirect_uri");
  const clientId = params.get("client_id");
  const codeVerifier = params.get("code_verifier");

  if (!code || !redirectUri || !clientId || !codeVerifier) {
    return oauthError("invalid_request", "missing required parameter", 400);
  }

  const stored = authCodes.get(code);
  if (!stored) return oauthError("invalid_grant", "unknown code", 400);
  authCodes.delete(code);

  if (stored.expiresAt < Date.now()) return oauthError("invalid_grant", "code expired", 400);
  if (stored.clientId !== clientId) return oauthError("invalid_grant", "client_id mismatch", 400);
  if (stored.redirectUri !== redirectUri) return oauthError("invalid_grant", "redirect_uri mismatch", 400);

  const computed = base64urlEncode(createHash("sha256").update(codeVerifier).digest());
  if (computed !== stored.codeChallenge) {
    return oauthError("invalid_grant", "PKCE verification failed", 400);
  }

  const accessToken = issueToken(config, {
    sub: stored.sub,
    gid: stored.gid,
    name: stored.name,
    avatar: stored.avatar,
  });

  return json(
    {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: config.tokenTtlSeconds,
      scope: stored.scope,
    },
    200,
  );
}

function isAllowedRedirectUri(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return true;
    // custom scheme for desktop apps (chatheads://, mcp://, etc.)
    if (url.protocol.endsWith(":") && url.protocol.length > 2 && !url.protocol.startsWith("javascript:")) return true;
    return false;
  } catch {
    return false;
  }
}

async function readFormOrJson(req: Request): Promise<URLSearchParams | null> {
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) {
      const body = (await req.json()) as Record<string, unknown>;
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === "string") p.set(k, v);
      }
      return p;
    }
    const text = await req.text();
    return new URLSearchParams(text);
  } catch {
    return null;
  }
}

function sweepPending(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [k, v] of pendingAuth) {
    // pending doesn't carry a timestamp; cap the map size as a guard.
    void v;
    void cutoff;
  }
  if (pendingAuth.size > 500) {
    const excess = pendingAuth.size - 500;
    let i = 0;
    for (const k of pendingAuth.keys()) {
      if (i++ >= excess) break;
      pendingAuth.delete(k);
    }
  }
}

function sweepAuthCodes(): void {
  const now = Date.now();
  for (const [k, v] of authCodes) {
    if (v.expiresAt < now) authCodes.delete(k);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function oauthError(error: string, description: string, status: number): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function redirectWithError(
  redirectUri: string,
  error: string,
  description: string,
  state?: string,
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state !== undefined) url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

function errorPage(message: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><title>Sign-in error</title>
<style>body{font:14px system-ui;margin:3em auto;max-width:36em;padding:0 1em}</style>
<h1>Sign-in error</h1><p>${escapeHtml(message)}</p>`;
  return new Response(html, {
    status: 400,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "\"" ? "&quot;" : "&#39;",
  );
}
