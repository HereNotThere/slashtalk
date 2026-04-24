import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  TextBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import { eq } from "drizzle-orm";
import type {
  ChatAssistantMessage,
  ChatCitation,
  ChatMessage,
} from "@slashtalk/shared";
import type { Database } from "../db";
import { repos, userRepos } from "../db/schema";
import { config } from "../config";
import { buildChatTools, type ChatToolDefinition } from "./tools";

const SYSTEM_PROMPT = `You are the slashtalk team-presence assistant. You answer questions about what the user's teammates are working on in Claude Code right now, using only the tools provided.

Tools:
- get_team_activity — per-teammate roll-up of recent sessions (call this first for open-ended questions)
- get_session — detail on a single session

Default behavior: for any question about "the team", "what's going on", "who's working on X", call get_team_activity first, then synthesize a per-teammate roll-up. One sentence per person. Name them explicitly. Mention the repo when it adds information.

Session states (computed, not stored) use these thresholds:
- busy: in a turn right now (model thinking or tool running)
- active: last event within ~30s
- idle: heartbeat fresh (<30s) but no recent event
- recent: any activity in the last hour
- ended: older than that

Citations: whenever you reference a session, append [session:<id>] after the sentence that cites it. The client turns these into interactive chips. Cite only sessions you actually received from a tool call. Do not fabricate IDs.

Tone: concise, factual, no preamble. Do not say "I'll call the tool" — just call it and answer. If the tools return no data, say so plainly. When referring to the caller, use second person ("you are…") rather than their login.`;

const MODEL = "claude-sonnet-4-6";
const MAX_ITERATIONS = 8;
const MAX_TOKENS = 4096;
// Round the injected timestamp to this bucket so the caller-context cache
// block survives a 5-minute prompt-cache TTL across back-to-back turns.
const TIMESTAMP_BUCKET_MS = 10 * 60 * 1000;
const MAX_REPOS_IN_PROMPT = 50;

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

export interface ChatCaller {
  id: number;
  githubLogin: string;
  displayName: string | null;
}

export interface RunChatParams {
  db: Database;
  user: ChatCaller;
  messages: ChatMessage[];
}

export async function runChatAgent(
  params: RunChatParams,
): Promise<ChatAssistantMessage> {
  const { db, user } = params;

  const visibleRepos = await db
    .select({ id: repos.id, fullName: repos.fullName })
    .from(userRepos)
    .innerJoin(repos, eq(repos.id, userRepos.repoId))
    .where(eq(userRepos.userId, user.id));

  const tools = buildChatTools(db, user.id, {
    visibleRepoIds: visibleRepos.map((r) => r.id),
  });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const toolDefs = tools.map(({ handler: _h, ...def }) => def);

  const messages: MessageParam[] = params.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const contextBlock = buildContextBlock(
    user,
    visibleRepos.map((r) => r.fullName),
  );
  const system: TextBlockParam[] = [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: contextBlock,
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

function buildContextBlock(user: ChatCaller, repoFullNames: string[]): string {
  const sortedRepos = [...repoFullNames].sort();
  const total = sortedRepos.length;
  const shownRepos =
    total > MAX_REPOS_IN_PROMPT
      ? `${sortedRepos.slice(0, MAX_REPOS_IN_PROMPT).join(", ")}, … and ${total - MAX_REPOS_IN_PROMPT} more`
      : sortedRepos.join(", ");

  const nameLine = user.displayName
    ? `Caller: @${user.githubLogin} (${user.displayName})`
    : `Caller: @${user.githubLogin}`;
  const repoLine =
    total === 0
      ? "Caller has no tracked repos yet — the team graph is empty."
      : `Visible repos (${total}): ${shownRepos}.`;
  const bucketedNow = new Date(
    Math.floor(Date.now() / TIMESTAMP_BUCKET_MS) * TIMESTAMP_BUCKET_MS,
  );

  return `<caller-context>
${nameLine}
Current time: ${bucketedNow.toISOString()}
${repoLine}
Presence is scoped to teammates who share any of these repos with the caller.
</caller-context>`;
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
