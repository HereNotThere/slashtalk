import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";

// Single shared Anthropic client for the server. Memoized so concurrent
// callers share an HTTP/2 pool and the SDK's retry budget. Timeout and
// retry counts come from `config` so a misbehaving deploy can be reined
// in without a code change.
let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (_client) return _client;
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  _client = new Anthropic({
    apiKey: config.anthropicApiKey,
    timeout: config.anthropicTimeoutMs,
    maxRetries: config.anthropicMaxRetries,
  });
  return _client;
}

export function setAnthropicClientForTest(client: Anthropic | null): () => void {
  const prior = _client;
  _client = client;
  return () => {
    _client = prior;
  };
}
