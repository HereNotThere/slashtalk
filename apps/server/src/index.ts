import { config } from "./config";
import { db } from "./db";
import { RedisBridge } from "./ws/redis-bridge";
import { createApp } from "./app";
import { startScheduler } from "./analyzers";
import { startPrPoller } from "./social/pr-poller";

// Log + exit so the supervisor (systemd/Docker/etc.) restarts a clean process
// instead of letting it limp along in an undefined state. Matches Node's
// default behavior, which the mere presence of a listener would otherwise
// suppress.
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection:", reason);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", err);
  process.exit(1);
});

const redis = new RedisBridge();
await redis.connect();

const app = createApp(db, redis).listen(config.port);

startPrPoller(db, redis);
startScheduler(db, redis);

console.log(`slashtalk server running on port ${config.port}`);

export type App = typeof app;
