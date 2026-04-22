// Store a JSON value encrypted at rest via OS-level secret storage
// (Keychain on macOS, DPAPI on Windows, kwallet/libsecret on Linux).
// The blob on disk is base64(safeStorage.encrypt(json)).

import { safeStorage } from "electron";
import * as store from "./store";

export function saveEncrypted(key: string, value: unknown): void {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn(`[safeStore] encryption unavailable; ${key} not persisted`);
    return;
  }
  const enc = safeStorage.encryptString(JSON.stringify(value));
  store.set(key, enc.toString("base64"));
}

export function loadEncrypted<T>(key: string): T | null {
  const raw = store.get<string>(key);
  if (!raw) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const plain = safeStorage.decryptString(Buffer.from(raw, "base64"));
    return JSON.parse(plain) as T;
  } catch {
    store.del(key);
    return null;
  }
}

export function clearEncrypted(key: string): void {
  store.del(key);
}
