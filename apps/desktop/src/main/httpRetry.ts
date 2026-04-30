// Bounded retry + fetch timeout for the desktop's HTTP clients. Without these,
// a stalled TCP connection pins an uploader slot indefinitely and a transient
// 5xx discards the in-flight chunk until fs.watch happens to fire again.

export interface FetchTimeoutOpts {
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Wrap fetch with an AbortController that fires on timeout or on the caller's
 *  signal. Explicit clearTimeout in finally so a fast response doesn't leave
 *  the timer pinned to the event loop. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  opts: FetchTimeoutOpts,
): Promise<Response> {
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }
}

export interface RetryOpts {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

export class TransientHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`transient HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "TransientHttpError";
  }
}

export class PermanentHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`permanent HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "PermanentHttpError";
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof TransientHttpError) return true;
  if (err instanceof PermanentHttpError) return false;
  // Generic Error covers undici/fetch network failures and our timeout-driven
  // AbortError; both are worth one more try.
  return err instanceof Error;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === opts.attempts || !isRetryable(err)) throw err;
      const delay = Math.min(opts.baseDelayMs * 2 ** (attempt - 1), opts.maxDelayMs);
      opts.onRetry?.(attempt, delay, err instanceof Error ? err.message : String(err));
      await sleep(delay);
    }
  }
  // Loop always returns or throws above; this satisfies the type checker.
  throw new Error("withRetry: unreachable");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 408 (Request Timeout) and 429 (Too Many Requests) are explicit retry-now
 *  signals; 5xx is treated as transient; everything else is permanent. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
