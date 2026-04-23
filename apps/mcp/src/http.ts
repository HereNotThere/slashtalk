import { SessionPool } from "./session-pool.ts";
import { PresenceStore, type PresenceEvent } from "./presence.ts";
import { log } from "./server.ts";
import {
  extractBearer,
  verifyApiKey,
  type ApiKeyIdentity,
} from "./api-key-auth.ts";
import { installPage } from "./install-page.ts";
import {
  handleList as handleAgentSessionList,
  handleUpsert as handleAgentSessionUpsert,
} from "./agent-sessions.ts";

export type HttpOptions = {
  port: number;
  name: string;
  version: string;
  /** Public URL used for the install page's copy-pasteable snippets. */
  publicUrl?: string;
};

export function runHttp(options: HttpOptions): {
  pool: SessionPool;
  presence: PresenceStore;
} {
  const publicUrl =
    options.publicUrl ?? process.env["PUBLIC_URL"] ?? `http://localhost:${options.port}`;
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

      // Landing / install page.
      if ((url.pathname === "/" || url.pathname === "/install") && req.method === "GET") {
        return withHeaders(installPage(publicUrl), cors);
      }

      // Debug / identity probe.
      if (url.pathname === "/auth/whoami" && req.method === "GET") {
        const identity = await resolveIdentity(req);
        if (!identity) return withHeaders(unauthorized(cors), cors);
        return json(
          {
            userId: identity.userLogin,
            login: identity.userLogin,
            userDbId: identity.userId,
            deviceId: identity.deviceId,
            name: identity.profile?.name,
            avatarUrl: identity.profile?.avatar,
          },
          200,
          cors,
        );
      }

      // MCP — identity from slashtalk-issued api key.
      if (url.pathname === "/mcp") {
        const identity = await resolveIdentity(req);
        if (!identity) return withHeaders(unauthorized(cors), cors);
        const res = await pool.handleRequest(req, {
          userId: identity.userLogin,
          profile: identity.profile,
        });
        return withHeaders(res, cors);
      }

      // Agent sessions — managed-agent pointer + summary upsert / list.
      if (url.pathname === "/v1/agent_sessions") {
        const identity = await resolveIdentity(req);
        if (!identity) return withHeaders(unauthorized(cors), cors);
        if (req.method === "PUT") {
          return withHeaders(
            await handleAgentSessionUpsert(req, identity.userLogin),
            cors,
          );
        }
        if (req.method === "GET") {
          return withHeaders(
            await handleAgentSessionList(url, identity.userLogin),
            cors,
          );
        }
      }

      // Presence.
      if (url.pathname === "/presence" && req.method === "GET") {
        return json({ states: presence.snapshot() }, 200, cors);
      }
      if (url.pathname === "/presence/stream" && req.method === "GET") {
        return presenceStream(presence, cors);
      }
      if (url.pathname === "/healthz") {
        return json({ ok: true, sessions: pool.size() }, 200, cors);
      }

      return new Response("Not Found", { status: 404, headers: cors });
    },
  });

  log("info", "ready", {
    transport: "http",
    port: options.port,
    publicUrl,
  });
  return { pool, presence };
}

async function resolveIdentity(req: Request): Promise<ApiKeyIdentity | null> {
  const token = extractBearer(req);
  if (!token) return null;
  return verifyApiKey(token);
}

function unauthorized(cors: Record<string, string>): Response {
  return json(
    { error: "unauthorized" },
    401,
    { ...cors, "www-authenticate": 'Bearer realm="slashtalk-mcp"' },
  );
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
