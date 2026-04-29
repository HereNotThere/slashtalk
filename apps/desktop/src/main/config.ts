// Single source of truth for desktop env-derived config. Each value follows
// the same precedence: runtime `process.env.X` (ad-hoc local override) →
// `import.meta.env.MAIN_VITE_X` baked in at build time by electron-vite →
// hard-coded default. Centralizing the resolution avoids drift between the
// 3+ sites that previously each redeclared their own `BAKED_*` constants and
// fallback chains. The local MCP proxy default is port-zero; persisted runtime
// port reuse lives in localMcpProxyPort.ts, not env config.

const DEFAULT_API_BASE_URL = "https://slashtalk.onrender.com";

const BAKED_API_BASE_URL = import.meta.env.MAIN_VITE_SLASHTALK_API_URL as string | undefined;
const BAKED_MCP_URL = import.meta.env.MAIN_VITE_SLASHTALK_MCP_URL as string | undefined;
const BAKED_GITHUB_CLIENT_ID = import.meta.env.MAIN_VITE_GITHUB_CLIENT_ID as string | undefined;

export function apiBaseUrl(): string {
  return process.env["SLASHTALK_API_URL"] ?? BAKED_API_BASE_URL ?? DEFAULT_API_BASE_URL;
}

export function mcpUrl(): string {
  return process.env["SLASHTALK_MCP_URL"] ?? BAKED_MCP_URL ?? `${apiBaseUrl()}/mcp`;
}

export function localMcpPortOverride(): number | null {
  const raw = process.env["SLASHTALK_LOCAL_MCP_PORT"];
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid SLASHTALK_LOCAL_MCP_PORT: ${raw}`);
  }
  return port;
}

export function anthropicApiKeyFromEnv(): string | null {
  return process.env["ANTHROPIC_API_KEY"] ?? null;
}

export function githubScope(): string {
  return process.env["GITHUB_SCOPE"] ?? "repo read:user read:org";
}

export function githubClientId(): string {
  return process.env["GITHUB_CLIENT_ID"] ?? BAKED_GITHUB_CLIENT_ID ?? "";
}
