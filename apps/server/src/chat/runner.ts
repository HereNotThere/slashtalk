import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  ChatAssistantMessage,
  ChatCitation,
  ChatMessage,
} from "@slashtalk/shared";
import type { Database } from "../db";
import { config } from "../config";
import { createChatMcpServer } from "./tools";

const SYSTEM_PROMPT = `You are the slashtalk team-presence assistant. You answer questions about what the user's teammates are working on in Claude Code right now, using only the tools provided.

Tools:
- get_team_activity — per-teammate roll-up of recent sessions (call this first for open-ended questions)
- get_session — detail on a single session

Default behavior: for any question about "the team", "what's going on", "who's working on X", call get_team_activity first, then synthesize a per-teammate roll-up. One sentence per person. Name them explicitly. Mention the repo when it adds information.

Citations: whenever you reference a session, append [session:<id>] after the sentence that cites it. The client turns these into interactive chips. Cite only sessions you actually received from a tool call. Do not fabricate IDs.

Tone: concise, factual, no preamble. Do not say "I'll call the tool" — just call it and answer. If the tools return no data, say so plainly.`;

export interface RunChatParams {
  db: Database;
  userId: number;
  messages: ChatMessage[];
}

export async function runChatAgent(
  params: RunChatParams,
): Promise<ChatAssistantMessage> {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  const mcp = createChatMcpServer(params.db, params.userId);
  const prompt = renderPrompt(params.messages);

  const q = query({
    prompt,
    options: {
      model: "claude-sonnet-4-6",
      systemPrompt: SYSTEM_PROMPT,
      // Empty array disables all built-in Claude Code tools; only our MCP
      // tools remain. Keep the agent sandboxed — no Bash, no file access.
      tools: [],
      mcpServers: { slashtalk: mcp },
      allowedTools: [
        "mcp__slashtalk__get_team_activity",
        "mcp__slashtalk__get_session",
      ],
      maxTurns: 8,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: config.anthropicApiKey,
      },
    },
  });

  let content = "";
  for await (const msg of q) {
    if (msg.type === "result") {
      if (msg.subtype === "success") {
        content = msg.result;
      } else {
        throw new Error(`agent ended without success: ${msg.subtype}`);
      }
      break;
    }
  }

  return {
    role: "assistant",
    content,
    citations: extractCitations(content),
  };
}

/**
 * The Agent SDK's `prompt` only accepts user-side messages — we can't pre-seed
 * assistant turns. Flatten prior history into a context block inside a single
 * user message so the agent sees the thread as user-supplied text. The client
 * still stores messages in the clean alternating shape.
 */
function renderPrompt(messages: ChatMessage[]): string {
  if (messages.length === 0) {
    throw new Error("messages must be non-empty");
  }
  const last = messages[messages.length - 1];
  if (last.role !== "user") {
    throw new Error("last message must be role=user");
  }
  if (messages.length === 1) return last.content;

  const history = messages
    .slice(0, -1)
    .map((m) => {
      const label = m.role === "user" ? "User" : "Assistant";
      return `${label}: ${m.content}`;
    })
    .join("\n\n");
  return `Prior conversation:\n${history}\n\nLatest user question: ${last.content}`;
}

function extractCitations(text: string): ChatCitation[] {
  const ids = new Set<string>();
  const regex = /\[session:([0-9a-fA-F-]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    ids.add(match[1]);
  }
  return [...ids].map((sessionId) => ({
    sessionId,
    reason: "cited in answer",
  }));
}
