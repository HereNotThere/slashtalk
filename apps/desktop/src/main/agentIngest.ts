// Posts managed-agent session pointers + summaries to the Slashtalk backend.
// One function, one endpoint (PUT /v1/managed-agent-sessions). Callers gate on agent
// visibility before invoking — private agents never reach this module. Soft-
// fails on network/auth errors so a missing backend never blocks local agent
// usage.

import type { ManagedAgentSessionRow } from "@slashtalk/shared";
import * as chatheadsAuth from "./chatheadsAuth";
import * as backend from "./backend";
import type { LocalAgent } from "./agentStore";

let loggedUnauthorized = false;

const BAKED_MCP_BASE_URL = import.meta.env
  .MAIN_VITE_SLASHTALK_MCP_BASE_URL as string | undefined;

function baseUrl(): string {
  return (
    process.env["SLASHTALK_MCP_BASE_URL"] ??
    BAKED_MCP_BASE_URL ??
    backend.getBaseUrl()
  );
}

function logUnauthorizedOnce(): void {
  if (loggedUnauthorized) return;
  loggedUnauthorized = true;
  console.warn(
    "[agentIngest] server rejected the current apiKey; check that SLASHTALK_MCP_BASE_URL points at the same environment as SLASHTALK_API_URL",
  );
}

export interface UpsertSessionPayload {
  agentId: string;
  sessionId: string;
  mode: "cloud" | "local";
  visibility: "private" | "team";
  name?: string;
  startedAt: string;
  endedAt?: string;
  lastActivity?: string;
  summary?: string;
  summaryModel?: string;
  summaryTs?: string;
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
    const res = await fetch(`${base}/v1/managed-agent-sessions`, {
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

/** GET /v1/managed-agent-sessions. Empty array on any failure — the info panel
 *  treats this as "no agent activity" which is the right fallback for
 *  network hiccups / unsigned-in state. */
async function listSessions(params: {
  userLogin?: string;
  agentId?: string;
}): Promise<ManagedAgentSessionRow[]> {
  const token = chatheadsAuth.getToken();
  if (!token) return [];
  const base = baseUrl();
  try {
    const url = new URL(`${base}/v1/managed-agent-sessions`);
    if (params.userLogin) url.searchParams.set("userLogin", params.userLogin);
    if (params.agentId) url.searchParams.set("agentId", params.agentId);
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
    const body = (await res.json()) as { sessions?: ManagedAgentSessionRow[] };
    return body.sessions ?? [];
  } catch (err) {
    console.warn("[agentIngest] list failed:", err);
    return [];
  }
}

export function listForUser(userLogin: string): Promise<ManagedAgentSessionRow[]> {
  return listSessions({ userLogin });
}

export function listForAgent(agentId: string): Promise<ManagedAgentSessionRow[]> {
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
    agentId: agent.id,
    sessionId,
    mode: "cloud",
    visibility: "team",
    name: agent.name,
    startedAt: new Date(startedAtMs).toISOString(),
    lastActivity: new Date().toISOString(),
  });
}
