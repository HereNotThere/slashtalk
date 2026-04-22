/**
 * Session aggregate computation from Claude JSONL events.
 * Replicates the server.py _ingest() logic for the hosted backend.
 *
 * Codex event aggregation is TBD; this module currently handles Claude only.
 */

// ── Types ────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, any>;
  tool_use_id?: string;
  is_error?: boolean;
}

export interface EventPayload {
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

export interface SessionUpdates {
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
  lastBoundaryTs: Date | null;
  outstandingTools: Record<string, { name: string; desc: string | null; started: number }>;
  lastUserPrompt: string | null;
  topFilesRead: Record<string, number>;
  topFilesEdited: Record<string, number>;
  topFilesWritten: Record<string, number>;
  toolUseNames: Record<string, number>;
  queued: Array<{ prompt: string; ts: string; mode: string | null }>;
  recentEvents: Array<{ ts: string; type: string; summary: string }>;
}

// ── Current session state (loaded from DB) ───────────────────

interface CurrentSession {
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

// ── Helpers ──────────────────────────────────────────────────

function isRealUserMessage(event: EventPayload): boolean {
  if (event.isMeta || event.isSidechain) return false;
  const content = event.message?.content;
  if (typeof content === "string") {
    if (content.startsWith("<local-command") || content.startsWith("<command"))
      return false;
  }
  return true;
}

function extractUserPromptText(event: EventPayload): string | null {
  const content = event.message?.content;
  if (!content) return null;
  if (typeof content === "string") return content;
  const textBlocks = content.filter((b) => b.type === "text" && b.text);
  return textBlocks.map((b) => b.text).join("\n") || null;
}

function summarizeEvent(event: EventPayload): string {
  if (event.type === "user") {
    const text = extractUserPromptText(event);
    return text ? text.slice(0, 80) : "(user message)";
  }
  if (event.type === "assistant") {
    const content = event.message?.content;
    if (Array.isArray(content)) {
      const toolUse = content.find((b) => b.type === "tool_use");
      if (toolUse) return `tool: ${toolUse.name}`;
      const thinking = content.find((b) => b.type === "thinking");
      if (thinking) return "thinking...";
      const text = content.find((b) => b.type === "text" && b.text);
      if (text) return text.text!.slice(0, 80);
    }
    return "(assistant)";
  }
  if (event.type === "attachment" && event.attachment?.type === "queued_command") {
    return `queued: ${(event.attachment.prompt ?? "").slice(0, 60)}`;
  }
  return event.type;
}

function incMap(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function topN(
  map: Record<string, number>,
  n: number
): Record<string, number> {
  const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(sorted.slice(0, n));
}

const FILE_TOOLS_READ = new Set(["Read"]);
const FILE_TOOLS_EDIT = new Set(["Edit", "MultiEdit"]);
const FILE_TOOLS_WRITE = new Set(["Write"]);

// ── Main aggregation ─────────────────────────────────────────

export function processEvents(
  current: CurrentSession,
  newEvents: EventPayload[]
): SessionUpdates {
  // Start from current accumulated state
  let userMsgs = current.userMsgs ?? 0;
  let assistantMsgs = current.assistantMsgs ?? 0;
  let toolCalls = current.toolCalls ?? 0;
  let toolErrors = current.toolErrors ?? 0;
  let eventCount = current.events ?? 0;
  let tokensIn = current.tokensIn ?? 0;
  let tokensOut = current.tokensOut ?? 0;
  let tokensCacheRead = current.tokensCacheRead ?? 0;
  let tokensCacheWrite = current.tokensCacheWrite ?? 0;
  const tokensReasoning = current.tokensReasoning ?? 0; // Claude doesn't emit
  let model = current.model;
  let version = current.version;
  let branch = current.branch;
  let cwd = current.cwd;
  let firstTs = current.firstTs;
  let lastTs = current.lastTs;
  let title = current.title;
  let inTurn = current.inTurn ?? false;
  let lastBoundaryTs = current.lastBoundaryTs;
  let outstandingTools = {
    ...((current.outstandingTools as Record<string, any>) ?? {}),
  };
  let lastUserPrompt = current.lastUserPrompt;
  const filesRead = { ...((current.topFilesRead as Record<string, number>) ?? {}) };
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
    // Some event types (e.g. `file-history-snapshot`) carry no top-level
    // timestamp — their timestamp lives on a nested payload and they hold
    // no aggregate-relevant data. Skip rather than letting an Invalid Date
    // poison the session row.
    const ts = event.timestamp ? new Date(event.timestamp) : null;
    if (!ts || Number.isNaN(ts.getTime())) continue;

    if (!firstTs || ts < firstTs) firstTs = ts;
    if (!lastTs || ts > lastTs) lastTs = ts;

    // Update metadata (latest non-null)
    if (event.cwd) cwd = event.cwd;
    if (event.gitBranch) branch = event.gitBranch;
    if (event.version) version = event.version;

    // Add to recent events (ring buffer of 20)
    recentEvents.push({
      ts: event.timestamp,
      type: event.type,
      summary: summarizeEvent(event),
    });
    if (recentEvents.length > 20) {
      recentEvents = recentEvents.slice(-20);
    }

    // ── Type-specific processing ─────────────────────────

    if (event.type === "user") {
      if (!event.isSidechain) userMsgs++;

      // Process tool_results in user message content
      const content = event.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            // Remove from outstanding tools
            delete outstandingTools[block.tool_use_id];
            if (block.is_error) toolErrors++;
          }
        }
      }

      // Track prompts and title
      if (isRealUserMessage(event)) {
        const promptText = extractUserPromptText(event);
        if (promptText) {
          if (!title) title = promptText.split("\n")[0].slice(0, 80);
          lastUserPrompt = promptText.slice(0, 800);
        }
        // Flip in_turn on real user message
        inTurn = true;
        lastBoundaryTs = ts;
      }
    }

    if (event.type === "assistant") {
      if (!event.isSidechain) assistantMsgs++;

      const msg = event.message;

      // Update model
      if (msg?.model) model = msg.model;

      // Token accounting — Claude 5m/1h cache writes both roll into
      // tokensCacheWrite. Pricing (which needs the split) is deferred.
      if (msg?.usage) {
        const u = msg.usage;
        tokensIn += u.input_tokens ?? 0;
        tokensOut += u.output_tokens ?? 0;
        tokensCacheRead += u.cache_read_input_tokens ?? 0;
        if (u.cache_creation) {
          tokensCacheWrite +=
            (u.cache_creation.ephemeral_5m_input_tokens ?? 0) +
            (u.cache_creation.ephemeral_1h_input_tokens ?? 0);
        } else if (u.cache_creation_input_tokens) {
          tokensCacheWrite += u.cache_creation_input_tokens;
        }
      }

      // Process content blocks (tool_use)
      if (Array.isArray(msg?.content)) {
        for (const block of msg!.content as ContentBlock[]) {
          if (block.type === "tool_use" && block.id && block.name) {
            toolCalls++;
            incMap(toolNames, block.name);

            // Track outstanding tool
            outstandingTools[block.id] = {
              name: block.name,
              desc: block.input
                ? `${block.name} ${JSON.stringify(block.input).slice(0, 60)}`
                : null,
              started: ts.getTime(),
            };

            // Track file operations
            const filePath =
              block.input?.file_path ?? block.input?.path ?? null;
            if (filePath && typeof filePath === "string") {
              if (FILE_TOOLS_READ.has(block.name)) incMap(filesRead, filePath);
              if (FILE_TOOLS_EDIT.has(block.name)) incMap(filesEdited, filePath);
              if (FILE_TOOLS_WRITE.has(block.name))
                incMap(filesWritten, filePath);
            }
          }
        }
      }

      // Turn boundary
      if (msg?.stop_reason === "end_turn") {
        inTurn = false;
        lastBoundaryTs = ts;
      }
    }

    if (event.type === "attachment") {
      if (
        event.attachment?.type === "queued_command" &&
        event.attachment.prompt &&
        !event.attachment.prompt.startsWith("<task-notification")
      ) {
        queued.push({
          prompt: event.attachment.prompt,
          ts: event.timestamp,
          mode: event.attachment.commandMode ?? null,
        });
        inTurn = true;
      }
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
