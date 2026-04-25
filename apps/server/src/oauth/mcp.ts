import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import type { Database } from "../db";
import { oauthClients } from "../db/schema";

const SCOPES = ["mcp:read", "mcp:write"] as const;
const STATIC_CLIENT_IDS = new Set(["slashtalk-static-claude-code"]);

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

export function mcpWwwAuthenticate(origin: string): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(origin)}"`;
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

export function mcpOAuthRoutes(db: Database) {
  const metadata = ({ request }: { request: Request }) =>
    authorizationServerMetadata(originOf(request));

  return new Elysia({ name: "oauth/mcp" })
    .get("/.well-known/oauth-protected-resource", ({ request }) =>
      protectedResourceMetadata(originOf(request)),
    )
    .get("/.well-known/oauth-authorization-server", metadata)
    .get("/.well-known/oauth-authorization-server/mcp", metadata)
    .get("/mcp/.well-known/oauth-authorization-server", metadata)
    .get("/.well-known/openid-configuration", metadata)
    .get("/.well-known/openid-configuration/mcp", metadata)
    .get("/mcp/.well-known/openid-configuration", metadata)
    .post("/oauth/register", async ({ body, set }) => {
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
    .get("/oauth/authorize", async ({ request, set }) => {
      const url = new URL(request.url);
      const parsed = await parseAuthorizeRequest(db, url.searchParams);
      if (!parsed.ok) {
        set.status = 400;
        return { error: "invalid_request", error_description: parsed.error };
      }

      const redirect = new URL(parsed.redirectUri);
      redirect.searchParams.set("code", "oauth_metadata_slice_placeholder_code");
      const state = url.searchParams.get("state");
      if (state) redirect.searchParams.set("state", state);
      set.status = 302;
      set.headers.location = redirect.toString();
      return null;
    });
}

function originOf(request: Request): string {
  return new URL(request.url).origin;
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
  const scopes = requestedScope.split(/\s+/);
  if (!scopes.every((scope) => [...SCOPES, "offline_access"].includes(scope))) {
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
): Promise<
  | { ok: true; redirectUri: string }
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
  if (!params.get("code_challenge")) {
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

  return { ok: true, redirectUri };
}
