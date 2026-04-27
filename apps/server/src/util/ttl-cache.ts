/**
 * Bounded TTL cache. Entries expire after `ttlMs`; expired entries are
 * dropped lazily on `get`. When the map grows past `sweepThreshold`, the
 * next `set` triggers an opportunistic full sweep so a long-lived process
 * can't grow the map without bound.
 */
export class TtlCache<K, V> {
  private readonly map = new Map<K, { at: number; value: V }>();

  constructor(
    private readonly ttlMs: number,
    private readonly sweepThreshold = 5_000,
  ) {}

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at >= this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    this.map.set(key, { at: Date.now(), value });
    if (this.map.size >= this.sweepThreshold) this.sweep();
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, entry] of this.map) {
      if (entry.at <= cutoff) this.map.delete(key);
    }
  }
}
