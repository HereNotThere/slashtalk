// Long-lived WebSocket connection to the slashtalk backend.
//
// Subscribes the desktop to server-pushed events on the user's social graph —
// today, just `pr_activity` from the GitHub PR poller. The connection is
// opened on sign-in (or at cold start if creds were restored) and torn down
// on sign-out. Reconnects with capped exponential backoff.

import * as backend from "./backend";
import { createEmitter } from "./emitter";
import type { PrActivityMessage } from "@slashtalk/shared";

type ServerMessage =
  | PrActivityMessage
  | { type: "ping" }
  | { type: string; [k: string]: unknown };

const prActivity = createEmitter<PrActivityMessage>();
export const onPrActivity = prActivity.on;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let stopped = false;

const MAX_BACKOFF_MS = 30_000;

export function start(): void {
  stopped = false;
  attempt = 0;
  open();
}

export function stop(): void {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    try {
      socket.close(1000, "stop");
    } catch {
      // ignore
    }
    socket = null;
  }
}

function scheduleReconnect(): void {
  if (stopped) return;
  if (reconnectTimer) return;
  const backoff = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  attempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    open();
  }, backoff);
}

function open(): void {
  if (stopped) return;
  const jwt = backend.getJwt();
  if (!jwt) {
    // Not signed in yet; wait until start() is called again post-auth.
    return;
  }
  const url = wsUrl(jwt);
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.warn("[ws] construct failed:", (err as Error).message);
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.addEventListener("open", () => {
    attempt = 0;
    console.log("[ws] connected");
  });

  ws.addEventListener("message", (event) => {
    const data =
      typeof event.data === "string" ? event.data : event.data?.toString?.();
    if (!data) return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === "pr_activity") {
      prActivity.emit(msg as PrActivityMessage);
    }
    // Other types (ping, future) are ignored — connection liveness is handled
    // by the server's keepalive frames; we don't echo.
  });

  ws.addEventListener("close", (event) => {
    if (socket === ws) socket = null;
    console.log(`[ws] closed code=${event.code} reason=${event.reason || "-"}`);
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // 'close' will follow with backoff; nothing actionable here.
  });
}

function wsUrl(jwt: string): string {
  const base = backend.getBaseUrl();
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = (url.pathname.replace(/\/$/, "") + "/ws") || "/ws";
  url.searchParams.set("token", jwt);
  return url.toString();
}
