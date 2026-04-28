import { PRICING, type ModelId } from "../models";
import { getAnthropicClient } from "./anthropic-client";

export interface StructuredCallParams {
  model: ModelId;
  system: string;
  prompt: string;
  toolName: string;
  toolDescription: string;
  schema: object;
  maxTokens?: number;
}

export interface StructuredCallResult<T> {
  output: T;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  costUsd: number;
}

export async function callStructured<T>(
  params: StructuredCallParams,
): Promise<StructuredCallResult<T>> {
  const resp = await getAnthropicClient().messages.create({
    model: params.model,
    max_tokens: params.maxTokens ?? 1024,
    system: [
      {
        type: "text",
        text: params.system,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [
      {
        name: params.toolName,
        description: params.toolDescription,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input_schema: params.schema as any,
      },
    ],
    tool_choice: { type: "tool", name: params.toolName },
    messages: [{ role: "user", content: params.prompt }],
  });

  const toolUse = resp.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("LLM response contained no tool_use block");
  }
  const output = toolUse.input as T;

  const usage = resp.usage;
  const tokensIn = usage.input_tokens ?? 0;
  const tokensOut = usage.output_tokens ?? 0;
  const tokensCacheRead = usage.cache_read_input_tokens ?? 0;
  const tokensCacheWrite = usage.cache_creation_input_tokens ?? 0;

  const pricing = PRICING[params.model];
  const costUsd =
    (tokensIn * pricing.in) / 1_000_000 +
    (tokensOut * pricing.out) / 1_000_000 +
    (tokensCacheRead * pricing.cacheRead) / 1_000_000 +
    (tokensCacheWrite * pricing.in * 1.25) / 1_000_000;

  return { output, tokensIn, tokensOut, tokensCacheRead, costUsd };
}
