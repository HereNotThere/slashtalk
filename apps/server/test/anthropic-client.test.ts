import { describe, expect, it } from "bun:test";
import { getAnthropicClient } from "../src/analyzers/anthropic-client";
import { config } from "../src/config";

describe("getAnthropicClient", () => {
  it("throws a clear error when ANTHROPIC_API_KEY is unset", () => {
    // Test env doesn't set ANTHROPIC_API_KEY — see test/preload.ts. The
    // factory must throw rather than constructing a client with an empty
    // key, since silent failure surfaces as cryptic 401s deep in the SDK.
    if (config.anthropicApiKey) {
      // CI may set the key; skip this assertion in that case rather than
      // forcing an env shape on contributors.
      return;
    }
    expect(() => getAnthropicClient()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("memoizes the client across calls", () => {
    if (!config.anthropicApiKey) return;
    expect(getAnthropicClient()).toBe(getAnthropicClient());
  });
});
