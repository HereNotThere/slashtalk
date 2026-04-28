import { afterEach, describe, expect, it } from "bun:test";
import {
  PermanentHttpError,
  TransientHttpError,
  fetchWithTimeout,
  isTransientStatus,
  withRetry,
} from "../src/main/httpRetry";

describe("isTransientStatus", () => {
  it("treats 5xx, 408, 429 as transient", () => {
    expect(isTransientStatus(500)).toBe(true);
    expect(isTransientStatus(503)).toBe(true);
    expect(isTransientStatus(408)).toBe(true);
    expect(isTransientStatus(429)).toBe(true);
  });
  it("treats other 4xx as permanent", () => {
    expect(isTransientStatus(400)).toBe(false);
    expect(isTransientStatus(401)).toBe(false);
    expect(isTransientStatus(404)).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns immediately on first success", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return "ok";
      },
      { attempts: 3, baseDelayMs: 1, maxDelayMs: 10 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries transient HTTP errors and eventually succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new TransientHttpError(503, "down");
        return "ok";
      },
      { attempts: 4, baseDelayMs: 1, maxDelayMs: 10 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry permanent HTTP errors", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new PermanentHttpError(401, "unauthorized");
        },
        { attempts: 3, baseDelayMs: 1, maxDelayMs: 10 },
      ),
    ).rejects.toThrow(/permanent HTTP 401/);
    expect(calls).toBe(1);
  });

  it("retries generic network errors", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error("ECONNRESET");
        return 42;
      },
      { attempts: 3, baseDelayMs: 1, maxDelayMs: 10 },
    );
    expect(result).toBe(42);
    expect(calls).toBe(2);
  });

  it("gives up after the attempt budget and surfaces the last error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new TransientHttpError(503, "still down");
        },
        { attempts: 3, baseDelayMs: 1, maxDelayMs: 10 },
      ),
    ).rejects.toThrow(/transient HTTP 503/);
    expect(calls).toBe(3);
  });

  it("invokes onRetry between attempts but not after the final failure", async () => {
    const events: Array<{ attempt: number; delay: number }> = [];
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new TransientHttpError(500, "fail");
        },
        {
          attempts: 3,
          baseDelayMs: 1,
          maxDelayMs: 10,
          onRetry: (attempt, delay) => events.push({ attempt, delay }),
        },
      ),
    ).rejects.toBeInstanceOf(TransientHttpError);
    expect(calls).toBe(3);
    expect(events).toHaveLength(2);
    expect(events[0]?.attempt).toBe(1);
    expect(events[1]?.attempt).toBe(2);
  });
});

describe("fetchWithTimeout", () => {
  let originalFetch: typeof fetch;
  function stubAbortableFetch(): void {
    originalFetch = globalThis.fetch;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const fail = (): void => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (init?.signal?.aborted) {
          fail();
          return;
        }
        init?.signal?.addEventListener("abort", fail, { once: true });
      });
    }) as typeof fetch;
  }
  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  it("aborts when the timeout elapses before the response", async () => {
    stubAbortableFetch();
    await expect(
      fetchWithTimeout("http://example.invalid/", { method: "GET" }, { timeoutMs: 5 }),
    ).rejects.toThrow();
  });

  it("honors a caller-provided AbortSignal alongside the timeout", async () => {
    stubAbortableFetch();
    const ac = new AbortController();
    const promise = fetchWithTimeout(
      "http://example.invalid/",
      { method: "GET" },
      { timeoutMs: 60_000, signal: ac.signal },
    );
    ac.abort();
    await expect(promise).rejects.toThrow();
  });

  it("respects an already-aborted caller signal", async () => {
    stubAbortableFetch();
    const ac = new AbortController();
    ac.abort();
    await expect(
      fetchWithTimeout(
        "http://example.invalid/",
        { method: "GET" },
        { timeoutMs: 60_000, signal: ac.signal },
      ),
    ).rejects.toThrow();
  });
});
