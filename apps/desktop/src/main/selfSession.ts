// Keeps a persistent MCP client session open to the Slashtalk MCP backend while
// the user is signed into chatheadsAuth. The backend's SessionPool already
// tracks online/offline/activity per MCP session (session-pool.ts:81,119),
// so nothing server-side needs to change — just by holding this stream open,
// the user shows as online in PresenceStore and their own head lights up the
// green dot in the dock. Signal represents "the desktop app is open",
// independent of whether Claude Code is also running.
//
// Reconnect uses exponential backoff capped at 30s. Disconnect detection is
// server-side via SSE abort (session-pool.ts:101) + client-side via the
// transport's onclose callback.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as chatheadsAuth from "./chatheadsAuth";

const MCP_URL =
  process.env["SLASHTALK_MCP_URL"] ?? "http://localhost:3000/mcp";
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let client: Client | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
let running = false;
let unsubAuth: (() => void) | null = null;

async function connect(): Promise<void> {
  if (!running) return;
  if (client) return; // already connected
  const token = chatheadsAuth.getToken();
  if (!token) return;

  try {
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: {
        headers: { authorization: `Bearer ${token}` },
      },
    });
    transport.onclose = () => {
      if (!running) return;
      client = null;
      scheduleReconnect();
    };
    transport.onerror = (err) => {
      const name = (err as Error)?.name;
      // AbortError: we close() on sign-out — the SSE stream is intentionally
      // aborted. Not a real error.
      if (name === "AbortError") return;
      // UND_ERR_SOCKET / "other side closed" / "fetch failed": an upstream
      // proxy (ngrok, Render's edge) rotated or idle-timed out our long-
      // lived SSE stream. The SDK reconnects automatically. Logging every
      // rotation spams the console, so suppress.
      const cause = (err as { cause?: { code?: string } } | null)?.cause;
      if (cause?.code === "UND_ERR_SOCKET") return;
      if ((err as Error)?.message === "fetch failed") return;
      console.error("[selfSession] transport error:", err);
    };
    const c = new Client({ name: "slashtalk-desktop", version: "0.0.1" });
    await c.connect(transport);
    client = c;
    reconnectDelay = RECONNECT_MIN_MS;
    console.log("[selfSession] connected", { sessionId: transport.sessionId });
  } catch (err) {
    console.error("[selfSession] connect failed:", err);
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (!running) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

async function disconnect(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectDelay = RECONNECT_MIN_MS;
  const c = client;
  client = null;
  try {
    await c?.close();
  } catch (err) {
    console.error("[selfSession] close failed:", err);
  }
}

export function start(): void {
  if (running) return;
  running = true;
  unsubAuth = chatheadsAuth.onChange((state) => {
    if (state.signedIn) void connect();
    else void disconnect();
  });
  if (chatheadsAuth.getAuthState().signedIn) void connect();
}

export async function stop(): Promise<void> {
  running = false;
  unsubAuth?.();
  unsubAuth = null;
  await disconnect();
}
