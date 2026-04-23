// WebSocket client for the slashtalk backend. Lives in the main process so the
// JWT never leaves it. The server forwards any Redis pub/sub frame on the
// user's subscribed channels (repo:<id> for every user_repos row, plus
// user:<id>) directly to this connection. We route incoming frames by `type`
// via a simple emitter; renderers don't have direct WS access.

import WebSocket from "ws";
import { createEmitter } from "./emitter";

export interface WsMessage {
  type: string;
  [k: string]: unknown;
}

const messages = createEmitter<WsMessage>();
export const onMessage = messages.on;

let ws: WebSocket | null = null;
let currentUrl: string | null = null;
let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let wantConnected = false;

function redactToken(url: string): string {
  return url.replace(/token=[^&]+/, "token=***");
}

function scheduleReconnect(): void {
  if (!wantConnected || !currentUrl) return;
  if (reconnectTimer) return;
  // 1s, 2s, 4s, 8s, … capped at 30s
  const delay = Math.min(30_000, 1000 * Math.pow(2, reconnectAttempt));
  reconnectAttempt++;
  console.log(`[ws] reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNow();
  }, delay);
}

function connectNow(): void {
  if (!wantConnected || !currentUrl) return;
  console.log(`[ws] connecting to ${redactToken(currentUrl)}`);
  const sock = new WebSocket(currentUrl);
  ws = sock;

  sock.on("open", () => {
    reconnectAttempt = 0;
    console.log("[ws] connected");
  });

  sock.on("message", (data) => {
    let msg: WsMessage;
    try {
      msg = JSON.parse(data.toString()) as WsMessage;
    } catch (e) {
      console.warn(`[ws] bad frame: ${(e as Error).message}`);
      return;
    }
    if (msg.type === "ping") return; // server keepalive
    console.log(`[ws] ← ${msg.type}`, msg);
    messages.emit(msg);
  });

  sock.on("close", (code, reason) => {
    const r = reason?.toString?.() || "";
    console.log(`[ws] closed code=${code}${r ? ` reason=${r}` : ""}`);
    if (ws === sock) ws = null;
    if (code === 4001) {
      // Server rejected auth — don't reconnect in a loop until creds change.
      console.warn("[ws] unauthorized — halting reconnect until next sign-in");
      wantConnected = false;
      return;
    }
    scheduleReconnect();
  });

  sock.on("error", (err) => {
    console.warn(`[ws] error: ${err.message}`);
    // 'close' follows automatically; let it handle reconnect scheduling.
  });
}

export function connect(baseHttpUrl: string, token: string): void {
  const wsUrl = baseHttpUrl.replace(/^http/, "ws");
  const nextUrl = `${wsUrl}/ws?token=${encodeURIComponent(token)}`;
  if (currentUrl === nextUrl && ws && ws.readyState === WebSocket.OPEN) {
    return; // already connected with the same creds
  }
  currentUrl = nextUrl;
  wantConnected = true;
  reconnectAttempt = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close(1000, "reconnect");
    } catch {
      /* noop */
    }
    ws = null;
  }
  connectNow();
}

export function disconnect(): void {
  wantConnected = false;
  currentUrl = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close(1000, "client signed out");
    } catch {
      /* noop */
    }
    ws = null;
  }
  console.log("[ws] disconnected");
}

export function isConnected(): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN;
}
