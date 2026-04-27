import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Database } from "../db";
import { createMcpServer, log } from "./server";
import type { ClientInfo, McpPresenceStore, UserProfile } from "./presence";

export type Identity = { userId: string; userDbId: number; profile?: UserProfile };

type Session = {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  userId: string;
};

export type SessionPoolOptions = {
  name: string;
  version: string;
  db: Database;
  presence: McpPresenceStore;
  maxSessionsPerUser?: number;
};

const DEFAULT_MAX_SESSIONS_PER_USER = 20;

export class McpSessionPool {
  private sessions = new Map<string, Session>();
  private maxSessionsPerUser: number;

  constructor(private opts: SessionPoolOptions) {
    this.maxSessionsPerUser = opts.maxSessionsPerUser ?? DEFAULT_MAX_SESSIONS_PER_USER;
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
      this.opts.presence.touch(existing.userId, sessionId);
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
      tools: {
        db: this.opts.db,
        userId: identity.userDbId,
      },
    });

    const { userId, profile } = identity;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid) => {
        this.sessions.set(sid, { server, transport, userId });
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
    for (const sid of [...this.sessions.keys()]) this.closeSession(sid, "shutdown");
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
    const clientInfo = body.method === "initialize" ? body.params?.clientInfo : undefined;
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
