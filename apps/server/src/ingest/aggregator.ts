/**
 * Session aggregate computation from source JSONL events.
 * Claude and Codex both fold into the same sessions table shape.
 */

import type { EventSource, Provider } from "@slashtalk/shared";

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

interface ClaudeEventPayload {
  type: string;
  uuid: string;
  timestamp: string;
  sessionId?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  message?: {
    content?: string | ContentBlock[];
    model?: string;
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    };
  };
  attachment?: {
    type?: string;
    prompt?: string;
    commandMode?: string;
  };
}

interface CursorEventPayload {
  timestamp?: string;
  role?: string;
  cwd?: string;
  version?: string;
  message?: {
    content?: string | ContentBlock[];
  };
}

type JsonObj = Record<string, unknown>;

interface SessionUpdates {
  provider: Provider | null;
  userMsgs: number;
  assistantMsgs: number;
  toolCalls: number;
  toolErrors: number;
  events: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  tokensReasoning: number;
  model: string | null;
  version: string | null;
  branch: string | null;
  cwd: string | null;
  firstTs: Date | null;
  lastTs: Date | null;
  title: string | null;
  inTurn: boolean;
  currentTurnId: string | null;
  lastBoundaryTs: Date | null;
  outstandingTools: Record<
    string,
    { name: string; desc: string | null; started: number }
  >;
  lastUserPrompt: string | null;
  topFilesRead: Record<string, number>;
  topFilesEdited: Record<string, number>;
  topFilesWritten: Record<string, number>;
  toolUseNames: Record<string, number>;
  queued: Array<{ prompt: string; ts: string; mode: string | null }>;
  recentEvents: Array<{ ts: string; type: string; summary: string }>;
}

interface CurrentSession {
  provider: Provider | null;
  userMsgs: number | null;
  assistantMsgs: number | null;
  toolCalls: number | null;
  toolErrors: number | null;
  events: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
  tokensReasoning: number | null;
  model: string | null;
  version: string | null;
  branch: string | null;
  cwd: string | null;
  firstTs: Date | null;
  lastTs: Date | null;
  title: string | null;
  inTurn: boolean | null;
  currentTurnId: string | null;
  lastBoundaryTs: Date | null;
  outstandingTools: unknown;
  lastUserPrompt: string | null;
  topFilesRead: unknown;
  topFilesEdited: unknown;
  topFilesWritten: unknown;
  toolUseNames: unknown;
  queued: unknown;
  recentEvents: unknown;
}

function isObj(v: unknown): v is JsonObj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseJsonObject(v: unknown): JsonObj | null {
  if (typeof v !== "string") return null;
  try {
    const parsed = JSON.parse(v);
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function incMap(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function topN(map: Record<string, number>, n: number): Record<string, number> {
  const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(sorted.slice(0, n));
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function initState(current: CurrentSession): SessionUpdates {
  return {
    provider: current.provider ?? null,
    userMsgs: current.userMsgs ?? 0,
    assistantMsgs: current.assistantMsgs ?? 0,
    toolCalls: current.toolCalls ?? 0,
    toolErrors: current.toolErrors ?? 0,
    events: current.events ?? 0,
    tokensIn: current.tokensIn ?? 0,
    tokensOut: current.tokensOut ?? 0,
    tokensCacheRead: current.tokensCacheRead ?? 0,
    tokensCacheWrite: current.tokensCacheWrite ?? 0,
    tokensReasoning: current.tokensReasoning ?? 0,
    model: current.model,
    version: current.version,
    branch: current.branch,
    cwd: current.cwd,
    firstTs: current.firstTs,
    lastTs: current.lastTs,
    title: current.title,
    inTurn: current.inTurn ?? false,
    currentTurnId: current.currentTurnId ?? null,
    lastBoundaryTs: current.lastBoundaryTs,
    outstandingTools: {
      ...((current.outstandingTools as Record<string, SessionUpdates["outstandingTools"][string]>) ??
        {}),
    },
    lastUserPrompt: current.lastUserPrompt,
    topFilesRead: {
      ...((current.topFilesRead as Record<string, number>) ?? {}),
    },
    topFilesEdited: {
      ...((current.topFilesEdited as Record<string, number>) ?? {}),
    },
    topFilesWritten: {
      ...((current.topFilesWritten as Record<string, number>) ?? {}),
    },
    toolUseNames: {
      ...((current.toolUseNames as Record<string, number>) ?? {}),
    },
    queued: [...((current.queued as SessionUpdates["queued"]) ?? [])],
    recentEvents: [...((current.recentEvents as SessionUpdates["recentEvents"]) ?? [])],
  };
}

function pushRecent(
  state: SessionUpdates,
  ts: string,
  type: string,
  summary: string,
): void {
  state.recentEvents.push({ ts, type, summary });
  if (state.recentEvents.length > 20) {
    state.recentEvents = state.recentEvents.slice(-20);
  }
}

function updateTimestamps(state: SessionUpdates, timestamp: string): Date | null {
  const ts = new Date(timestamp);
  if (Number.isNaN(ts.getTime())) return null;
  if (!state.firstTs || ts < state.firstTs) state.firstTs = ts;
  if (!state.lastTs || ts > state.lastTs) state.lastTs = ts;
  return ts;
}

function isRealClaudeUserMessage(event: ClaudeEventPayload): boolean {
  if (event.isMeta || event.isSidechain) return false;
  const content = event.message?.content;
  if (typeof content === "string") {
    if (content.startsWith("<local-command") || content.startsWith("<command")) {
      return false;
    }
  }
  return true;
}

function extractClaudeUserPromptText(event: ClaudeEventPayload): string | null {
  const content = event.message?.content;
  if (!content) return null;
  if (typeof content === "string") return content;
  const textBlocks = content.filter((block) => block.type === "text" && block.text);
  return textBlocks.map((block) => block.text).join("\n") || null;
}

function summarizeClaudeEvent(event: ClaudeEventPayload): string {
  if (event.type === "user") {
    const text = extractClaudeUserPromptText(event);
    return text ? truncate(text, 80) : "(user message)";
  }
  if (event.type === "assistant") {
    const content = event.message?.content;
    if (Array.isArray(content)) {
      const toolUse = content.find((block) => block.type === "tool_use");
      if (toolUse) return `tool: ${toolUse.name}`;
      const thinking = content.find((block) => block.type === "thinking");
      if (thinking) return "thinking...";
      const text = content.find((block) => block.type === "text" && block.text);
      if (text?.text) return truncate(text.text, 80);
    }
    return "(assistant)";
  }
  if (event.type === "attachment" && event.attachment?.type === "queued_command") {
    return `queued: ${truncate(event.attachment.prompt ?? "", 60)}`;
  }
  return event.type;
}

const FILE_TOOLS_READ = new Set(["Read", "Grep", "Glob"]);
const FILE_TOOLS_EDIT = new Set(["Edit", "MultiEdit", "StrReplace"]);
const FILE_TOOLS_WRITE = new Set(["Write"]);

function processClaudeEvents(
  current: CurrentSession,
  newEvents: unknown[],
): SessionUpdates {
  const state = initState(current);
  state.provider ??= "anthropic";

  for (const raw of newEvents) {
    const event = raw as ClaudeEventPayload;
    state.events++;
    if (!event.timestamp) continue;
    const ts = updateTimestamps(state, event.timestamp);
    if (!ts) continue;

    if (event.cwd) state.cwd = event.cwd;
    if (event.gitBranch) state.branch = event.gitBranch;
    if (event.version) state.version = event.version;

    pushRecent(state, event.timestamp, event.type, summarizeClaudeEvent(event));

    if (event.type === "user") {
      if (!event.isSidechain) state.userMsgs++;

      const content = event.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            delete state.outstandingTools[block.tool_use_id];
            if (block.is_error) state.toolErrors++;
          }
        }
      }

      if (isRealClaudeUserMessage(event)) {
        const promptText = extractClaudeUserPromptText(event);
        if (promptText) {
          state.title ??= truncate(promptText.split("\n")[0] ?? promptText, 80);
          state.lastUserPrompt = truncate(promptText, 800);
        }
        state.inTurn = true;
        state.currentTurnId = null;
        state.lastBoundaryTs = ts;
      }
    }

    if (event.type === "assistant") {
      if (!event.isSidechain) state.assistantMsgs++;
      const msg = event.message;

      if (msg?.model) state.model = msg.model;

      if (msg?.usage) {
        const usage = msg.usage;
        state.tokensIn += usage.input_tokens ?? 0;
        state.tokensOut += usage.output_tokens ?? 0;
        state.tokensCacheRead += usage.cache_read_input_tokens ?? 0;
        if (usage.cache_creation) {
          state.tokensCacheWrite +=
            (usage.cache_creation.ephemeral_5m_input_tokens ?? 0) +
            (usage.cache_creation.ephemeral_1h_input_tokens ?? 0);
        } else if (usage.cache_creation_input_tokens) {
          state.tokensCacheWrite += usage.cache_creation_input_tokens;
        }
      }

      if (Array.isArray(msg?.content)) {
        for (const block of msg.content as ContentBlock[]) {
          if (block.type !== "tool_use" || !block.id || !block.name) continue;
          state.toolCalls++;
          incMap(state.toolUseNames, block.name);
          state.outstandingTools[block.id] = {
            name: block.name,
            desc: block.input
              ? truncate(`${block.name} ${JSON.stringify(block.input)}`, 120)
              : null,
            started: ts.getTime(),
          };

          const filePath =
            (typeof block.input?.["file_path"] === "string"
              ? block.input["file_path"]
              : null) ??
            (typeof block.input?.["path"] === "string" ? block.input["path"] : null);
          if (!filePath || typeof filePath !== "string") continue;
          if (FILE_TOOLS_READ.has(block.name)) incMap(state.topFilesRead, filePath);
          if (FILE_TOOLS_EDIT.has(block.name)) {
            incMap(state.topFilesEdited, filePath);
          }
          if (FILE_TOOLS_WRITE.has(block.name)) {
            incMap(state.topFilesWritten, filePath);
          }
        }
      }

      if (msg?.stop_reason === "end_turn") {
        state.inTurn = false;
        state.currentTurnId = null;
        state.lastBoundaryTs = ts;
      }
    }

    if (event.type === "attachment") {
      if (
        event.attachment?.type === "queued_command" &&
        event.attachment.prompt &&
        !event.attachment.prompt.startsWith("<task-notification")
      ) {
        state.queued.push({
          prompt: event.attachment.prompt,
          ts: event.timestamp,
          mode: event.attachment.commandMode ?? null,
        });
        state.inTurn = true;
      }
    }
  }

  return finalizeState(state);
}

function extractCursorText(event: CursorEventPayload): string | null {
  const content = event.message?.content;
  if (!content) return null;
  if (typeof content === "string") return content;
  const textBlocks = content.filter((block) => block.type === "text" && block.text);
  return textBlocks.map((block) => block.text).join("\n") || null;
}

function summarizeCursorEvent(event: CursorEventPayload): string {
  if (event.role === "user") {
    const text = extractCursorText(event);
    return text ? truncate(text, 80) : "(user message)";
  }
  if (event.role === "assistant") {
    const content = event.message?.content;
    if (Array.isArray(content)) {
      const toolUse = content.find((block) => block.type === "tool_use");
      if (toolUse) return `tool: ${toolUse.name}`;
      const text = content.find((block) => block.type === "text" && block.text);
      if (text?.text) return truncate(text.text, 80);
    }
    return "(assistant)";
  }
  return event.role ?? "unknown";
}

function cursorToolPath(block: ContentBlock): string | null {
  if (typeof block.input?.["target_directory"] === "string") {
    return block.input["target_directory"];
  }
  if (typeof block.input?.["file_path"] === "string") {
    return block.input["file_path"];
  }
  if (typeof block.input?.["path"] === "string") {
    return block.input["path"];
  }
  return null;
}

function processCursorEvents(
  current: CurrentSession,
  newEvents: unknown[],
): SessionUpdates {
  const state = initState(current);

  for (const raw of newEvents) {
    const event = raw as CursorEventPayload;
    state.events++;
    if (!event.timestamp) continue;
    const ts = updateTimestamps(state, event.timestamp);
    if (!ts) continue;

    if (event.cwd) state.cwd = event.cwd;
    if (event.version) state.version = event.version;

    pushRecent(state, event.timestamp, event.role ?? "unknown", summarizeCursorEvent(event));

    if (event.role === "user") {
      state.userMsgs++;
      const promptText = extractCursorText(event);
      if (promptText) {
        state.title ??= truncate(promptText.split("\n")[0] ?? promptText, 80);
        state.lastUserPrompt = truncate(promptText, 800);
      }
      state.lastBoundaryTs = ts;
      continue;
    }

    if (event.role !== "assistant") continue;
    state.assistantMsgs++;

    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== "tool_use" || !block.name) continue;
      state.toolCalls++;
      incMap(state.toolUseNames, block.name);

      const target = cursorToolPath(block);
      if (!target) continue;
      if (FILE_TOOLS_READ.has(block.name)) incMap(state.topFilesRead, target);
      if (FILE_TOOLS_EDIT.has(block.name)) incMap(state.topFilesEdited, target);
      if (FILE_TOOLS_WRITE.has(block.name)) incMap(state.topFilesWritten, target);
    }
  }

  return finalizeState(state);
}

function summarizeCodexEvent(event: JsonObj): string {
  const topType = asString(event.type) ?? "unknown";
  const payload = isObj(event.payload) ? event.payload : null;
  const payloadType = payload ? asString(payload.type) : null;

  if (topType === "event_msg" && payloadType === "user_message") {
    return truncate(asString(payload?.message) ?? "(user message)", 80);
  }
  if (topType === "event_msg" && payloadType === "agent_message") {
    return truncate(asString(payload?.message) ?? "(assistant)", 80);
  }
  if (topType === "event_msg" && payloadType === "task_complete") {
    return truncate(asString(payload?.last_agent_message) ?? "turn complete", 80);
  }
  if (topType === "event_msg" && payloadType === "turn_aborted") {
    const reason = asString(payload?.reason);
    return reason ? `turn aborted: ${reason}` : "turn aborted";
  }
  if (topType === "response_item" && payloadType) {
    if (
      payloadType === "function_call" ||
      payloadType === "custom_tool_call" ||
      payloadType === "web_search_call"
    ) {
      return `tool: ${asString(payload?.name) ?? payloadType}`;
    }
    if (
      payloadType === "function_call_output" ||
      payloadType === "custom_tool_call_output"
    ) {
      return `tool result: ${asString(payload?.call_id) ?? "call"}`;
    }
  }
  if (topType === "event_msg" && payloadType === "exec_command_end") {
    const command = Array.isArray(payload?.command)
      ? (payload?.command as unknown[])
          .map((part) => (typeof part === "string" ? part : ""))
          .join(" ")
          .trim()
      : "";
    return command ? truncate(`exec: ${command}`, 80) : "exec command";
  }
  if (topType === "event_msg" && payloadType === "patch_apply_end") {
    return "patch apply";
  }
  if (topType === "event_msg" && payloadType === "web_search_end") {
    return "web search";
  }
  if (topType === "turn_context") {
    return "turn context";
  }
  if (topType === "session_meta") {
    return "session meta";
  }
  return payloadType ? `${topType}.${payloadType}` : topType;
}

function trackCodexParsedCmd(state: SessionUpdates, parsedCmd: unknown): void {
  if (!Array.isArray(parsedCmd)) return;
  for (const part of parsedCmd) {
    if (!isObj(part)) continue;
    const op = asString(part.type);
    const target = asString(part.path);
    if (!op || !target) continue;
    if (op === "read" || op === "search") incMap(state.topFilesRead, target);
  }
}

function trackCodexPatchChanges(state: SessionUpdates, changes: unknown): void {
  if (!isObj(changes)) return;
  for (const [filePath, change] of Object.entries(changes)) {
    if (!isObj(change)) continue;
    const kind = asString(change.type);
    if (kind === "update") incMap(state.topFilesEdited, filePath);
    else if (kind === "add") incMap(state.topFilesWritten, filePath);
  }
}

function toolDesc(name: string, args: JsonObj | null, rawArgs: string | null): string | null {
  if (args) return truncate(`${name} ${JSON.stringify(args)}`, 120);
  if (rawArgs) return truncate(`${name} ${rawArgs}`, 120);
  return null;
}

function processCodexEvents(
  current: CurrentSession,
  newEvents: unknown[],
): SessionUpdates {
  const state = initState(current);

  for (const raw of newEvents) {
    if (!isObj(raw)) {
      state.events++;
      continue;
    }

    state.events++;
    const topType = asString(raw.type) ?? "unknown";
    const timestamp = asString(raw.timestamp);
    if (!timestamp) continue;
    const ts = updateTimestamps(state, timestamp);
    if (!ts) continue;

    pushRecent(state, timestamp, topType, summarizeCodexEvent(raw));

    const payload = isObj(raw.payload) ? raw.payload : null;
    const payloadType = payload ? asString(payload.type) : null;

    if (topType === "session_meta") {
      state.provider =
        payload && asString(payload.model_provider) === "openai"
          ? "openai"
          : payload && asString(payload.model_provider) === "anthropic"
            ? "anthropic"
            : state.provider;
      if (payload && asString(payload.cwd)) state.cwd = asString(payload.cwd);
      if (payload && asString(payload.cli_version)) {
        state.version = asString(payload.cli_version);
      }
      continue;
    }

    if (topType === "turn_context") {
      if (payload && asString(payload.cwd)) state.cwd = asString(payload.cwd);
      if (payload && asString(payload.model)) state.model = asString(payload.model);
      continue;
    }

    if (topType === "event_msg" && payload && payloadType) {
      if (payloadType === "task_started") {
        state.inTurn = true;
        state.currentTurnId = asString(payload.turn_id);
        continue;
      }

      if (payloadType === "task_complete" || payloadType === "turn_aborted") {
        state.inTurn = false;
        state.currentTurnId = null;
        state.lastBoundaryTs = ts;
        continue;
      }

      if (payloadType === "user_message") {
        const message = asString(payload.message);
        state.userMsgs++;
        if (message) {
          state.title ??= truncate(message.split("\n")[0] ?? message, 80);
          state.lastUserPrompt = truncate(message, 800);
        }
        state.inTurn = true;
        state.lastBoundaryTs = ts;
        continue;
      }

      if (payloadType === "agent_message") {
        state.assistantMsgs++;
        continue;
      }

      if (payloadType === "token_count") {
        const info = payload.info;
        const usage =
          isObj(info) && isObj(info.last_token_usage) ? info.last_token_usage : null;
        if (usage) {
          state.tokensIn += asNumber(usage.input_tokens) ?? 0;
          state.tokensCacheRead += asNumber(usage.cached_input_tokens) ?? 0;
          state.tokensOut += asNumber(usage.output_tokens) ?? 0;
          state.tokensReasoning += asNumber(usage.reasoning_output_tokens) ?? 0;
        }
        continue;
      }

      if (payloadType === "exec_command_end") {
        delete state.outstandingTools[asString(payload.call_id) ?? ""];
        trackCodexParsedCmd(state, payload.parsed_cmd);
        if ((asNumber(payload.exit_code) ?? 0) !== 0) state.toolErrors++;
        if (asString(payload.cwd)) state.cwd = asString(payload.cwd);
        continue;
      }

      if (payloadType === "patch_apply_end") {
        delete state.outstandingTools[asString(payload.call_id) ?? ""];
        trackCodexPatchChanges(state, payload.changes);
        if (payload.success === false) state.toolErrors++;
        continue;
      }

      if (payloadType === "web_search_end") {
        delete state.outstandingTools[asString(payload.call_id) ?? ""];
        continue;
      }

      if (payloadType === "error") {
        state.toolErrors++;
        continue;
      }
    }

    if (topType === "response_item" && payload && payloadType) {
      if (
        payloadType === "function_call" ||
        payloadType === "custom_tool_call" ||
        payloadType === "web_search_call"
      ) {
        const name = asString(payload.name) ?? payloadType;
        const callId = asString(payload.call_id);
        const args = parseJsonObject(payload.arguments);
        state.toolCalls++;
        incMap(state.toolUseNames, name);
        if (callId) {
          state.outstandingTools[callId] = {
            name,
            desc: toolDesc(name, args, asString(payload.arguments)),
            started: ts.getTime(),
          };
        }
        continue;
      }

      if (
        payloadType === "function_call_output" ||
        payloadType === "custom_tool_call_output"
      ) {
        const callId = asString(payload.call_id);
        if (callId) delete state.outstandingTools[callId];
      }
    }
  }

  return finalizeState(state);
}

function finalizeState(state: SessionUpdates): SessionUpdates {
  return {
    ...state,
    topFilesRead: topN(state.topFilesRead, 5),
    topFilesEdited: topN(state.topFilesEdited, 5),
    topFilesWritten: topN(state.topFilesWritten, 5),
    toolUseNames: topN(state.toolUseNames, 10),
  };
}

export function processEvents(
  source: EventSource,
  current: CurrentSession,
  newEvents: unknown[],
): SessionUpdates {
  if (source === "claude") return processClaudeEvents(current, newEvents);
  if (source === "codex") return processCodexEvents(current, newEvents);
  return processCursorEvents(current, newEvents);
}
