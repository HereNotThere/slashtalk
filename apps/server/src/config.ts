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
  // Rooms prototype (microVM agent rooms). Disabled unless ROOMS_ENABLED=true,
  // in which case E2B_API_KEY is required.
  roomsEnabled: process.env.ROOMS_ENABLED === "true",
  e2bApiKey:
    process.env.ROOMS_ENABLED === "true"
      ? required("E2B_API_KEY")
      : (process.env.E2B_API_KEY ?? null),
  roomsIdlePauseMs: parseInt(process.env.ROOMS_IDLE_PAUSE_MS || "600000", 10), // 10 min
  roomsHardReapMs: parseInt(process.env.ROOMS_HARD_REAP_MS || "86400000", 10), // 24 h
  orgMembershipRefreshMs: parseInt(process.env.ORG_MEMBERSHIP_REFRESH_MS || "900000", 10), // 15 min
});

export type Config = typeof config;
