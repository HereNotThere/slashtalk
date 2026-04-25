import { randomBytes } from "node:crypto";
import { loadEncrypted, saveEncrypted } from "./safeStore";

const STORE_KEY = "localMcpProxySecretEnc";

let cachedSecret: string | null = null;

export function getLocalMcpProxySecret(): string {
  if (cachedSecret) return cachedSecret;

  const stored = loadEncrypted<{ secret: string }>(STORE_KEY);
  if (typeof stored?.secret === "string" && stored.secret.length > 0) {
    cachedSecret = stored.secret;
    return cachedSecret;
  }

  cachedSecret = randomBytes(32).toString("base64url");
  saveEncrypted(STORE_KEY, { secret: cachedSecret });
  return cachedSecret;
}
