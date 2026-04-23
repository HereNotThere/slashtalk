// Per-session conversation transcript store for local (Claude Agent SDK)
// agents. Cloud agents load history from Anthropic's session events API; local
// agents have no server-side log, so we keep an append-only AgentMsg[] on
// disk, keyed by session id. Persisted at the end of each completed turn.

import * as store from "./store";
import type { AgentMsg } from "../shared/types";

const PREFIX = "localAgent.transcript:";

function key(sessionId: string): string {
  return `${PREFIX}${sessionId}`;
}

export function load(sessionId: string): AgentMsg[] {
  return store.get<AgentMsg[]>(key(sessionId)) ?? [];
}

export function save(sessionId: string, msgs: AgentMsg[]): void {
  store.set(key(sessionId), msgs);
}

export function clear(sessionId: string): void {
  store.del(key(sessionId));
}
