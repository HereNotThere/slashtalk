import { SessionPool } from "./session-pool.ts";
import { PresenceStore, type PresenceEvent } from "./presence.ts";
import { log } from "./server.ts";
import { extractBearer, loadAuthConfig, verifyToken, type AuthConfig } from "./auth.ts";
import {
  authorizationServerMetadata,
  handleAuthorize,
  handleGithubCallback,
  handleRegister,
  handleToken,
  protectedResourceMetadata,
} from "./mcp-oauth.ts";
import { handleElectronStart, tryHandleElectronCallback } from "./electron-auth.ts";
import { handleGithubAppCallback } from "./github-app-auth.ts";
import { installPage } from "./install-page.ts";
import {
  handleList as handleAgentSessionList,
  handleUpsert as handleAgentSessionUpsert,
} from "./agent-sessions.ts";

export type HttpOptions = {
  port: number;
  name: string;
  version: string;
};

export function runHttp(options: HttpOptions): {
  pool: SessionPool;
  presence: PresenceStore;
  auth: AuthConfig;
} {
  const auth = loadAuthConfig(options.port);
  const presence = new PresenceStore();
  const pool = new SessionPool({
    name: options.name,
    version: options.version,
    presence,
  });

  Bun.serve({
    port: options.port,
    // Disable the default 10s socket idle timeout. Our long-lived SSE streams
    // (both /mcp and /presence/stream) legitimately sit idle for long stretches
    // between events; Bun would otherwise kill the socket, which we'd see as
    // a stream_abort even though the client is still connected.
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const cors = buildCorsHeaders(req);

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors });
      }

      // Landing / install page
      if ((url.pathname === "/" || url.pathname === "/install") && req.method === "GET") {
        return withHeaders(installPage(auth.publicUrl), cors);
      }

      // OAuth discovery
      if (url.pathname === "/.well-known/oauth-protected-resource" && req.method === "GET") {
        if (!auth.enabled) return json({ error: "auth not configured" }, 501, cors);
        return withHeaders(protectedResourceMetadata(auth), cors);
      }
      if (url.pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
        if (!auth.enabled) return json({ error: "auth not configured" }, 501, cors);
        return withHeaders(authorizationServerMetadata(auth), cors);
      }

      // OAuth flow
      if (url.pathname === "/register" && req.method === "POST") {
        if (!auth.enabled) return json({ error: "auth not configured" }, 501, cors);
        return withHeaders(await handleRegister(req), cors);
      }
      if (url.pathname === "/authorize" && req.method === "GET") {
        if (!auth.enabled) return json({ error: "auth not configured" }, 501, cors);
        return withHeaders(handleAuthorize(auth, url), cors);
      }
      if (url.pathname === "/token" && req.method === "POST") {
        if (!auth.enabled) return json({ error: "auth not configured" }, 501, cors);
        return withHeaders(await handleToken(auth, req), cors);
      }
      if (url.pathname === "/auth/github/callback" && req.method === "GET") {
        if (!auth.enabled) return json({ error: "auth not configured" }, 501, cors);
        const electron = await tryHandleElectronCallback(auth, url);
        if (electron) return withHeaders(electron, cors);
        return withHeaders(await handleGithubCallback(auth, url), cors);
      }
      if (url.pathname === "/auth/electron/start" && req.method === "GET") {
        if (!auth.enabled) return json({ error: "auth not configured" }, 501, cors);
        return withHeaders(handleElectronStart(auth, url), cors);
      }
      // GitHub OAuth App callback relay — for desktop clients connecting their
      // GitHub account to a managed agent's vault. Doesn't require chatheads
      // auth to be enabled; it's purely a URL relay.
      if (url.pathname === "/auth/github-app/callback" && req.method === "GET") {
        return withHeaders(handleGithubAppCallback(url), cors);
      }

      // Debug / identity
      if (url.pathname === "/auth/whoami" && req.method === "GET") {
        const payload = auth.enabled ? verifyBearer(req, auth) : null;
        if (auth.enabled && !payload) {
          return withHeaders(
            json({ error: "unauthorized" }, 401, cors),
            { "www-authenticate": wwwAuthenticate(auth) },
          );
        }
        return json(
          payload
            ? { userId: payload.sub, login: payload.sub, name: payload.name, avatarUrl: payload.avatar }
            : { authDisabled: true },
          200,
          cors,
        );
      }

      // MCP — single endpoint, identity from token
      if (url.pathname === "/mcp") {
        let identity: { userId: string; profile?: { name?: string; avatar?: string; tz?: string } };
        if (auth.enabled) {
          const payload = verifyBearer(req, auth);
          if (!payload) {
            return withHeaders(
              json({ error: "unauthorized" }, 401, cors),
              { "www-authenticate": wwwAuthenticate(auth) },
            );
          }
          identity = {
            userId: payload.sub,
            profile: {
              name: payload.name,
              avatar: payload.avatar,
              tz: payload.tz,
            },
          };
        } else {
          // Auth-off dev fallback: allow a userId query param.
          identity = { userId: url.searchParams.get("userId") ?? "anonymous" };
        }
        const res = await pool.handleRequest(req, identity);
        return withHeaders(res, cors);
      }

      // Agent sessions (managed-agent pointer + summary upsert). Bearer-auth
      // per chatheadsAuth; identity comes from the token, never the body.
      if (url.pathname === "/v1/agent_sessions" && req.method === "PUT") {
        if (!auth.enabled) return json({ error: "auth not configured" }, 501, cors);
        const payload = verifyBearer(req, auth);
        if (!payload) {
          return withHeaders(
            json({ error: "unauthorized" }, 401, cors),
            { "www-authenticate": wwwAuthenticate(auth) },
          );
        }
        return withHeaders(
          await handleAgentSessionUpsert(req, payload.sub),
          cors,
        );
      }
      if (url.pathname === "/v1/agent_sessions" && req.method === "GET") {
        if (!auth.enabled) return json({ error: "auth not configured" }, 501, cors);
        const payload = verifyBearer(req, auth);
        if (!payload) {
          return withHeaders(
            json({ error: "unauthorized" }, 401, cors),
            { "www-authenticate": wwwAuthenticate(auth) },
          );
        }
        return withHeaders(
          await handleAgentSessionList(url, payload.sub),
          cors,
        );
      }

      // Presence
      if (url.pathname === "/presence" && req.method === "GET") {
        return json({ states: presence.snapshot() }, 200, cors);
      }
      if (url.pathname === "/presence/stream" && req.method === "GET") {
        return presenceStream(presence, cors);
      }
      if (url.pathname === "/healthz") {
        return json({ ok: true, sessions: pool.size(), authEnabled: auth.enabled }, 200, cors);
      }

      return new Response("Not Found", { status: 404, headers: cors });
    },
  });

  log("info", "ready", {
    transport: "http",
    port: options.port,
    authEnabled: auth.enabled,
    publicUrl: auth.publicUrl,
  });
  return { pool, presence, auth };
}

function verifyBearer(req: Request, auth: AuthConfig) {
  const token = extractBearer(req);
  if (!token) return null;
  return verifyToken(token, auth.tokenSecret);
}

function wwwAuthenticate(auth: AuthConfig): string {
  const metadataUrl = `${auth.publicUrl}/.well-known/oauth-protected-resource`;
  return `Bearer realm="mcp", resource_metadata="${metadataUrl}"`;
}

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers":
      "content-type, mcp-session-id, mcp-protocol-version, accept, authorization",
    "access-control-expose-headers": "mcp-session-id, www-authenticate",
  };
}

function json(body: unknown, status: number, extra: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

function withHeaders(res: Response, extra: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function presenceStream(
  presence: PresenceStore,
  cors: Record<string, string>,
): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {}
      };

      send("snapshot", { states: presence.snapshot() });

      const listener = (ev: PresenceEvent) => {
        send(ev.type, ev);
      };
      unsubscribe = presence.subscribe(listener);

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {}
      }, 5_000);
    },
    cancel() {
      if (unsubscribe) unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...cors,
    },
  });
}
