import * as store from "./store";

const STORE_KEY = "localMcpProxyPort";

let cachedPort: number | null | undefined;

function validPort(value: unknown): number | null {
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > 65_535) {
    return null;
  }
  return value as number;
}

function storedPort(value: unknown): number | null {
  if (typeof value === "number") return validPort(value);
  if (value && typeof value === "object" && "port" in value) {
    return validPort((value as { port: unknown }).port);
  }
  return null;
}

export function getSavedLocalMcpPort(): number | null {
  if (cachedPort !== undefined) return cachedPort;

  const raw = store.get<unknown>(STORE_KEY);
  if (raw === undefined) {
    cachedPort = null;
    return cachedPort;
  }

  cachedPort = storedPort(raw);
  if (cachedPort === null) store.del(STORE_KEY);
  return cachedPort;
}

export function saveSavedLocalMcpPort(port: number): void {
  const next = validPort(port);
  if (next === null) throw new Error(`Invalid local MCP proxy port: ${port}`);
  cachedPort = next;
  store.set(STORE_KEY, { port: next });
}

export function resetLocalMcpProxyPortCacheForTests(): void {
  cachedPort = undefined;
}

export function clearSavedLocalMcpPortForTests(): void {
  cachedPort = undefined;
  store.del(STORE_KEY);
}
