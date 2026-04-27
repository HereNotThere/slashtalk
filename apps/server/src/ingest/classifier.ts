import type { EventKind, EventSource } from "@slashtalk/shared";

export interface NormalizedEvent {
  ts: Date;
  rawType: string;
  kind: EventKind;
  turnId: string | null;
  callId: string | null;
  eventId: string | null;
  parentId: string | null;
}

type JsonObj = Record<string, unknown>;

function isObj(v: unknown): v is JsonObj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function classifyEvent(source: EventSource, event: unknown): NormalizedEvent {
  if (!isObj(event)) {
    return norm({ ts: new Date(), rawType: "unknown", kind: "unknown" });
  }
  if (source === "claude") return classifyClaude(event);
  if (source === "codex") return classifyCodex(event);
  return classifyCursor(event);
}

// ── Claude ─────────────────────────────────────────────────────

function classifyClaude(ev: JsonObj): NormalizedEvent {
  const rawType = String(ev.type ?? "unknown");
  return norm({
    ts: parseTs(ev.timestamp),
    rawType,
    kind: claudeKind(rawType, ev),
    eventId: asString(ev.uuid),
    parentId: asString(ev.parentUuid),
  });
}

function claudeKind(rawType: string, ev: JsonObj): EventKind {
  switch (rawType) {
    case "user":
      if (ev.isMeta === true || looksLikeCliCommand(ev)) return "meta";
      if (hasToolResultBlock(ev)) return "tool_result";
      return "user_msg";
    case "assistant":
      return "assistant_msg";
    case "system":
      return "system";
    case "attachment":
    case "file-history-snapshot":
      return "meta";
    default:
      return "unknown";
  }
}

function hasToolResultBlock(ev: JsonObj): boolean {
  const message = ev.message;
  if (!isObj(message) || !Array.isArray(message.content)) return false;
  return message.content.some((b) => isObj(b) && b.type === "tool_result");
}

function looksLikeCliCommand(ev: JsonObj): boolean {
  const message = ev.message;
  if (!isObj(message)) return false;
  const content = message.content;
  return (
    typeof content === "string" &&
    (content.startsWith("<local-command") || content.startsWith("<command"))
  );
}

// ── Codex ──────────────────────────────────────────────────────
// Two-layer events: { type, timestamp, payload: { type, ... } }.
// Messages and reasoning have no per-event IDs; tool calls and turns do.

const CODEX_MESSAGE_ROLE_KIND: Record<string, EventKind> = {
  user: "user_msg",
  assistant: "assistant_msg",
};

const CODEX_TOP_KIND: Record<string, EventKind> = {
  session_meta: "meta",
  turn_context: "meta",
  compacted: "system",
};

const CODEX_EVENT_MSG_KIND: Record<string, EventKind> = {
  task_started: "turn_start",
  task_complete: "turn_end",
  turn_aborted: "turn_end",
  user_message: "user_msg",
  agent_message: "assistant_msg",
  token_count: "token_usage",
  exec_command_end: "tool_result",
  patch_apply_end: "tool_result",
  web_search_end: "tool_result",
  error: "system",
};

const CODEX_RESPONSE_ITEM_KIND: Record<string, EventKind> = {
  reasoning: "reasoning",
  function_call: "tool_call",
  custom_tool_call: "tool_call",
  web_search_call: "tool_call",
  function_call_output: "tool_result",
  custom_tool_call_output: "tool_result",
};

function classifyCodex(ev: JsonObj): NormalizedEvent {
  const topType = String(ev.type ?? "unknown");
  const payload: JsonObj = isObj(ev.payload) ? ev.payload : {};
  const payloadType = asString(payload.type);
  const rawType = payloadType ? `${topType}.${payloadType}` : topType;

  return norm({
    ts: parseTs(ev.timestamp),
    rawType,
    kind: codexKind(topType, payloadType, payload),
    turnId: asString(payload.turn_id),
    callId: asString(payload.call_id),
  });
}

// ── Cursor ─────────────────────────────────────────────────────
// Cursor agent transcripts are plain JSONL chat turns:
// { timestamp?, role, cwd?, version?, message: { content: [...] } }
// Tool uses are embedded inside assistant message content blocks.

const CURSOR_ROLE_KIND: Record<string, EventKind> = {
  user: "user_msg",
  assistant: "assistant_msg",
  system: "system",
};

function classifyCursor(ev: JsonObj): NormalizedEvent {
  const role = asString(ev.role) ?? "unknown";
  return norm({
    ts: parseTs(ev.timestamp),
    rawType: role,
    kind: CURSOR_ROLE_KIND[role] ?? "unknown",
  });
}

function codexKind(topType: string, payloadType: string | null, payload: JsonObj): EventKind {
  const topHit = CODEX_TOP_KIND[topType];
  if (topHit) return topHit;

  if (topType === "event_msg" && payloadType) {
    return CODEX_EVENT_MSG_KIND[payloadType] ?? "unknown";
  }
  if (topType === "response_item" && payloadType) {
    if (payloadType === "message") {
      const role = asString(payload.role) ?? "";
      return CODEX_MESSAGE_ROLE_KIND[role] ?? "system";
    }
    return CODEX_RESPONSE_ITEM_KIND[payloadType] ?? "unknown";
  }
  return "unknown";
}

// ── helpers ────────────────────────────────────────────────────

function norm(
  partial: Pick<NormalizedEvent, "ts" | "rawType" | "kind"> &
    Partial<Pick<NormalizedEvent, "turnId" | "callId" | "eventId" | "parentId">>,
): NormalizedEvent {
  return {
    turnId: null,
    callId: null,
    eventId: null,
    parentId: null,
    ...partial,
  };
}

function parseTs(v: unknown): Date {
  if (typeof v === "string") {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
