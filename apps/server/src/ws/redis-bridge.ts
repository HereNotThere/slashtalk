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

  /** Publish a message to a channel */
  async publish(channel: string, message: object): Promise<void> {
    if (!this.connected) return;
    await this.pub.publish(channel, JSON.stringify(message));
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
