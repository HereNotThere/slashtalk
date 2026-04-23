/**
 * Session aggregate computation from Codex JSONL rollout events.
 *
 * Codex writes events in a two-layer envelope: `{ type, timestamp, payload }`
 * with three top-level types we care about — `session_meta`, `turn_context`,
 * `event_msg` (user/agent messages, tool results, lifecycle), and
 * `response_item` (model-side: messages, reasoning, function_call/output).
 *
 * Turn boundaries come from `event_msg.task_started` / `task_complete` /
 * `turn_aborted` — this is our only reliable `in_turn` signal, same role as
 * Claude's `stop_reason == "end_turn"` boundary.
 */

import type { CurrentSession, SessionUpdates } from "./aggregator";

interface JsonObj {
  [k: string]: unknown;
}

export interface CodexEventPayload {
  type?: string;
  timestamp?: string;
  payload?: JsonObj;
}

function isObj(v: unknown): v is JsonObj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function incMap(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function topN(
  map: Record<string, number>,
  n: number,
): Record<string, number> {
  const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(sorted.slice(0, n));
}

function summarize(ev: CodexEventPayload): string {
  const top = ev.type ?? "unknown";
  const p = isObj(ev.payload) ? ev.payload : {};
  const ptype = asStr(p.type);
  if (top === "event_msg") {
    if (ptype === "user_message") {
      const msg = asStr(p.message);
      return msg ? `user: ${msg.slice(0, 70)}` : "user message";
    }
    if (ptype === "agent_message") {
      const msg = asStr(p.message);
      return msg ? msg.slice(0, 80) : "(assistant)";
    }
    if (ptype === "exec_command_end") {
      const cmd = Array.isArray(p.command) ? p.command.join(" ") : "";
      return `exec: ${cmd.slice(0, 70)}`;
    }
    return ptype ?? top;
  }
  if (top === "response_item") {
    if (ptype === "function_call") {
      const name = asStr(p.name) ?? "fn";
      return `tool: ${name}`;
    }
    if (ptype === "reasoning") return "reasoning";
    if (ptype === "message") {
      const role = asStr(p.role) ?? "";
      return `${role}`;
    }
    return ptype ?? top;
  }
  return ptype ? `${top}.${ptype}` : top;
}

export function processCodexEvents(
  current: CurrentSession,
  newEvents: CodexEventPayload[],
): SessionUpdates {
  let userMsgs = current.userMsgs ?? 0;
  let assistantMsgs = current.assistantMsgs ?? 0;
  let toolCalls = current.toolCalls ?? 0;
  let toolErrors = current.toolErrors ?? 0;
  let eventCount = current.events ?? 0;
  let tokensIn = current.tokensIn ?? 0;
  let tokensOut = current.tokensOut ?? 0;
  let tokensCacheRead = current.tokensCacheRead ?? 0;
  const tokensCacheWrite = current.tokensCacheWrite ?? 0; // codex: no cache-write signal
  let tokensReasoning = current.tokensReasoning ?? 0;
  let model = current.model;
  let version = current.version;
  const branch = current.branch;
  let cwd = current.cwd;
  let firstTs = current.firstTs;
  let lastTs = current.lastTs;
  let title = current.title;
  let inTurn = current.inTurn ?? false;
  let lastBoundaryTs = current.lastBoundaryTs;
  const outstandingTools = {
    ...((current.outstandingTools as Record<string, any>) ?? {}),
  };
  let lastUserPrompt = current.lastUserPrompt;
  const filesRead = {
    ...((current.topFilesRead as Record<string, number>) ?? {}),
  };
  const filesEdited = {
    ...((current.topFilesEdited as Record<string, number>) ?? {}),
  };
  const filesWritten = {
    ...((current.topFilesWritten as Record<string, number>) ?? {}),
  };
  const toolNames = {
    ...((current.toolUseNames as Record<string, number>) ?? {}),
  };
  const queued = [...((current.queued as any[]) ?? [])];
  let recentEvents = [...((current.recentEvents as any[]) ?? [])];

  for (const event of newEvents) {
    eventCount++;
    const rawTs = event.timestamp;
    const ts = rawTs ? new Date(rawTs) : null;
    if (!ts || Number.isNaN(ts.getTime())) continue;

    if (!firstTs || ts < firstTs) firstTs = ts;
    if (!lastTs || ts > lastTs) lastTs = ts;

    const top = event.type ?? "unknown";
    const p: JsonObj = isObj(event.payload) ? event.payload : {};
    const ptype = asStr(p.type);

    // Capture metadata (cwd / model) from any envelope that carries it.
    const payloadCwd = asStr(p.cwd);
    if (payloadCwd) cwd = payloadCwd;
    const payloadModel = asStr(p.model);
    if (payloadModel) model = payloadModel;
    // session_meta carries the Codex CLI version.
    if (top === "session_meta") {
      const v = asStr(p.cli_version);
      if (v) version = v;
    }

    recentEvents.push({
      ts: rawTs,
      type: ptype ? `${top}.${ptype}` : top,
      summary: summarize(event),
    });
    if (recentEvents.length > 20) recentEvents = recentEvents.slice(-20);

    // ── event_msg: user-visible lifecycle + tool results ────────
    if (top === "event_msg" && ptype) {
      switch (ptype) {
        case "task_started": {
          inTurn = true;
          lastBoundaryTs = ts;
          break;
        }
        case "task_complete":
        case "turn_aborted": {
          inTurn = false;
          lastBoundaryTs = ts;
          break;
        }
        case "user_message": {
          const promptText = asStr(p.message);
          if (promptText) {
            userMsgs++;
            if (!title) title = promptText.split("\n")[0].slice(0, 80);
            lastUserPrompt = promptText.slice(0, 800);
            inTurn = true;
            lastBoundaryTs = ts;
          }
          break;
        }
        case "agent_message": {
          assistantMsgs++;
          break;
        }
        case "token_count": {
          // Codex emits cumulative `total_token_usage` plus a per-turn
          // `last_token_usage` delta. Increment with the delta to match
          // the Claude aggregator's additive model.
          const info = isObj(p.info) ? p.info : null;
          const last = info && isObj(info.last_token_usage)
            ? info.last_token_usage
            : null;
          if (last) {
            tokensIn += asNum(last.input_tokens);
            tokensOut += asNum(last.output_tokens);
            tokensCacheRead += asNum(last.cached_input_tokens);
            tokensReasoning += asNum(last.reasoning_output_tokens);
          }
          break;
        }
        case "exec_command_end":
        case "patch_apply_end":
        case "web_search_end": {
          const callId = asStr(p.call_id);
          if (callId) delete outstandingTools[callId];
          if (ptype === "exec_command_end") {
            const exitCode = asNum(p.exit_code);
            const status = asStr(p.status);
            if (exitCode !== 0 || (status && status !== "completed")) {
              toolErrors++;
            }
            // parsed_cmd is a structured description of what the exec did —
            // {type: "read"|"edit"|"write", path}. Use it to fill the
            // top-files buckets.
            if (Array.isArray(p.parsed_cmd)) {
              for (const parsed of p.parsed_cmd) {
                if (!isObj(parsed)) continue;
                const kind = asStr(parsed.type);
                const pathStr = asStr(parsed.path) ?? asStr(parsed.name);
                if (!kind || !pathStr) continue;
                if (kind === "read") incMap(filesRead, pathStr);
                else if (kind === "edit") incMap(filesEdited, pathStr);
                else if (kind === "write") incMap(filesWritten, pathStr);
              }
            }
          }
          break;
        }
      }
      continue;
    }

    // ── response_item: model-side tool calls ────────────────────
    if (top === "response_item" && ptype) {
      if (
        ptype === "function_call" ||
        ptype === "custom_tool_call" ||
        ptype === "web_search_call"
      ) {
        toolCalls++;
        const name = asStr(p.name) ?? ptype;
        incMap(toolNames, name);
        const callId = asStr(p.call_id);
        if (callId) {
          outstandingTools[callId] = {
            name,
            desc: asStr(p.arguments)?.slice(0, 120) ?? null,
            started: ts.getTime(),
          };
        }
      } else if (
        ptype === "function_call_output" ||
        ptype === "custom_tool_call_output"
      ) {
        const callId = asStr(p.call_id);
        if (callId) delete outstandingTools[callId];
      }
      continue;
    }
  }

  return {
    userMsgs,
    assistantMsgs,
    toolCalls,
    toolErrors,
    events: eventCount,
    tokensIn,
    tokensOut,
    tokensCacheRead,
    tokensCacheWrite,
    tokensReasoning,
    model,
    version,
    branch,
    cwd,
    firstTs,
    lastTs,
    title,
    inTurn,
    lastBoundaryTs,
    outstandingTools,
    lastUserPrompt,
    topFilesRead: topN(filesRead, 5),
    topFilesEdited: topN(filesEdited, 5),
    topFilesWritten: topN(filesWritten, 5),
    toolUseNames: topN(toolNames, 10),
    queued,
    recentEvents,
  };
}
