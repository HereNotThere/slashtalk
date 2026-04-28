// Polls ~/.claude.json (the Claude Code main config file) and broadcasts the
// user's plan tier as a QuotaPresence. Mirrors the shape of spotify.ts:
// debounce identical payloads, keepalive every few minutes so the server's
// Redis TTL doesn't drop us, soft-fail on every error.
//
// Why we only report `plan` (not 5h / weekly windows): see the header of
// claudeQuotaParse.ts. Anthropic doesn't persist live rate-limit state to
// disk; we surface what we have honestly rather than guessing.

import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import * as backend from "./backend";
import {
  parseClaudeQuotaFromConfig,
  sameClaudeQuota,
  type ParsedClaudeQuota,
} from "./claudeQuotaParse";

// Plan tier moves on the order of weeks (subscription changes), not seconds.
// Poll modestly so a fresh sign-in is reflected within a couple of minutes
// without thrashing the disk read.
const POLL_MS = 2 * 60_000;
// Re-POST the same value periodically so the server's Redis TTL (24h, see
// presence/quota.ts) doesn't drop us if we happen to never change. With a
// 24h TTL we have huge slack here; 30 min is plenty of headroom.
const KEEPALIVE_MS = 30 * 60_000;

const CONFIG_PATH = path.join(os.homedir(), ".claude.json");

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastSent: ParsedClaudeQuota | null = null;
let lastSentAt = 0;

async function read(): Promise<ParsedClaudeQuota | null> {
  let text: string;
  try {
    text = await fsp.readFile(CONFIG_PATH, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn("[claudeQuota] readFile failed:", (err as Error).message);
    }
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (err) {
    // ~/.claude.json gets rewritten in place — a torn read is rare but
    // possible. Treat as transient: skip this tick.
    console.warn("[claudeQuota] JSON parse failed:", (err as Error).message);
    return null;
  }

  return parseClaudeQuotaFromConfig(parsedJson);
}

async function tick(): Promise<void> {
  if (!running) return;
  const next = await read();
  const now = Date.now();
  if (next) {
    const changed = !sameClaudeQuota(lastSent, next);
    const stale = now - lastSentAt > KEEPALIVE_MS;
    if (!changed && !stale) return;
    try {
      await backend.postQuotaPresence("claude", { plan: next.plan, windows: next.windows });
      lastSent = next;
      lastSentAt = now;
      if (changed) console.log(`[claudeQuota] → plan=${next.plan ?? "(none)"}`);
    } catch (err) {
      console.warn("[claudeQuota] post failed:", (err as Error).message);
    }
  } else if (lastSent !== null) {
    try {
      await backend.postQuotaPresence("claude", null);
      // Only mark as cleared after the server confirms — otherwise a transient
      // POST failure would suppress every subsequent retry until the user's
      // plan actually changes, leaving stale presence visible for up to 24h
      // (the Redis TTL).
      lastSent = null;
      lastSentAt = now;
      console.log("[claudeQuota] cleared");
    } catch (err) {
      console.warn("[claudeQuota] clear failed:", (err as Error).message);
    }
  }
}

export async function start(): Promise<void> {
  if (running) return;
  running = true;
  lastSent = null;
  lastSentAt = 0;
  await tick();
  timer = setInterval(() => void tick(), POLL_MS);
}

export function stop(): void {
  if (!running) return;
  running = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // Don't POST on stop — credentials may already be gone (sign-out path).
  // Server's Redis TTL drops the row within 24h if we never come back.
  lastSent = null;
  lastSentAt = 0;
}
