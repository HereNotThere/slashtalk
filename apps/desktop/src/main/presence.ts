// SSE subscription to the Chatheads presence stream. Maintains an in-memory
// map of online users and emits snapshots on every change. Auto-reconnects
// with backoff on disconnect.

import { createEmitter } from "./emitter";

export interface ClientInfo {
  name?: string;
  version?: string;
}

export interface PresenceUser {
  userId: string;
  connectedAt: number;
  lastActivity: number;
  clientInfo?: ClientInfo;
  sessionCount: number;
  name?: string;
  avatar?: string;
}

const DEFAULT_URL =
  process.env["CHATHEADS_PRESENCE_URL"] ??
  "https://chatheads.onrender.com/presence/stream";

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

const changes = createEmitter<PresenceUser[]>();
const current = new Map<string, PresenceUser>();

let controller: AbortController | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RECONNECT_MIN_MS;
let running = false;
let url = DEFAULT_URL;

export const onChange = changes.on;

export function snapshot(): PresenceUser[] {
  return [...current.values()];
}

export function start(streamUrl: string = DEFAULT_URL): void {
  url = streamUrl;
  if (running) return;
  running = true;
  void connect();
}

export function stop(): void {
  running = false;
  controller?.abort();
  controller = null;
  if (retry) clearTimeout(retry);
  retry = null;
  current.clear();
  changes.emit(snapshot());
}

async function connect(): Promise<void> {
  if (!running) return;
  controller = new AbortController();

  try {
    const res = await fetch(url, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`presence stream HTTP ${res.status}`);
    }
    retryDelay = RECONNECT_MIN_MS;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (running) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        processEvent(rawEvent);
      }
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    console.error("[presence] stream error:", err);
  }

  if (!running) return;
  // Clear visible state on disconnect; snapshot will repopulate on reconnect.
  if (current.size > 0) {
    current.clear();
    changes.emit(snapshot());
  }
  retry = setTimeout(connect, retryDelay);
  retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX_MS);
}

function processEvent(raw: string): void {
  let event = "message";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // SSE comment (keep-alive)
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (!data) return;

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }

  switch (event) {
    case "snapshot": {
      const states = (payload as { states: PresenceUser[] }).states ?? [];
      current.clear();
      for (const s of states) current.set(s.userId, s);
      break;
    }
    case "online": {
      const p = payload as PresenceUser & { type: string };
      current.set(p.userId, {
        userId: p.userId,
        connectedAt: p.connectedAt,
        lastActivity: p.connectedAt,
        clientInfo: p.clientInfo,
        sessionCount: 1,
        name: p.name,
        avatar: p.avatar,
      });
      break;
    }
    case "offline": {
      const { userId } = payload as { userId: string };
      current.delete(userId);
      break;
    }
    case "activity": {
      const { userId, lastActivity } = payload as {
        userId: string;
        lastActivity: number;
      };
      const s = current.get(userId);
      if (s) s.lastActivity = lastActivity;
      break;
    }
    default:
      return;
  }

  changes.emit(snapshot());
}
