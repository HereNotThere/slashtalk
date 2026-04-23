import { config } from "./config";
import { db } from "./db";
import { RedisBridge } from "./ws/redis-bridge";
import { createApp } from "./app";
import { startScheduler } from "./analyzers";
import { startPrPoller } from "./social/pr-poller";

const redis = new RedisBridge();
await redis.connect();

const app = createApp(db, redis).listen(config.port);

startPrPoller(db, redis);
startScheduler(db, redis);

console.log(`slashtalk server running on port ${config.port}`);

export type App = typeof app;
