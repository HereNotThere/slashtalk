import { Elysia } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { and, eq, gt, isNull } from "drizzle-orm";
import { config } from "../config";
import type { Database } from "../db";
import {
  oauthAuthorizationCodes,
  oauthClients,
  oauthTokens,
  users,
} from "../db/schema";
import { hashToken } from "../auth/tokens";
import { authAudit } from "../auth/audit";

const SCOPES = ["mcp:read", "mcp:write"] as const;
const STATIC_CLIENT_IDS = new Set(["slashtalk-static-claude-code"]);
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_WRITE_QUOTA_MAX = 120;
const OAUTH_WRITE_QUOTA_WINDOW_MS = 60_000;

type OAuthRouteOptions = {
  registerQuotaMax?: number;
  tokenQuotaMax?: number;
  quotaWindowMs?: number;
};

interface RegisterRequest {
  client_name?: unknown;
  redirect_uris?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  token_endpoint_auth_method?: unknown;
  scope?: unknown;
}

interface OAuthClientRegistration {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  scope: string;
}

export function mcpResourceUrl(origin: string): string {
  return `${origin}/mcp`;
}

export function protectedResourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource`;
}

export function mcpWwwAuthenticate(
  origin: string,
  error?: { code: "invalid_token"; description: string },
): string {
  const params = [`resource_metadata="${protectedResourceMetadataUrl(origin)}"`];
  if (error) {
    params.push(`error="${error.code}"`);
    params.push(`error_description="${error.description}"`);
  }
  return `Bearer ${params.join(", ")}`;
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpResourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SCOPES, "offline_access"],
    protected_resources: [mcpResourceUrl(origin)],
  };
}

export function mcpOAuthRoutes(db: Database, options: OAuthRouteOptions = {}) {
  const metadata = ({ request }: { request: Request }) =>
    authorizationServerMetadata(originOf(request));
  const registerLimiter = new KeyedRequestLimiter({
    max: options.registerQuotaMax ?? OAUTH_WRITE_QUOTA_MAX,
    windowMs: options.quotaWindowMs ?? OAUTH_WRITE_QUOTA_WINDOW_MS,
  });
  const tokenLimiter = new KeyedRequestLimiter({
    max: options.tokenQuotaMax ?? OAUTH_WRITE_QUOTA_MAX,
    windowMs: options.quotaWindowMs ?? OAUTH_WRITE_QUOTA_WINDOW_MS,
  });

  return new Elysia({ name: "oauth/mcp" })
    .use(jwt({ name: "jwt", secret: config.jwtSecret }))
    .get("/.well-known/oauth-protected-resource", ({ request }) =>
      protectedResourceMetadata(originOf(request)),
    )
    .get("/.well-known/oauth-protected-resource/mcp", ({ request }) =>
      protectedResourceMetadata(originOf(request)),
    )
    .get("/.well-known/oauth-authorization-server", metadata)
    .get("/.well-known/oauth-authorization-server/mcp", metadata)
    .get("/mcp/.well-known/oauth-authorization-server", metadata)
    .get("/.well-known/openid-configuration", metadata)
    .get("/.well-known/openid-configuration/mcp", metadata)
    .get("/mcp/.well-known/openid-configuration", metadata)
    .post("/oauth/register", async ({ body, request, set }) => {
      const quota = registerLimiter.record(clientIp(request));
      if (!quota.ok) {
        authAudit("mcp_oauth_rate_limited", {
          route: "/oauth/register",
          limit: quota.limit,
          windowMs: quota.windowMs,
        });
        set.status = 429;
        return {
          error: "slow_down",
          error_description: "too many registration requests",
        };
      }

      const parsed = parseRegistration(body as RegisterRequest);
      if (!parsed.ok) {
        set.status = 400;
        return {
          error: "invalid_client_metadata",
          error_description: parsed.error,
        };
      }

      const registration = await registerDynamicClient(db, parsed.value);
      set.status = 201;
      return registration;
    })
    .get("/oauth/authorize", async ({ request, jwt, cookie, set }) => {
      const url = new URL(request.url);
      const sessionToken =
        typeof cookie.session?.value === "string"
          ? cookie.session.value
          : undefined;
      const user = await sessionUser(db, jwt, sessionToken);
      if (!user) {
        set.status = 302;
        set.headers.location = `/auth/github?${new URLSearchParams({
          return_to: `${url.pathname}${url.search}`,
        })}`;
        return null;
      }

      const parsed = await parseAuthorizeRequest(
        db,
        url.searchParams,
        originOf(request),
      );
      if (!parsed.ok) {
        set.status = 400;
        return { error: "invalid_request", error_description: parsed.error };
      }

      const code = await issueAuthorizationCode(db, {
        userId: user.id,
        clientId: parsed.clientId,
        redirectUri: parsed.redirectUri,
        codeChallenge: parsed.codeChallenge,
        scope: parsed.scope,
        resource: parsed.resource,
      });
      const redirect = new URL(parsed.redirectUri);
      redirect.searchParams.set("code", code);
      const state = url.searchParams.get("state");
      if (state) redirect.searchParams.set("state", state);
      set.status = 302;
      set.headers.location = redirect.toString();
      return null;
    })
    .post("/oauth/token", async ({ request, set }) => {
      const origin = originOf(request);
      const parsed = await parseTokenRequest(request, origin);
      const quota = tokenLimiter.record(
        `${clientIp(request)}:${parsed.ok ? parsed.value.clientId : "invalid"}`,
      );
      if (!quota.ok) {
        authAudit("mcp_oauth_rate_limited", {
          route: "/oauth/token",
          ...(parsed.ok ? { clientId: parsed.value.clientId } : {}),
          limit: quota.limit,
          windowMs: quota.windowMs,
        });
        set.status = 429;
        return {
          error: "slow_down",
          error_description: "too many token requests",
        };
      }
      if (!parsed.ok) {
        authAudit("mcp_oauth_token_rejected", {
          error: parsed.error,
          reason: parsed.errorDescription,
        });
        set.status = 400;
        return {
          error: parsed.error,
          error_description: parsed.errorDescription,
        };
      }

      const issued =
        parsed.value.grantType === "authorization_code"
          ? await exchangeAuthorizationCode(db, parsed.value)
          : await rotateOAuthRefreshToken(db, parsed.value);
      if (!issued.ok) {
        authAudit("mcp_oauth_token_rejected", {
          grantType: parsed.value.grantType,
          clientId: parsed.value.clientId,
          error: issued.error,
          reason: issued.errorDescription,
        });
        set.status = 400;
        return {
          error: issued.error,
          error_description: issued.errorDescription,
        };
      }

      return issued.value;
    });
}

function originOf(request: Request): string {
  return new URL(request.url).origin;
}

function clientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip") ?? new URL(request.url).hostname;
}

class KeyedRequestLimiter {
  private buckets = new Map<string, number[]>();

  constructor(private options: { max: number; windowMs: number }) {}

  record(key: string):
    | { ok: true }
    | { ok: false; limit: number; windowMs: number } {
    const now = Date.now();
    const cutoff = now - this.options.windowMs;
    const bucket = this.buckets.get(key)?.filter((ts) => ts > cutoff) ?? [];
    if (bucket.length >= this.options.max) {
      this.buckets.set(key, bucket);
      return {
        ok: false,
        limit: this.options.max,
        windowMs: this.options.windowMs,
      };
    }

    bucket.push(now);
    this.buckets.set(key, bucket);
    return { ok: true };
  }
}

type JwtVerifier = {
  verify: (token: string) => Promise<false | { sub?: string | number }>;
};

async function sessionUser(
  db: Database,
  jwt: JwtVerifier,
  token: string | undefined,
) {
  if (!token) return null;
  const payload = await jwt.verify(token);
  if (!payload || !payload.sub) return null;
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, Number(payload.sub)))
    .limit(1);
  return user ?? null;
}

type OAuthClientMetadata = Omit<
  OAuthClientRegistration,
  "client_id" | "client_id_issued_at"
>;

function parseRegistration(input: RegisterRequest):
  | { ok: true; value: OAuthClientMetadata }
  | { ok: false; error: string } {
  const clientName =
    typeof input.client_name === "string" && input.client_name.trim() !== ""
      ? input.client_name.trim()
      : "MCP Client";
  const redirectUris = stringArray(input.redirect_uris);
  if (!redirectUris.length) return { ok: false, error: "redirect_uris required" };
  if (!redirectUris.every(isAllowedLoopbackRedirect)) {
    return { ok: false, error: "redirect_uris must be loopback callbacks" };
  }

  const grantTypes = stringArray(input.grant_types);
  if (!grantTypes.includes("authorization_code")) {
    return { ok: false, error: "authorization_code grant required" };
  }
  const responseTypes = stringArray(input.response_types);
  if (!responseTypes.includes("code")) {
    return { ok: false, error: "code response type required" };
  }
  if (
    input.token_endpoint_auth_method !== undefined &&
    input.token_endpoint_auth_method !== "none"
  ) {
    return { ok: false, error: "only public clients are supported" };
  }

  const requestedScope =
    typeof input.scope === "string" && input.scope.trim() !== ""
      ? input.scope.trim()
      : SCOPES.join(" ");
  if (!scopesAllowed(requestedScope)) {
    return { ok: false, error: "unsupported scope requested" };
  }

  return {
    ok: true,
    value: {
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: "none",
      scope: requestedScope,
    },
  };
}

function scopesAllowed(scope: string): boolean {
  return scope
    .split(/\s+/)
    .filter(Boolean)
    .every((item) => [...SCOPES, "offline_access"].includes(item));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isAllowedLoopbackRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.pathname === "/callback"
    );
  } catch {
    return false;
  }
}

async function registerDynamicClient(
  db: Database,
  metadata: OAuthClientMetadata,
): Promise<OAuthClientRegistration> {
  const clientId = `dyn_${crypto.randomUUID()}`;
  await db.insert(oauthClients).values({
    clientId,
    clientKind: "dynamic",
    clientName: metadata.client_name,
    redirectUris: metadata.redirect_uris,
    grantTypes: metadata.grant_types,
    responseTypes: metadata.response_types,
    tokenEndpointAuthMethod: metadata.token_endpoint_auth_method,
    scope: metadata.scope,
  });
  authAudit("mcp_oauth_client_registered", {
    clientId,
    clientKind: "dynamic",
    clientName: metadata.client_name,
  });
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    ...metadata,
  };
}

export async function findOAuthClient(db: Database, clientId: string) {
  if (STATIC_CLIENT_IDS.has(clientId)) {
    return {
      clientId,
      clientKind: "static",
      clientName: clientId,
      redirectUris: [],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      scope: SCOPES.join(" "),
    };
  }

  const [client] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  return client ?? null;
}

async function parseAuthorizeRequest(
  db: Database,
  params: URLSearchParams,
  origin: string,
): Promise<
  | {
      ok: true;
      clientId: string;
      redirectUri: string;
      codeChallenge: string;
      scope: string;
      resource: string;
    }
  | { ok: false; error: string }
> {
  const clientId = params.get("client_id");
  if (!clientId) return { ok: false, error: "client_id required" };
  const client = await findOAuthClient(db, clientId);
  if (!client) return { ok: false, error: "unknown client_id" };
  if (params.get("response_type") !== "code") {
    return { ok: false, error: "response_type must be code" };
  }
  if (params.get("code_challenge_method") !== "S256") {
    return { ok: false, error: "S256 PKCE required" };
  }
  const codeChallenge = params.get("code_challenge");
  if (!codeChallenge) {
    return { ok: false, error: "code_challenge required" };
  }

  const redirectUri = params.get("redirect_uri");
  if (!redirectUri) return { ok: false, error: "redirect_uri required" };
  if (!isAllowedLoopbackRedirect(redirectUri)) {
    return { ok: false, error: "redirect_uri must be a loopback callback" };
  }
  if (
    client.clientKind === "dynamic" &&
    !stringArray(client.redirectUris).includes(redirectUri)
  ) {
    return { ok: false, error: "redirect_uri not registered" };
  }

  const scope = params.get("scope")?.trim() || SCOPES.join(" ");
  if (!scopesAllowed(scope)) {
    return { ok: false, error: "unsupported scope requested" };
  }

  const resource = params.get("resource") ?? mcpResourceUrl(origin);
  if (resource !== mcpResourceUrl(origin)) {
    return { ok: false, error: "resource must match MCP resource" };
  }

  return { ok: true, clientId, redirectUri, codeChallenge, scope, resource };
}

async function issueAuthorizationCode(
  db: Database,
  input: {
    userId: number;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
    resource: string;
  },
): Promise<string> {
  const code = `mcp_code_${crypto.randomUUID()}`;
  await db.insert(oauthAuthorizationCodes).values({
    codeHash: await hashToken(code),
    userId: input.userId,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    scope: input.scope,
    resource: input.resource,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
  });
  authAudit("mcp_oauth_authorization_code_issued", {
    userId: input.userId,
    clientId: input.clientId,
    scope: input.scope,
    resource: input.resource,
  });
  return code;
}

interface AuthorizationCodeTokenRequest {
  grantType: "authorization_code";
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  resource: string | null;
}

interface RefreshTokenRequest {
  grantType: "refresh_token";
  clientId: string;
  refreshToken: string;
  resource: string | null;
}

type ParsedTokenRequest = AuthorizationCodeTokenRequest | RefreshTokenRequest;

async function parseTokenRequest(
  request: Request,
  origin: string,
): Promise<
  | { ok: true; value: ParsedTokenRequest }
  | { ok: false; error: string; errorDescription: string }
> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return {
      ok: false,
      error: "invalid_request",
      errorDescription: "token request must be form encoded",
    };
  }

  const params = new URLSearchParams(await request.text());
  const grantType = params.get("grant_type") ?? "";
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const code = params.get("code") ?? "";
  const codeVerifier = params.get("code_verifier") ?? "";
  const refreshToken = params.get("refresh_token") ?? "";
  const resource = params.get("resource");

  if (resource && resource !== mcpResourceUrl(origin)) {
    return {
      ok: false,
      error: "invalid_target",
      errorDescription: "resource must match MCP resource",
    };
  }

  if (grantType === "authorization_code") {
    if (!clientId || !redirectUri || !code || !codeVerifier) {
      return {
        ok: false,
        error: "invalid_request",
        errorDescription:
          "client_id, redirect_uri, code, and code_verifier are required",
      };
    }

    return {
      ok: true,
      value: { grantType, clientId, redirectUri, code, codeVerifier, resource },
    };
  }

  if (grantType === "refresh_token") {
    if (!clientId || !refreshToken) {
      return {
        ok: false,
        error: "invalid_request",
        errorDescription: "client_id and refresh_token are required",
      };
    }

    return {
      ok: true,
      value: { grantType, clientId, refreshToken, resource },
    };
  }

  return {
    ok: false,
    error: "unsupported_grant_type",
    errorDescription: "grant_type must be authorization_code or refresh_token",
  };
}

async function exchangeAuthorizationCode(
  db: Database,
  request: AuthorizationCodeTokenRequest,
): Promise<IssueTokenResult> {
  const codeHash = await hashToken(request.code);
  const [code] = await db
    .select()
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.codeHash, codeHash))
    .limit(1);
  if (!code || code.usedAt || code.expiresAt < new Date()) {
    return invalidGrant("authorization code is invalid or expired");
  }
  if (code.clientId !== request.clientId) {
    return invalidGrant("client_id does not match authorization code");
  }
  if (code.redirectUri !== request.redirectUri) {
    return invalidGrant("redirect_uri does not match authorization code");
  }
  if (request.resource && code.resource !== request.resource) {
    return {
      ok: false,
      error: "invalid_target",
      errorDescription: "resource does not match authorization code",
    };
  }
  if ((await pkceChallenge(request.codeVerifier)) !== code.codeChallenge) {
    return invalidGrant("code_verifier does not match code_challenge");
  }

  return db.transaction(async (tx) => {
    const [consumed] = await tx
      .update(oauthAuthorizationCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(oauthAuthorizationCodes.id, code.id),
          isNull(oauthAuthorizationCodes.usedAt),
          gt(oauthAuthorizationCodes.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!consumed) {
      return invalidGrant("authorization code is invalid or expired");
    }

    return issueOAuthTokens(tx, {
      userId: consumed.userId,
      clientId: consumed.clientId,
      scope: consumed.scope,
      resource: consumed.resource,
      auditEvent: "mcp_oauth_token_issued",
      grantType: "authorization_code",
    });
  });
}

async function rotateOAuthRefreshToken(
  db: Database,
  request: RefreshTokenRequest,
): Promise<IssueTokenResult> {
  const refreshTokenHash = await hashToken(request.refreshToken);
  const [token] = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.refreshTokenHash, refreshTokenHash))
    .limit(1);

  if (!token || token.revokedAt || token.refreshExpiresAt < new Date()) {
    return invalidGrant("refresh token is invalid or expired");
  }
  if (token.clientId !== request.clientId) {
    return invalidGrant("client_id does not match refresh token");
  }
  if (request.resource && token.resource !== request.resource) {
    return {
      ok: false,
      error: "invalid_target",
      errorDescription: "resource does not match refresh token",
    };
  }

  return db.transaction(async (tx) => {
    const [consumed] = await tx
      .update(oauthTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(oauthTokens.id, token.id),
          isNull(oauthTokens.revokedAt),
          gt(oauthTokens.refreshExpiresAt, new Date()),
        ),
      )
      .returning();
    if (!consumed) {
      return invalidGrant("refresh token is invalid or expired");
    }

    return issueOAuthTokens(tx, {
      userId: consumed.userId,
      clientId: consumed.clientId,
      scope: consumed.scope,
      resource: consumed.resource,
      auditEvent: "mcp_oauth_token_refreshed",
      grantType: "refresh_token",
    });
  });
}

type IssueTokenResult =
  | {
      ok: true;
      value: {
        access_token: string;
        token_type: "Bearer";
        expires_in: number;
        refresh_token: string;
        scope: string;
        resource: string;
      };
    }
  | { ok: false; error: string; errorDescription: string };

async function issueOAuthTokens(
  db: Pick<Database, "insert">,
  input: {
    userId: number;
    clientId: string;
    scope: string;
    resource: string;
    auditEvent: "mcp_oauth_token_issued" | "mcp_oauth_token_refreshed";
    grantType: "authorization_code" | "refresh_token";
  },
): Promise<IssueTokenResult> {
  const accessToken = `mcp_at_${crypto.randomUUID()}`;
  const refreshToken = `mcp_rt_${crypto.randomUUID()}`;
  await db.insert(oauthTokens).values({
    userId: input.userId,
    clientId: input.clientId,
    accessTokenHash: await hashToken(accessToken),
    refreshTokenHash: await hashToken(refreshToken),
    scope: input.scope,
    resource: input.resource,
    accessExpiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000),
    refreshExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
  authAudit(input.auditEvent, {
    userId: input.userId,
    clientId: input.clientId,
    grantType: input.grantType,
    scope: input.scope,
    resource: input.resource,
  });

  return {
    ok: true,
    value: {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: input.scope,
      resource: input.resource,
    },
  };
}

function invalidGrant(errorDescription: string) {
  return { ok: false as const, error: "invalid_grant", errorDescription };
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return Buffer.from(digest).toString("base64url");
}
