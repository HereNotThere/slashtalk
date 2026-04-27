import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer, log } from "./server.ts";
import type { ClientInfo, PresenceStore, UserProfile } from "./presence.ts";
import { registerDefaultTools } from "./tools.ts";

export type Identity = { userId: string; profile?: UserProfile };

type Session = {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  userId: string;
  lastActivity: number;
  // Count of in-flight long-lived requests (GET SSE streams). While >0, the
  // session is considered alive regardless of lastActivity — a held-open
  // stream doesn't keep generating new requests that would bump activity.
  activeStreams: number;
};

export type SessionPoolOptions = {
  name: string;
  version: string;
  presence: PresenceStore;
  idleTimeoutMs?: number;
  sweepIntervalMs?: number;
};

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_SWEEP_INTERVAL_MS = 5_000;

export class SessionPool {
  private sessions = new Map<string, Session>();
  private sweeper: ReturnType<typeof setInterval>;
  private idleTimeoutMs: number;

  constructor(private opts: SessionPoolOptions) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const interval = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweeper = setInterval(() => this.sweepStale(), interval);
  }

  async handleRequest(req: Request, identity: Identity): Promise<Response> {
    const sessionId = req.headers.get("mcp-session-id") ?? undefined;

    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing) {
        existing.lastActivity = Date.now();
        this.opts.presence.touch(existing.userId, sessionId);
        // GET with SSE accept = long-lived stream. Track it so we don't evict
        // while it's alive, and watch for abort to detect disconnect.
        if (req.method === "GET") this.watchForAbort(req, sessionId);
        return existing.transport.handleRequest(req);
      }
    }

    // New session. Peek at the initialize body to capture clientInfo.
    const peeked = await peekInitializeBody(req);
    const clientInfo = peeked.clientInfo;

    const server = createServer({ name: this.opts.name, version: this.opts.version });
    registerDefaultTools(server, {
      onWorkspace: (sid, roots) => {
        const s = this.sessions.get(sid);
        if (!s) return;
        this.opts.presence.setSessionRoots(s.userId, sid, roots);
      },
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
        log("info", "session_opened", { sessionId: sid, userId, clientInfo });
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

  private closeSession(sessionId: string, reason: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    this.opts.presence.offline(s.userId, sessionId);
    log("info", "session_closed", { sessionId, userId: s.userId, reason });
  }

  private sweepStale(): void {
    const cutoff = Date.now() - this.idleTimeoutMs;
    for (const [sid, s] of this.sessions) {
      // Active long-lived stream → session is alive by definition.
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
    const clientInfo = body.method === "initialize" ? body.params?.clientInfo : undefined;
    return { req, parsedBody: body, clientInfo };
  } catch {
    return { req };
  }
}
