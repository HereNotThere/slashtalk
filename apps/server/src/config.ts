const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
};

export const config = Object.freeze({
  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),
  githubClientId: required("GITHUB_CLIENT_ID"),
  githubClientSecret: required("GITHUB_CLIENT_SECRET"),
  jwtSecret: required("JWT_SECRET"),
  encryptionKey: required("ENCRYPTION_KEY"),
  baseUrl: required("BASE_URL"),
  port: parseInt(process.env.PORT || "10000", 10),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
  analyzerTickMs: parseInt(process.env.ANALYZER_TICK_MS || "300000", 10),
  analyzerMaxSessionsPerTick: parseInt(process.env.ANALYZER_MAX_SESSIONS_PER_TICK || "200", 10),
  analyzerConcurrency: parseInt(process.env.ANALYZER_CONCURRENCY || "5", 10),
  mcpRequestQuotaMax: parseInt(process.env.MCP_REQUEST_QUOTA_MAX || "600", 10),
  mcpRequestQuotaWindowMs: parseInt(process.env.MCP_REQUEST_QUOTA_WINDOW_MS || "60000", 10),
  mcpMaxConcurrentSessionsPerUser: parseInt(
    process.env.MCP_MAX_CONCURRENT_SESSIONS_PER_USER || "20",
    10,
  ),
  ingestConcurrency: parseInt(process.env.INGEST_CONCURRENCY || "4", 10),
  ingestBatchSize: parseInt(process.env.INGEST_BATCH_SIZE || "200", 10),
  // Bound the per-request body size and wall-clock — the streaming reader
  // accepts arbitrary input and the concurrency gate is a fixed pool, so a
  // single connection sending GBs slowly (or a single huge chunk) would
  // either exhaust memory or hold a slot for hours. Defaults: 50 MB / 60 s.
  ingestMaxBytes: parseInt(process.env.INGEST_MAX_BYTES || String(50 * 1024 * 1024), 10),
  ingestDeadlineMs: parseInt(process.env.INGEST_DEADLINE_MS || "60000", 10),
  // Postgres pool sizing. Without explicit limits the postgres.js default of
  // max=10/idle_timeout=0 means a deployment under load slowly accumulates
  // idle connections until the database refuses new ones. Production should
  // tune dbPoolMax against the Postgres `max_connections` budget divided by
  // replica count.
  dbPoolMax: parseInt(process.env.DB_POOL_MAX || "10", 10),
  dbIdleTimeoutSec: parseInt(process.env.DB_IDLE_TIMEOUT_SEC || "30", 10),
  dbConnectTimeoutSec: parseInt(process.env.DB_CONNECT_TIMEOUT_SEC || "10", 10),
  dbMaxLifetimeSec: parseInt(process.env.DB_MAX_LIFETIME_SEC || "1800", 10),
  // Hard ceiling on a single query's wall-clock — kills runaway analyzer or
  // feed queries before they drain the pool. Set on every new connection via
  // postgres.js `connection.statement_timeout`.
  dbStatementTimeoutMs: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || "30000", 10),
});

export type Config = typeof config;
