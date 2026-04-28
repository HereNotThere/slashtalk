import Redis from "ioredis";
import { config } from "../config";

type MessageHandler = (channel: string, message: string) => void;

/**
 * Manages Redis pub/sub → WebSocket forwarding.
 * Uses separate publisher and subscriber connections (ioredis requirement).
 */
export class RedisBridge {
  private pub: Redis;
  private sub: Redis;
  private handlers = new Map<string, Set<MessageHandler>>();

  private connected = false;

  constructor() {
    const opts = { lazyConnect: true, retryStrategy: () => null } as const;
    this.pub = new Redis(config.redisUrl, opts);
    this.sub = new Redis(config.redisUrl, opts);

    this.sub.on("message", (channel, message) => {
      const channelHandlers = this.handlers.get(channel);
      if (channelHandlers) {
        for (const handler of channelHandlers) {
          handler(channel, message);
        }
      }
    });
  }

  async connect(): Promise<void> {
    try {
      await Promise.all([this.pub.connect(), this.sub.connect()]);
      this.connected = true;
      console.log("Redis connected");
    } catch (err) {
      console.warn("Redis connection failed, pub/sub disabled:", (err as Error).message);
    }
  }

  /** Publish a message to a channel. Soft-fail: never throws, never blocks
   *  the caller on Redis I/O. Callers should fire-and-forget (`void
   *  bridge.publish(...)`) — see CLAUDE.md rule #7. */
  async publish(channel: string, message: object): Promise<void> {
    if (!this.connected) return;
    try {
      await this.pub.publish(channel, JSON.stringify(message));
    } catch (err) {
      console.warn(`[redis] publish to ${channel} failed:`, (err as Error).message);
    }
  }

  /** Set a JSON-encoded value with a TTL in seconds. Used for ephemeral
   *  presence state (Spotify "now playing"). No-op when Redis is down or
   *  drops mid-call — `connected` only flips on initial connect, so callers
   *  can't rely on it to short-circuit a disconnected client. */
  async setex(key: string, seconds: number, value: object): Promise<void> {
    if (!this.connected) return;
    try {
      await this.pub.setex(key, seconds, JSON.stringify(value));
    } catch (err) {
      console.warn(`[redis] setex ${key} failed:`, (err as Error).message);
    }
  }

  /** Read a JSON-encoded value. Returns null if missing, expired, malformed,
   *  or when Redis is unavailable. */
  async getJson<T>(key: string): Promise<T | null> {
    if (!this.connected) return null;
    let raw: string | null;
    try {
      raw = await this.pub.get(key);
    } catch (err) {
      console.warn(`[redis] get ${key} failed:`, (err as Error).message);
      return null;
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** Delete a key. No-op when Redis is unavailable. */
  async del(key: string): Promise<void> {
    if (!this.connected) return;
    try {
      await this.pub.del(key);
    } catch (err) {
      console.warn(`[redis] del ${key} failed:`, (err as Error).message);
    }
  }

  /** Read a numeric counter as a float. Returns 0 on miss, malformed value,
   *  or when Redis is unavailable. Paired with `incrFloat` on the write
   *  side; if writes also no-op the budget is effectively off until Redis
   *  recovers. */
  async getFloat(key: string): Promise<number> {
    if (!this.connected) return 0;
    let raw: string | null;
    try {
      raw = await this.pub.get(key);
    } catch (err) {
      console.warn(`[redis] get ${key} failed:`, (err as Error).message);
      return 0;
    }
    if (!raw) return 0;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  }

  /** INCRBYFLOAT a counter and ensure it has a TTL. Pipelined so the EXPIRE
   *  rides the same round-trip. Returns the new value, or null when Redis
   *  is unavailable or the increment failed. Soft-fail is load-bearing here:
   *  callers (`recordLlmSpend`) run *after* a paid Anthropic API result, so
   *  a Redis blip must not surface as a thrown error that discards the
   *  already-billed response. */
  async incrFloat(key: string, by: number, ttlSeconds: number): Promise<number | null> {
    if (!this.connected) return null;
    try {
      const pipe = this.pub.pipeline();
      pipe.incrbyfloat(key, by);
      pipe.expire(key, ttlSeconds);
      const results = await pipe.exec();
      const incr = results?.[0];
      if (!incr || incr[0]) return null;
      const raw = incr[1];
      if (typeof raw !== "string") return null;
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) ? n : null;
    } catch (err) {
      console.warn(`[redis] incrFloat ${key} failed:`, (err as Error).message);
      return null;
    }
  }

  /** Atomic GETDEL — read a JSON-encoded value and remove it in one
   *  round-trip. Returns null on miss, malformed JSON, or when Redis is
   *  unavailable. Use when single-use semantics matter (e.g. OAuth state
   *  nonces), since `getJson` + `del` is racy under concurrent consumers. */
  async getJsonAndDel<T>(key: string): Promise<T | null> {
    if (!this.connected) return null;
    let raw: string | null;
    try {
      raw = await this.pub.getdel(key);
    } catch (err) {
      console.warn(`[redis] getdel ${key} failed:`, (err as Error).message);
      return null;
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** Subscribe a handler to a channel */
  async subscribe(channel: string, handler: MessageHandler): Promise<void> {
    if (!this.connected) return;
    let channelHandlers = this.handlers.get(channel);
    if (!channelHandlers) {
      channelHandlers = new Set();
      this.handlers.set(channel, channelHandlers);
      await this.sub.subscribe(channel);
    }
    channelHandlers.add(handler);
  }

  /** Unsubscribe a handler from a channel */
  async unsubscribe(channel: string, handler: MessageHandler): Promise<void> {
    const channelHandlers = this.handlers.get(channel);
    if (!channelHandlers) return;
    channelHandlers.delete(handler);
    if (channelHandlers.size === 0) {
      this.handlers.delete(channel);
      await this.sub.unsubscribe(channel);
    }
  }

  /** Unsubscribe a handler from all channels */
  async unsubscribeAll(handler: MessageHandler): Promise<void> {
    for (const [channel, handlers] of this.handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.handlers.delete(channel);
        await this.sub.unsubscribe(channel);
      }
    }
  }

  async disconnect(): Promise<void> {
    this.sub.disconnect();
    this.pub.disconnect();
  }
}
