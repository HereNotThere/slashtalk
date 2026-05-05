export type RateLimitResult = { ok: true } | { ok: false; limit: number; windowMs: number };

export class SlidingWindowRateLimiter<K> {
  private readonly buckets = new Map<K, number[]>();

  constructor(
    private readonly options: { max: number; windowMs: number; sweepThreshold?: number },
  ) {}

  record(key: K): RateLimitResult {
    const now = Date.now();
    this.sweep(now);
    const cutoff = now - this.options.windowMs;
    const bucket = this.buckets.get(key)?.filter((ts) => ts > cutoff) ?? [];
    if (bucket.length >= this.options.max) {
      this.buckets.set(key, bucket);
      return { ok: false, limit: this.options.max, windowMs: this.options.windowMs };
    }

    bucket.push(now);
    this.buckets.set(key, bucket);
    return { ok: true };
  }

  clear(): void {
    this.buckets.clear();
  }

  private sweep(now: number): void {
    const threshold = this.options.sweepThreshold;
    if (!threshold || this.buckets.size < threshold) return;
    const cutoff = now - this.options.windowMs;
    for (const [key, timestamps] of this.buckets) {
      const fresh = timestamps.filter((ts) => ts > cutoff);
      if (fresh.length === 0) this.buckets.delete(key);
      else if (fresh.length !== timestamps.length) this.buckets.set(key, fresh);
    }
  }
}
