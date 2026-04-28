import { ipcMain, type BrowserWindow } from "electron";
import * as agentStore from "../agentStore";
import type { LocalAgent } from "../agentStore";
import * as anthropic from "../anthropic";
import * as localAgent from "../localAgent";
import * as agentIngest from "../agentIngest";
import * as summarize from "../summarize";
import { broadcast, liveWindows } from "../windows/broadcast";
import { getMainWindow } from "../windows/main";
import { getResponseWindow, showResponse } from "../windows/response";
import type {
  AgentHistoryPage,
  AgentSessionSummary,
  AgentStreamEvent,
  AgentSummary,
  CreateAgentInput,
  UpdateAgentInput,
} from "../../shared/types";

interface AgentsDeps {
  // Info window is owned by main/index.ts; agent stream events fan out to it
  // when an agent's session is being shown in the popover.
  getInfoWindow: () => BrowserWindow | null;
}

let deps: AgentsDeps | null = null;
function getDeps(): AgentsDeps {
  if (!deps) throw new Error("agents: configureAgents() must be called before use");
  return deps;
}

const streamingAgents = new Set<string>();
const pendingArchive = new Set<string>();
const PENDING_ARCHIVE_TTL_MS = 30_000;

export function toAgentSummary(a: LocalAgent): AgentSummary {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    systemPrompt: a.systemPrompt,
    model: a.model,
    createdAt: a.createdAt,
    mode: a.mode ?? "cloud",
    cwd: a.cwd,
    visibility: a.visibility ?? "private",
    mcpServers: a.mcpServers,
  };
}

function isLocalAgent(a: { mode?: "cloud" | "local" }): boolean {
  return a.mode === "local";
}

function truncateTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= 60 ? clean : clean.slice(0, 57) + "...";
}

function consumerWindows(): BrowserWindow[] {
  return liveWindows(getMainWindow(), getDeps().getInfoWindow(), getResponseWindow());
}

function emitSessionsChange(agentId: string): void {
  const sessions = agentStore.get(agentId)?.sessions ?? [];
  broadcast("agents:sessionsChange", { agentId, sessions }, ...consumerWindows());
}

function broadcastAgentEvent(event: AgentStreamEvent): void {
  broadcast("agents:event", event, ...consumerWindows());
}

async function refreshSessionsFromServer(agentId: string): Promise<void> {
  try {
    const server = await anthropic.listAgentSessions(agentId);
    const active = server.filter((s) => s.archivedAt == null && !pendingArchive.has(s.id));
    agentStore.reconcileSessions(
      agentId,
      active.map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        title: s.title ?? undefined,
      })),
    );
    emitSessionsChange(agentId);
  } catch (err) {
    console.warn("session reconcile failed:", err);
  }
}

async function finalizeTeamSession(
  agent: LocalAgent,
  sessionId: string,
  startedAtMs: number,
): Promise<void> {
  const endedAt = new Date().toISOString();
  const base = {
    agentId: agent.id,
    sessionId,
    mode: "cloud" as const,
    visibility: "team" as const,
    name: agent.name,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt,
    lastActivity: endedAt,
  };
  try {
    const { summary, model } = await summarize.summarizeCloudSession(sessionId);
    await agentIngest.upsertSession({
      ...base,
      summary,
      summaryModel: model,
      summaryTs: new Date().toISOString(),
    });
  } catch (err) {
    console.warn("[summarize] failed:", err);
    await agentIngest.upsertSession(base);
  }
}

export function configureAgents(d: AgentsDeps): void {
  deps = d;
}

export function registerAgents(): void {
  ipcMain.handle("agents:isConfigured", () => anthropic.isConfigured());
  ipcMain.handle("agents:setApiKey", async (_e, key: string): Promise<void> => {
    await anthropic.setApiKey(key);
  });
  ipcMain.handle("agents:clearApiKey", () => anthropic.clearApiKey());
  ipcMain.handle("agents:list", () => agentStore.list().map(toAgentSummary));

  ipcMain.handle("agents:create", async (_e, input: CreateAgentInput): Promise<AgentSummary> => {
    const visibility = input.visibility ?? "private";
    if (input.mode === "local") {
      const created = localAgent.createAgent(input);
      const row: LocalAgent = {
        id: created.id,
        name: created.name,
        description: created.description,
        systemPrompt: created.systemPrompt,
        model: created.model,
        createdAt: Date.now(),
        sessions: [],
        mode: "local",
        cwd: created.cwd,
        visibility,
        mcpServers: [],
      };
      agentStore.add(row);
      return toAgentSummary(row);
    }

    const created = await anthropic.createAgent({
      name: input.name,
      description: input.description,
      systemPrompt: input.systemPrompt,
      model: input.model,
      mcpServers: input.mcpServers,
    });
    const row: LocalAgent = {
      id: created.id,
      name: created.name,
      description: created.description,
      systemPrompt: created.systemPrompt,
      model: created.model,
      createdAt: Date.now(),
      sessions: [],
      mode: "cloud",
      visibility,
      mcpServers: input.mcpServers ?? [],
    };
    agentStore.add(row);
    return toAgentSummary(row);
  });

  ipcMain.handle(
    "agents:update",
    async (_e, id: string, input: UpdateAgentInput): Promise<AgentSummary> => {
      const existing = agentStore.get(id);
      if (!existing) throw new Error("Unknown agent");

      const name = input.name.trim();
      const systemPrompt = input.systemPrompt.trim();
      if (!name) throw new Error("Agent name is required.");
      if (!systemPrompt) throw new Error("Agent prompt is required.");

      const patch = {
        name,
        description: input.description?.trim() || undefined,
        systemPrompt,
        model: input.model?.trim() || existing.model,
        cwd: isLocalAgent(existing) ? input.cwd?.trim() || undefined : existing.cwd,
        visibility: input.visibility ?? existing.visibility ?? "private",
        mcpServers: isLocalAgent(existing)
          ? existing.mcpServers
          : (input.mcpServers ?? existing.mcpServers ?? []),
      };

      if (!isLocalAgent(existing)) {
        const updated = await anthropic.updateAgent(id, {
          name: patch.name,
          description: patch.description,
          systemPrompt: patch.systemPrompt,
          model: patch.model,
          mcpServers: patch.mcpServers,
        });
        const row = agentStore.update(id, {
          ...patch,
          name: updated.name,
          description: updated.description,
          systemPrompt: updated.systemPrompt,
          model: updated.model,
        });
        if (!row) throw new Error("Unknown agent");
        return toAgentSummary(row);
      }

      const row = agentStore.update(id, patch);
      if (!row) throw new Error("Unknown agent");
      return toAgentSummary(row);
    },
  );

  ipcMain.handle("agents:remove", async (_e, id: string): Promise<void> => {
    const row = agentStore.get(id);
    if (row && isLocalAgent(row)) {
      for (const s of row.sessions) localAgent.archiveSession(s.id);
    } else {
      try {
        await anthropic.archiveAgent(id);
      } catch (err) {
        console.warn("archive agent failed (continuing):", err);
      }
    }
    streamingAgents.delete(id);
    agentStore.remove(id);
  });

  ipcMain.handle(
    "agents:history",
    async (
      _e,
      agentId: string,
      sessionId?: string | null,
      cursor?: string | null,
    ): Promise<AgentHistoryPage> => {
      const row = agentStore.get(agentId);
      const targetSessionId = sessionId ?? row?.activeSessionId;
      if (!row || !targetSessionId) return { msgs: [], nextCursor: null };
      if (isLocalAgent(row)) {
        return localAgent.loadSessionMessages(targetSessionId, cursor);
      }
      try {
        return await anthropic.loadSessionMessages(targetSessionId, cursor);
      } catch (err) {
        console.warn("history load failed:", err);
        return { msgs: [], nextCursor: null };
      }
    },
  );

  ipcMain.handle(
    "agents:send",
    async (_e, agentId: string, text: string, requestedSessionId?: string | null) => {
      const row = agentStore.get(agentId);
      if (!row) throw new Error("Unknown agent");
      streamingAgents.add(agentId);
      try {
        let sessionId = requestedSessionId ?? row.activeSessionId;
        if (!sessionId) {
          sessionId = isLocalAgent(row)
            ? localAgent.localSessionId()
            : (await anthropic.startSession(agentId)).sessionId;
          const createdAt = Date.now();
          agentStore.addSession(agentId, { id: sessionId, createdAt });
          agentIngest.upsertSessionStart(row, sessionId, createdAt);
          emitSessionsChange(agentId);
        } else if (requestedSessionId) {
          agentStore.setActiveSession(agentId, requestedSessionId);
        }

        const latestRow = agentStore.get(agentId) ?? row;
        const session = latestRow.sessions.find((s) => s.id === sessionId);
        if (session && !session.title) {
          const title = truncateTitle(text);
          agentStore.setSessionTitle(agentId, sessionId, title);
          emitSessionsChange(agentId);
          if (!isLocalAgent(row)) {
            anthropic.updateSessionTitle(sessionId, title).catch((err) => {
              console.warn("server title update failed:", err);
            });
          }
        }

        const streamSessionId = sessionId;
        const handleEvent = (e: anthropic.AgentStreamEvent): void => {
          const payload: AgentStreamEvent = { ...e, agentId };
          broadcastAgentEvent(payload);
          if (e.kind === "usage") {
            agentStore.addSessionUsage(agentId, streamSessionId, {
              input: e.input,
              output: e.output,
            });
            emitSessionsChange(agentId);
          }
          if (e.kind === "done" || e.kind === "error") {
            streamingAgents.delete(agentId);
          }
        };

        if (isLocalAgent(row)) {
          void localAgent.sendMessage(streamSessionId, text, row, handleEvent, () =>
            emitSessionsChange(agentId),
          );
        } else {
          void anthropic.sendMessage(streamSessionId, text, handleEvent);
        }
      } catch (err) {
        streamingAgents.delete(agentId);
        throw err;
      }
    },
  );

  ipcMain.handle("agents:listSessions", (_e, agentId: string): AgentSessionSummary[] => {
    const row = agentStore.get(agentId);
    if (row && !isLocalAgent(row)) void refreshSessionsFromServer(agentId);
    return row?.sessions ?? [];
  });

  ipcMain.handle("agents:popOut", (_e, agentId: string, sessionId: string): void => {
    agentStore.setActiveSession(agentId, sessionId);
    showResponse({ kind: "agent", agentId, sessionId });
  });

  ipcMain.handle(
    "agents:removeSession",
    async (_e, agentId: string, sessionId: string): Promise<void> => {
      const row = agentStore.get(agentId);
      if (row && isLocalAgent(row)) {
        agentStore.removeSession(agentId, sessionId);
        emitSessionsChange(agentId);
        localAgent.archiveSession(sessionId);
        return;
      }

      pendingArchive.add(sessionId);
      setTimeout(() => pendingArchive.delete(sessionId), PENDING_ARCHIVE_TTL_MS);

      const isTeamCloud = !!row && (row.visibility ?? "private") === "team";
      const startedAtMs = row?.sessions.find((s) => s.id === sessionId)?.createdAt ?? Date.now();
      const agentSnapshot = row;

      agentStore.removeSession(agentId, sessionId);
      emitSessionsChange(agentId);

      try {
        await anthropic.archiveSession(sessionId);
      } catch (err) {
        console.warn("archive session failed (continuing):", err);
      }

      if (isTeamCloud && agentSnapshot) {
        void finalizeTeamSession(agentSnapshot, sessionId, startedAtMs);
      }
    },
  );

  ipcMain.handle("agents:newSession", async (_e, agentId: string): Promise<AgentSessionSummary> => {
    const row = agentStore.get(agentId);
    if (!row) throw new Error("Unknown agent");
    const id = isLocalAgent(row)
      ? localAgent.localSessionId()
      : (await anthropic.startSession(agentId)).sessionId;
    const session: AgentSessionSummary = { id, createdAt: Date.now() };
    agentStore.addSession(agentId, session);
    agentIngest.upsertSessionStart(row, id, session.createdAt);
    emitSessionsChange(agentId);
    return session;
  });

  ipcMain.handle("agents:selectSession", (_e, agentId: string, sessionId: string): void => {
    agentStore.setActiveSession(agentId, sessionId);
    emitSessionsChange(agentId);
  });

  ipcMain.handle(
    "agents:ensureSessionUsage",
    async (_e, agentId: string, sessionId: string): Promise<void> => {
      const row = agentStore.get(agentId);
      const session = row?.sessions.find((s) => s.id === sessionId);
      if (!row || !session || session.tokens) return;
      if (isLocalAgent(row)) return;
      try {
        const total = await anthropic.sumSessionUsage(sessionId);
        agentStore.setSessionUsage(agentId, sessionId, total);
        emitSessionsChange(agentId);
      } catch (err) {
        console.warn("backfill usage failed:", err);
      }
    },
  );

  ipcMain.handle("agentSessions:forAgent", async (_e, agentId: string) =>
    agentIngest.listForAgent(agentId),
  );

  // List-change push. Mirrors the agent store into the main window so the
  // chat-heads / agent picker UIs reflect creates, updates, removes without
  // each consumer needing its own polling.
  agentStore.onChange((agents) =>
    broadcast("agents:listChange", agents.map(toAgentSummary), getMainWindow()),
  );
}
