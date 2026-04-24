// Posts managed-agent session pointers + summaries to the Slashtalk MCP backend.
// One function, one endpoint (PUT /v1/agent_sessions). Callers gate on agent
// visibility before invoking — private agents never reach this module. Soft-
// fails on network/auth errors so a missing backend never blocks local agent
// usage.

import type { AgentSessionRow } from "@slashtalk/shared";
import * as chatheadsAuth from "./chatheadsAuth";
import type { LocalAgent } from "./agentStore";

let loggedUnauthorized = false;

const BAKED_MCP_BASE_URL = import.meta.env
  .MAIN_VITE_SLASHTALK_MCP_BASE_URL as string | undefined;
const DEFAULT_MCP_BASE_URL = "https://chatheads.onrender.com";

function baseUrl(): string {
  return (
    process.env["SLASHTALK_MCP_BASE_URL"] ??
    BAKED_MCP_BASE_URL ??
    DEFAULT_MCP_BASE_URL
  );
}

function logUnauthorizedOnce(): void {
  if (loggedUnauthorized) return;
  loggedUnauthorized = true;
  console.warn(
    "[agentIngest] MCP rejected the current apiKey; check that SLASHTALK_MCP_BASE_URL points at the same environment as SLASHTALK_API_URL",
  );
}

export interface UpsertSessionPayload {
  agent_id: string;
  session_id: string;
  mode: "cloud" | "local";
  visibility: "private" | "team";
  name?: string;
  started_at: string;
  ended_at?: string;
  last_activity?: string;
  summary?: string;
  summary_model?: string;
  summary_ts?: string;
}

export async function upsertSession(p: UpsertSessionPayload): Promise<void> {
  const token = chatheadsAuth.getToken();
  const base = baseUrl();
  if (!token) {
    // Not signed into the Slashtalk backend yet. Skip silently — teammates
    // can't see any ingest anyway, and the agent still runs locally.
    return;
  }
  try {
    const res = await fetch(`${base}/v1/agent_sessions`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(p),
    });
    if (!res.ok) {
      if (res.status === 401) {
        logUnauthorizedOnce();
        return;
      }
      const preview = await res.text().catch(() => "");
      console.warn(
        `[agentIngest] upsert ${res.status}: ${preview.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn("[agentIngest] upsert failed:", err);
  }
}

/** GET /v1/agent_sessions. Empty array on any failure — the info panel
 *  treats this as "no agent activity" which is the right fallback for
 *  network hiccups / unsigned-in state. */
async function listSessions(params: {
  userLogin?: string;
  agentId?: string;
}): Promise<AgentSessionRow[]> {
  const token = chatheadsAuth.getToken();
  if (!token) return [];
  const base = baseUrl();
  try {
    const url = new URL(`${base}/v1/agent_sessions`);
    if (params.userLogin) url.searchParams.set("user_login", params.userLogin);
    if (params.agentId) url.searchParams.set("agent_id", params.agentId);
    const res = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      if (res.status === 401) {
        logUnauthorizedOnce();
        return [];
      }
      const preview = await res.text().catch(() => "");
      console.warn(
        `[agentIngest] list ${res.status}: ${preview.slice(0, 200)}`,
      );
      return [];
    }
    const body = (await res.json()) as { sessions?: AgentSessionRow[] };
    return body.sessions ?? [];
  } catch (err) {
    console.warn("[agentIngest] list failed:", err);
    return [];
  }
}

export function listForUser(userLogin: string): Promise<AgentSessionRow[]> {
  return listSessions({ userLogin });
}

export function listForAgent(agentId: string): Promise<AgentSessionRow[]> {
  return listSessions({ agentId });
}

/** Convenience: caller has a LocalAgent row + a freshly-minted session id.
 *  No-op for private agents or local agents (local ingest is follow-up work).
 *  Safe to call from a non-async context via `void`. */
export function upsertSessionStart(
  agent: LocalAgent,
  sessionId: string,
  startedAtMs: number,
): void {
  if ((agent.visibility ?? "private") !== "team") return;
  if (agent.mode === "local") return; // local-ingest is a later commit
  void upsertSession({
    agent_id: agent.id,
    session_id: sessionId,
    mode: "cloud",
    visibility: "team",
    name: agent.name,
    started_at: new Date(startedAtMs).toISOString(),
    last_activity: new Date().toISOString(),
  });
}
