// Anthropic Managed Agents integration.
//
// The API key comes from one of two sources, in order: (1) a user-supplied key
// persisted via safeStore (OS keychain-encrypted), set through the Agents
// settings UI; (2) the ANTHROPIC_API_KEY env var (dev convenience). The env
// var is the final fallback — it never wins over a stored key, so clearing
// the stored key in the UI also restores the env-var behavior.
//
// We lazily provision a single Environment and a single Vault per install.
// The vault holds a `static_bearer` credential pointing at our Slashtalk MCP
// server, seeded with the user's current Slashtalk apiKey — so any agent they
// create automatically has access to the Slashtalk MCP tool list.

import Anthropic from "@anthropic-ai/sdk";
import * as store from "./store";
import * as chatheadsAuth from "./chatheadsAuth";
import * as backend from "./backend";
import * as githubAuth from "./githubDeviceAuth";
import { saveEncrypted, loadEncrypted, clearEncrypted } from "./safeStore";
import { createEmitter } from "./emitter";
import type { AgentHistoryPage, AgentMsg, AssistantBlock, McpServerInput } from "../shared/types";

const ENV_KEY = "anthropic.environmentId";
const VAULT_KEY = "anthropic.vaultId";
const API_KEY_STORE_KEY = "anthropic.apiKeyEnc";

const BAKED_MCP_URL = import.meta.env.MAIN_VITE_SLASHTALK_MCP_URL as string | undefined;
const SLASHTALK_MCP_NAME = "slashtalk-mcp";

const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
const SLASHTALK_CRED_ID_KEY = "anthropic.slashtalkCredentialId";
const GITHUB_CRED_ID_KEY = "anthropic.githubCredentialId";

let cachedClient: Anthropic | null = null;
let storedApiKey: string | null = null;

const configuredChanges = createEmitter<boolean>();
export const onConfiguredChange = configuredChanges.on;

function slashtalkMcpUrl(): string {
  return process.env["SLASHTALK_MCP_URL"] ?? BAKED_MCP_URL ?? `${backend.getBaseUrl()}/mcp`;
}

/** Load the persisted API key on startup. Must run before any UI asks
 *  isConfigured(). */
export function restore(): void {
  storedApiKey = loadEncrypted<string>(API_KEY_STORE_KEY);
}

function apiKey(): string | null {
  return storedApiKey ?? process.env["ANTHROPIC_API_KEY"] ?? null;
}

export function isConfigured(): boolean {
  return apiKey() !== null;
}

/** Validate a candidate key against the API, then persist it. Throws with a
 *  user-facing message on failure; the caller should surface it inline. */
export async function setApiKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is empty.");

  const probe = new Anthropic({ apiKey: trimmed });
  try {
    await probe.models.list({ limit: 1 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Key rejected by Anthropic API: ${msg}`);
  }

  const wasConfigured = isConfigured();
  saveEncrypted(API_KEY_STORE_KEY, trimmed);
  storedApiKey = trimmed;
  cachedClient = null;
  if (!wasConfigured) configuredChanges.emit(true);
}

/** Forget the stored key. If ANTHROPIC_API_KEY is set in env, the app stays
 *  configured via that fallback. */
export function clearApiKey(): void {
  const wasConfigured = isConfigured();
  clearEncrypted(API_KEY_STORE_KEY);
  storedApiKey = null;
  cachedClient = null;
  const nowConfigured = isConfigured();
  if (wasConfigured !== nowConfigured) configuredChanges.emit(nowConfigured);
}

function client(): Anthropic {
  if (cachedClient) return cachedClient;
  const key = apiKey();
  if (!key) {
    throw new Error("Anthropic API key is not set; configure one in the Agents panel.");
  }
  cachedClient = new Anthropic({ apiKey: key });
  return cachedClient;
}

/** Narrow escape hatch so sibling modules (e.g. summarize.ts) can call
 *  Messages + Managed Agents endpoints without re-implementing key handling. */
export function getClient(): Anthropic {
  return client();
}

async function ensureEnvironment(): Promise<string> {
  const cached = store.get<string>(ENV_KEY);
  if (cached) {
    try {
      await client().beta.environments.retrieve(cached);
      return cached;
    } catch {
      // Stale cache (deleted upstream). Fall through to recreate.
    }
  }
  const env = await client().beta.environments.create({
    name: "slashtalk-desktop",
    config: {
      type: "cloud",
      networking: { type: "unrestricted" },
    },
  });
  store.set(ENV_KEY, env.id);
  return env.id;
}

async function ensureVault(): Promise<string | null> {
  // Skip vault creation entirely if there are no credentials to put in it.
  const hasSlashtalk = chatheadsAuth.getToken() !== null;
  const hasGithub = githubAuth.getCreds() !== null;
  if (!hasSlashtalk && !hasGithub) return null;

  const cached = store.get<string>(VAULT_KEY);
  if (cached) {
    try {
      await client().beta.vaults.retrieve(cached);
      await ensureAllCredentials(cached);
      return cached;
    } catch {
      store.set(VAULT_KEY, null);
    }
  }

  const vault = await client().beta.vaults.create({
    display_name: "slashtalk-mcp",
  });
  store.set(VAULT_KEY, vault.id);
  await ensureAllCredentials(vault.id);
  return vault.id;
}

async function ensureAllCredentials(vaultId: string): Promise<void> {
  await Promise.allSettled([ensureSlashtalkCredential(vaultId), ensureGithubCredential(vaultId)]);
}

async function ensureSlashtalkCredential(vaultId: string): Promise<void> {
  const token = chatheadsAuth.getToken();
  if (!token) return;
  const cached = store.get<string>(SLASHTALK_CRED_ID_KEY);
  if (cached) {
    try {
      await client().beta.vaults.credentials.retrieve(cached, { vault_id: vaultId });
      return;
    } catch {
      store.set(SLASHTALK_CRED_ID_KEY, null);
    }
  }
  const cred = await client().beta.vaults.credentials.create(vaultId, {
    display_name: "Slashtalk MCP",
    auth: {
      type: "static_bearer",
      mcp_server_url: slashtalkMcpUrl(),
      token,
    },
  });
  store.set(SLASHTALK_CRED_ID_KEY, cred.id);
}

async function ensureGithubCredential(vaultId: string): Promise<void> {
  const creds = githubAuth.getCreds();
  if (!creds) return;
  const cached = store.get<string>(GITHUB_CRED_ID_KEY);
  if (cached) {
    try {
      await client().beta.vaults.credentials.retrieve(cached, { vault_id: vaultId });
      return;
    } catch {
      store.set(GITHUB_CRED_ID_KEY, null);
    }
  }
  const clientId = githubAuth.getClientId();
  const cred = await client().beta.vaults.credentials.create(vaultId, {
    display_name: `GitHub${creds.login ? ` (@${creds.login})` : ""}`,
    auth: {
      type: "mcp_oauth",
      mcp_server_url: GITHUB_MCP_URL,
      access_token: creds.accessToken,
      expires_at: new Date(creds.expiresAt).toISOString(),
      // Device-flow OAuth Apps are public clients — no secret at the refresh
      // endpoint, so we use `none` auth. Anthropic still needs the client_id
      // and refresh_token to rotate the access token.
      refresh: {
        token_endpoint: "https://github.com/login/oauth/access_token",
        client_id: clientId,
        refresh_token: creds.refreshToken,
        scope: creds.scope,
        token_endpoint_auth: { type: "none" },
      },
    },
  });
  store.set(GITHUB_CRED_ID_KEY, cred.id);
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  systemPrompt: string;
  model?: string; // default claude-haiku-4-5
  /** Extra URL-based MCP servers the agent should have access to. Each gets
   *  a matching mcp_toolset with always_allow permission policy. */
  mcpServers?: McpServerInput[];
}

export interface CreatedAgent {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  model: string;
}

export async function createAgent(input: CreateAgentInput): Promise<CreatedAgent> {
  const config = await buildAgentConfig(input);

  const agent = await client().beta.agents.create({
    name: input.name,
    description: input.description,
    model: config.model,
    system: input.systemPrompt,
    // Pre-built toolset: bash, read, write, edit, glob, grep, web_fetch, web_search.
    tools: config.tools,
    // Anthropic-managed skills: xlsx lets the agent read/write spreadsheets
    // and handles PDFs/PowerPoint. Loaded lazily when the agent deems it
    // relevant; doesn't cost tokens when unused.
    skills: config.skills,
    ...(config.mcpServers.length > 0 ? { mcp_servers: config.mcpServers } : {}),
  });

  return {
    id: agent.id,
    name: agent.name,
    description: agent.description ?? undefined,
    systemPrompt: input.systemPrompt,
    model: config.model,
  };
}

export async function updateAgent(agentId: string, input: CreateAgentInput): Promise<CreatedAgent> {
  const current = await client().beta.agents.retrieve(agentId);
  const config = await buildAgentConfig(input);
  const agent = await client().beta.agents.update(agentId, {
    version: current.version,
    name: input.name,
    description: input.description ?? null,
    model: config.model,
    system: input.systemPrompt,
    tools: config.tools,
    skills: config.skills,
    mcp_servers: config.mcpServers,
  });

  return {
    id: agent.id,
    name: agent.name,
    description: agent.description ?? undefined,
    systemPrompt: agent.system ?? input.systemPrompt,
    model: typeof agent.model === "string" ? agent.model : agent.model.id,
  };
}

async function buildAgentConfig(input: CreateAgentInput): Promise<{
  model: string;
  mcpServers: Array<{ type: "url"; name: string; url: string }>;
  tools: Array<
    | { type: "agent_toolset_20260401" }
    | {
        type: "mcp_toolset";
        mcp_server_name: string;
        default_config: { permission_policy: { type: "always_allow" } };
      }
  >;
  skills: Array<{ type: "anthropic"; skill_id: "xlsx" }>;
}> {
  const vaultId = await ensureVault();
  const model = input.model ?? "claude-haiku-4-5";

  // Merge user-specified MCP servers with the built-in Slashtalk one (if we
  // have a vault credential for it). Names must be unique; dedupe by name
  // with user-specified taking precedence.
  const servers = dedupeByName([
    ...(vaultId
      ? [
          {
            name: SLASHTALK_MCP_NAME,
            url: slashtalkMcpUrl(),
          },
        ]
      : []),
    ...(input.mcpServers ?? []),
  ]);

  const mcpServers = servers.map((s) => ({
    type: "url" as const,
    name: s.name,
    url: s.url,
  }));

  const mcpToolsets = servers.map((s) => ({
    type: "mcp_toolset" as const,
    mcp_server_name: s.name,
    default_config: {
      permission_policy: { type: "always_allow" as const },
    },
  }));

  return {
    model,
    mcpServers,
    tools: [{ type: "agent_toolset_20260401" }, ...mcpToolsets],
    skills: [{ type: "anthropic", skill_id: "xlsx" }],
  };
}

function dedupeByName(servers: McpServerInput[]): McpServerInput[] {
  const seen = new Set<string>();
  const out: McpServerInput[] = [];
  for (const s of servers) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push(s);
  }
  return out;
}

export async function archiveAgent(agentId: string): Promise<void> {
  await client().beta.agents.archive(agentId);
}

export interface RemoteSession {
  id: string;
  createdAt: number;
  title: string | null;
  archivedAt: number | null;
}

/** Paginated listing of every session this API key has for an agent. Returns
 *  both active and archived — caller filters as needed. */
export async function listAgentSessions(agentId: string): Promise<RemoteSession[]> {
  const out: RemoteSession[] = [];
  for await (const s of client().beta.sessions.list({
    agent_id: agentId,
  }) as unknown as AsyncIterable<{
    id: string;
    created_at: string;
    title: string | null;
    archived_at: string | null;
  }>) {
    out.push({
      id: s.id,
      createdAt: new Date(s.created_at).getTime(),
      title: s.title,
      archivedAt: s.archived_at ? new Date(s.archived_at).getTime() : null,
    });
  }
  return out;
}

export async function updateSessionTitle(sessionId: string, title: string): Promise<void> {
  await client().beta.sessions.update(sessionId, { title });
}

export async function archiveSession(sessionId: string): Promise<void> {
  await client().beta.sessions.archive(sessionId);
}

export interface SessionRef {
  sessionId: string;
  agentId: string;
}

export async function startSession(agentId: string): Promise<SessionRef> {
  const environmentId = await ensureEnvironment();
  const vaultId = await ensureVault();
  const session = await client().beta.sessions.create({
    agent: agentId,
    environment_id: environmentId,
    ...(vaultId ? { vault_ids: [vaultId] } : {}),
  });
  return { sessionId: session.id, agentId };
}

// Simplified streaming event types that cross the IPC boundary. We trim the
// SDK's types down to what the renderer actually renders. The `agentId` field
// is stamped on in main/index.ts before IPC emission.
export type AgentStreamEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking" }
  | {
      kind: "tool_use";
      id: string;
      name: string;
      server?: string;
      input?: unknown;
    }
  | {
      kind: "tool_result";
      toolUseId: string;
      isError?: boolean;
      summary?: string;
    }
  | { kind: "phase"; label: string | null }
  | { kind: "usage"; input: number; output: number }
  | { kind: "done"; stopReason?: string }
  | { kind: "error"; message: string };

// Reconstruct a single page of the server-side session event log. We request
// newest-first with a cursor and reverse within the page to reconstruct
// chronologically. The returned `nextCursor` lets the caller load older
// pages (scroll-to-top lazy load).
//
// Caveat: because we paginate by event, a single logical assistant turn can
// straddle a page boundary and appear as two adjacent assistant messages with
// a split. We accept this for the hackathon.
const PAGE_SIZE = 50;

export async function loadSessionMessages(
  sessionId: string,
  cursor?: string | null,
): Promise<AgentHistoryPage> {
  const params: Record<string, unknown> = { limit: PAGE_SIZE, order: "desc" };
  if (cursor) params.page = cursor;

  const resp = (await client().beta.sessions.events.list(
    sessionId,
    params as never,
  )) as unknown as {
    data: unknown[];
    next_page: string | null;
  };

  // Page arrives newest-first; reverse so reconstruction can walk chronologically.
  const chronological = [...resp.data].reverse();
  return {
    msgs: reconstructMessages(chronological),
    nextCursor: resp.next_page ?? null,
  };
}

/** Walks every page of a session's events and sums the model-request usage.
 *  Used to backfill token totals for sessions created before streaming-side
 *  accounting was wired up, or left running without our client. */
export async function sumSessionUsage(
  sessionId: string,
): Promise<{ input: number; output: number }> {
  let input = 0;
  let output = 0;
  let cursor: string | null = null;
  do {
    const params: Record<string, unknown> = { limit: PAGE_SIZE, order: "desc" };
    if (cursor) params.page = cursor;
    const resp = (await client().beta.sessions.events.list(
      sessionId,
      params as never,
    )) as unknown as { data: unknown[]; next_page: string | null };
    for (const event of resp.data) {
      const e = event as {
        type?: string;
        model_usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (e.type === "span.model_request_end" && e.model_usage) {
        input += e.model_usage.input_tokens ?? 0;
        output += e.model_usage.output_tokens ?? 0;
      }
    }
    cursor = resp.next_page;
  } while (cursor);
  return { input, output };
}

function reconstructMessages(events: unknown[]): AgentMsg[] {
  const msgs: AgentMsg[] = [];
  const lastAssistant = (): Extract<AgentMsg, { role: "assistant" }> | undefined => {
    const m = msgs[msgs.length - 1];
    return m?.role === "assistant" ? m : undefined;
  };
  const ensureAssistant = (): Extract<AgentMsg, { role: "assistant" }> => {
    const tail = lastAssistant();
    if (tail && !tail.done) return tail;
    const fresh: Extract<AgentMsg, { role: "assistant" }> = {
      role: "assistant",
      blocks: [],
      done: false,
    };
    msgs.push(fresh);
    return fresh;
  };

  for (const event of events) {
    const e = event as { type?: string } & Record<string, unknown>;
    if (e.type === "user.message") {
      const text = extractText(e.content);
      if (text) msgs.push({ role: "user", text });
    } else if (e.type === "agent.message") {
      const text = extractText(e.content);
      if (!text) continue;
      const a = ensureAssistant();
      const last = a.blocks[a.blocks.length - 1];
      if (last?.kind === "text") {
        last.text += text;
      } else {
        a.blocks.push({ kind: "text", text });
      }
    } else if (e.type === "agent.thinking") {
      const a = ensureAssistant();
      // Collapse consecutive thinking markers into one block.
      const last = a.blocks[a.blocks.length - 1];
      if (last?.kind !== "thinking") a.blocks.push({ kind: "thinking" });
    } else if (e.type === "agent.tool_use" || e.type === "agent.mcp_tool_use") {
      const a = ensureAssistant();
      const id = (e as { id?: string }).id ?? "";
      const name = (e as { name?: string }).name ?? "tool";
      const server =
        e.type === "agent.mcp_tool_use"
          ? (e as { mcp_server_name?: string }).mcp_server_name
          : undefined;
      a.blocks.push({
        kind: "tool_use",
        id,
        name,
        server,
        input: (e as { input?: unknown }).input,
        status: "running",
      });
    } else if (e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result") {
      const a = lastAssistant();
      if (!a) continue;
      const refId =
        e.type === "agent.mcp_tool_result"
          ? (e as { mcp_tool_use_id?: string }).mcp_tool_use_id
          : (e as { tool_use_id?: string }).tool_use_id;
      const block = a.blocks.find(
        (b): b is Extract<AssistantBlock, { kind: "tool_use" }> =>
          b.kind === "tool_use" && b.id === refId,
      );
      if (!block) continue;
      const isError = Boolean((e as { is_error?: boolean }).is_error);
      block.status = isError ? "error" : "ok";
      block.resultSummary = summarizeResult((e as { content?: unknown[] }).content);
    } else if (e.type === "session.status_idle" || e.type === "session.status_terminated") {
      const tail = lastAssistant();
      if (tail) tail.done = true;
    }
  }

  // Historical assistant turns are always considered complete — the "not done"
  // flag is only meaningful for live-streaming turns in the renderer.
  const final = lastAssistant();
  if (final) final.done = true;
  return msgs;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => c as { type?: string; text?: string })
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text ?? "")
    .join("");
}

function summarizeResult(content: unknown): string | undefined {
  const text = extractText(content);
  if (!text) return undefined;
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 140) return trimmed;
  return trimmed.slice(0, 137) + "…";
}

export async function sendMessage(
  sessionId: string,
  text: string,
  onEvent: (e: AgentStreamEvent) => void,
): Promise<void> {
  try {
    const stream = await client().beta.sessions.events.stream(sessionId);

    await client().beta.sessions.events.send(sessionId, {
      events: [
        {
          type: "user.message",
          content: [{ type: "text", text }],
        },
      ],
    });

    // Kick off with an immediate "Working…" phase so the UI stops showing just
    // "…" while we wait for the first real event.
    onEvent({ kind: "phase", label: "Working…" });

    for await (const event of stream) {
      const e = event as unknown as { type: string } & Record<string, unknown>;
      if (e.type === "agent.message") {
        const content = (e as { content?: unknown[] }).content ?? [];
        for (const block of content) {
          const b = block as { type?: string; text?: string };
          if (b.type === "text" && typeof b.text === "string") {
            onEvent({ kind: "text", text: b.text });
          }
        }
        onEvent({ kind: "phase", label: null });
      } else if (e.type === "agent.thinking") {
        onEvent({ kind: "thinking" });
        onEvent({ kind: "phase", label: "Thinking…" });
      } else if (e.type === "agent.tool_use" || e.type === "agent.mcp_tool_use") {
        const id = (e as { id?: string }).id ?? "";
        const name = (e as { name?: string }).name ?? "tool";
        const server =
          e.type === "agent.mcp_tool_use"
            ? (e as { mcp_server_name?: string }).mcp_server_name
            : undefined;
        const input = (e as { input?: unknown }).input;
        onEvent({ kind: "tool_use", id, name, server, input });
        onEvent({
          kind: "phase",
          label: `Running ${server ? `${server}·` : ""}${name}…`,
        });
      } else if (e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result") {
        const toolUseId =
          e.type === "agent.mcp_tool_result"
            ? ((e as { mcp_tool_use_id?: string }).mcp_tool_use_id ?? "")
            : ((e as { tool_use_id?: string }).tool_use_id ?? "");
        const isError = Boolean((e as { is_error?: boolean }).is_error);
        const summary = summarizeResult((e as { content?: unknown[] }).content);
        onEvent({ kind: "tool_result", toolUseId, isError, summary });
      } else if (e.type === "span.model_request_start") {
        onEvent({ kind: "phase", label: "Thinking…" });
      } else if (e.type === "span.model_request_end") {
        const usage = (e as { model_usage?: { input_tokens?: number; output_tokens?: number } })
          .model_usage;
        if (usage) {
          onEvent({
            kind: "usage",
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
          });
        }
      } else if (e.type === "session.status_running") {
        onEvent({ kind: "phase", label: "Working…" });
      } else if (e.type === "session.status_idle") {
        const stopReason = (e as { stop_reason?: string }).stop_reason;
        onEvent({ kind: "phase", label: null });
        onEvent({ kind: "done", stopReason });
        break;
      } else if (e.type === "session.status_terminated") {
        onEvent({ kind: "error", message: "Session terminated." });
        break;
      } else if (e.type === "session.error") {
        const err = (e as { error?: { message?: string } }).error;
        onEvent({
          kind: "error",
          message: err?.message ?? "Session error.",
        });
      }
    }
  } catch (err) {
    onEvent({ kind: "error", message: String(err) });
  }
}
