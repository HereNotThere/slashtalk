import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { config } from "../src/config";
import {
  LlmBudgetExceededError,
  SPEND_KEY_PREFIX,
  checkLlmBudget,
  recordLlmSpend,
} from "../src/analyzers/llm-budget";
import { RedisBridge } from "../src/ws/redis-bridge";

let redis: RedisBridge;

const userIdA = 90_001;
const userIdB = 90_002;

beforeAll(async () => {
  redis = new RedisBridge();
  await redis.connect();
  // Clear any prior-day spend records so the first assertion sees zero —
  // Redis state survives between `bun test` invocations.
  const today = new Date().toISOString().slice(0, 10);
  for (const id of [userIdA, userIdB]) {
    await redis.del(`${SPEND_KEY_PREFIX}:${id}:${today}`);
  }
});

afterAll(async () => {
  await redis.disconnect();
});

describe("llm budget", () => {
  it("admits a fresh user with zero spend", async () => {
    const check = await checkLlmBudget(redis, userIdA);
    expect(check.allowed).toBe(true);
    expect(check.spentUsd).toBe(0);
    expect(check.capUsd).toBe(config.llmDailyBudgetUsd);
  });

  it("admits the call after recording spend below the cap", async () => {
    await recordLlmSpend(redis, userIdA, 0.001);
    const check = await checkLlmBudget(redis, userIdA);
    expect(check.allowed).toBe(true);
    expect(check.spentUsd).toBeGreaterThanOrEqual(0.001);
  });

  it("rejects the call once spend exceeds the cap", async () => {
    // Push the counter just past the configured cap.
    await recordLlmSpend(redis, userIdA, config.llmDailyBudgetUsd + 1);
    const check = await checkLlmBudget(redis, userIdA);
    expect(check.allowed).toBe(false);
    expect(check.spentUsd).toBeGreaterThan(config.llmDailyBudgetUsd);
  });

  it("scopes spend per user — userIdA's overrun doesn't block userIdB", async () => {
    const check = await checkLlmBudget(redis, userIdB);
    expect(check.allowed).toBe(true);
  });

  it("formats LlmBudgetExceededError with structured fields", () => {
    const err = new LlmBudgetExceededError(42, 7.5, 5);
    expect(err.code).toBe("llm_budget_exceeded");
    expect(err.userId).toBe(42);
    expect(err.spentUsd).toBe(7.5);
    expect(err.capUsd).toBe(5);
    expect(err.message).toContain("user 42");
    expect(err.message).toContain("$7.50");
  });

  it("recordLlmSpend never throws even if the underlying Redis op rejects", async () => {
    // The call site runs after a paid Anthropic API result is in hand —
    // a Redis blip must not surface as a thrown error that loses the
    // already-billed response. Stub incrFloat to throw and confirm the
    // helper still resolves.
    const fakeRedis = {
      incrFloat: async () => {
        throw new Error("ECONNRESET");
      },
    } as unknown as RedisBridge;
    await expect(recordLlmSpend(fakeRedis, userIdA, 0.001)).resolves.toBeUndefined();
  });
});
