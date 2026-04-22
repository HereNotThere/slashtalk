import { config } from "./config";
import { db } from "./db";
import { RedisBridge } from "./ws/redis-bridge";
import { createApp } from "./app";

const redis = new RedisBridge();
await redis.connect();

const app = createApp(db, redis).listen(config.port);

console.log(`slashtalk server running on port ${config.port}`);

export type App = typeof app;
