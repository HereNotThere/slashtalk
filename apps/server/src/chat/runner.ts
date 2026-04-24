import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  TextBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  ChatAssistantMessage,
  ChatCitation,
  ChatMessage,
} from "@slashtalk/shared";
import type { Database } from "../db";
import { config } from "../config";
import { buildChatTools, type ChatToolDefinition } from "./tools";

const SYSTEM_PROMPT = `You are the slashtalk team-presence assistant. You answer questions about what the user's teammates are working on in Claude Code right now, using only the tools provided.

Tools:
- get_team_activity — per-teammate roll-up of recent sessions (call this first for open-ended questions)
- get_session — detail on a single session

Default behavior: for any question about "the team", "what's going on", "who's working on X", call get_team_activity first, then synthesize a per-teammate roll-up. One sentence per person. Name them explicitly. Mention the repo when it adds information.

Citations: whenever you reference a session, append [session:<id>] after the sentence that cites it. The client turns these into interactive chips. Cite only sessions you actually received from a tool call. Do not fabricate IDs.

Tone: concise, factual, no preamble. Do not say "I'll call the tool" — just call it and answer. If the tools return no data, say so plainly.`;

const MODEL = "claude-sonnet-4-6";
const MAX_ITERATIONS = 8;
const MAX_TOKENS = 4096;

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!config.anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY not set");
    }
    _client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return _client;
}

export interface RunChatParams {
  db: Database;
  userId: number;
  messages: ChatMessage[];
}

export async function runChatAgent(
  params: RunChatParams,
): Promise<ChatAssistantMessage> {
  const tools = buildChatTools(params.db, params.userId);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const toolDefs = tools.map(({ handler: _h, ...def }) => def);

  const messages: MessageParam[] = params.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const system: TextBlockParam[] = [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
  ];

  let finalText = "";

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const resp = await client().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools: toolDefs,
      messages,
    });

    const textBlocks = resp.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text);
    if (textBlocks.length > 0) finalText = textBlocks.join("\n");

    if (resp.stop_reason !== "tool_use") break;

    messages.push({ role: "assistant", content: resp.content });

    const toolUses = resp.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );
    const toolResults: ToolResultBlockParam[] = await Promise.all(
      toolUses.map((use) => runToolCall(use, byName)),
    );
    messages.push({ role: "user", content: toolResults });
  }

  return {
    role: "assistant",
    content: finalText,
    citations: extractCitations(finalText),
  };
}

async function runToolCall(
  use: ToolUseBlock,
  byName: Map<string, ChatToolDefinition>,
): Promise<ToolResultBlockParam> {
  const tool = byName.get(use.name);
  if (!tool) {
    return {
      type: "tool_result",
      tool_use_id: use.id,
      content: `unknown tool: ${use.name}`,
      is_error: true,
    };
  }
  try {
    const result = await tool.handler(use.input as Record<string, unknown>);
    return {
      type: "tool_result",
      tool_use_id: use.id,
      content: result.content,
      is_error: result.isError,
    };
  } catch (err) {
    return {
      type: "tool_result",
      tool_use_id: use.id,
      content: (err as Error).message,
      is_error: true,
    };
  }
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
