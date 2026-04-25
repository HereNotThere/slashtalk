import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer, log } from "./server";
import type { ClientInfo, McpPresenceStore, UserProfile } from "./presence";

export type Identity = { userId: string; profile?: UserProfile };

type Session = {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  userId: string;
  lastActivity: number;
  activeStreams: number;
};

export type SessionPoolOptions = {
  name: string;
  version: string;
  presence: McpPresenceStore;
  idleTimeoutMs?: number;
  sweepIntervalMs?: number;
  maxSessionsPerUser?: number;
};

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_SWEEP_INTERVAL_MS = 5_000;
const DEFAULT_MAX_SESSIONS_PER_USER = 20;

export class McpSessionPool {
  private sessions = new Map<string, Session>();
  private sweeper: ReturnType<typeof setInterval>;
  private idleTimeoutMs: number;
  private maxSessionsPerUser: number;

  constructor(private opts: SessionPoolOptions) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxSessionsPerUser =
      opts.maxSessionsPerUser ?? DEFAULT_MAX_SESSIONS_PER_USER;
    const interval = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweeper = setInterval(() => this.sweepStale(), interval);
  }

  async handleRequest(req: Request, identity: Identity): Promise<Response> {
    const sessionId = req.headers.get("mcp-session-id") ?? undefined;

    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (!existing) {
        return jsonError("unknown_mcp_session", 404);
      }
      if (existing.userId !== identity.userId) {
        log("warn", "mcp_session_user_mismatch", {
          sessionId,
          expectedUserId: existing.userId,
          actualUserId: identity.userId,
        });
        return jsonError("unknown_mcp_session", 404);
      }
      existing.lastActivity = Date.now();
      this.opts.presence.touch(existing.userId, sessionId);
      if (req.method === "GET") this.watchForAbort(req, sessionId);
      return existing.transport.handleRequest(req);
    }

    if (this.countUserSessions(identity.userId) >= this.maxSessionsPerUser) {
      log("warn", "mcp_session_limit_exceeded", {
        userId: identity.userId,
        limit: this.maxSessionsPerUser,
      });
      return jsonError("mcp_session_limit_exceeded", 429);
    }

    const peeked = await peekInitializeBody(req);
    const clientInfo = peeked.clientInfo;

    const server = createMcpServer({
      name: this.opts.name,
      version: this.opts.version,
    });

    const { userId, profile } = identity;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid) => {
        this.sessions.set(sid, {
          server,
          transport,
          userId,
          lastActivity: Date.now(),
          activeStreams: 0,
        });
        this.opts.presence.online(userId, sid, clientInfo, profile);
        log("info", "mcp_session_opened", { sessionId: sid, userId, clientInfo });
      },
      onsessionclosed: (sid) => {
        this.closeSession(sid, "delete");
      },
    });

    await server.connect(transport);
    return transport.handleRequest(peeked.req, { parsedBody: peeked.parsedBody });
  }

  size(): number {
    return this.sessions.size;
  }

  shutdown(): void {
    clearInterval(this.sweeper);
  }

  private watchForAbort(req: Request, sessionId: string): void {
    const signal = req.signal;
    if (!signal || signal.aborted) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.activeStreams++;
    const onAbort = () => {
      const s = this.sessions.get(sessionId);
      if (s) s.activeStreams = Math.max(0, s.activeStreams - 1);
      this.closeSession(sessionId, "stream_abort");
    };
    signal.addEventListener("abort", onAbort, { once: true });
  }

  private countUserSessions(userId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId) count += 1;
    }
    return count;
  }

  private closeSession(sessionId: string, reason: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    this.opts.presence.offline(s.userId, sessionId);
    log("info", "mcp_session_closed", { sessionId, userId: s.userId, reason });
  }

  private sweepStale(): void {
    const cutoff = Date.now() - this.idleTimeoutMs;
    for (const [sid, s] of this.sessions) {
      if (s.activeStreams > 0) continue;
      if (s.lastActivity < cutoff) this.closeSession(sid, "idle_timeout");
    }
  }
}

async function peekInitializeBody(
  req: Request,
): Promise<{ req: Request; parsedBody?: unknown; clientInfo?: ClientInfo }> {
  if (req.method !== "POST") return { req };
  try {
    const clone = req.clone();
    const body = (await clone.json()) as {
      method?: string;
      params?: { clientInfo?: ClientInfo };
    };
    const clientInfo =
      body.method === "initialize" ? body.params?.clientInfo : undefined;
    return { req, parsedBody: body, clientInfo };
  } catch {
    return { req };
  }
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
