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
import { parseClaudeQuotaFromConfig, type ParsedClaudeQuota } from "./claudeQuotaParse";
import { quotaContentEquals } from "./quotaEquals";

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

// Three outcomes that need distinct handling — a single nullable return would
// conflate "user signed out" with "I/O hiccup", causing peers to see the
// presence row briefly disappear on every torn read of ~/.claude.json.
type ReadResult =
  | { kind: "present"; quota: ParsedClaudeQuota }
  // File parsed cleanly but oauthAccount is missing or empty: the user is
  // genuinely not signed in to Claude Code. Wipe the presence row.
  | { kind: "signed-out" }
  // Transient: I/O error other than ENOENT, or a torn JSON read while Claude
  // Code is rewriting the file in place. Leave whatever's already in Redis
  // alone — the next tick will correct it.
  | { kind: "skip" };

async function read(): Promise<ReadResult> {
  let text: string;
  try {
    text = await fsp.readFile(CONFIG_PATH, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // No config file at all — Claude Code has never run on this machine.
      // That's a valid signed-out state, not a transient error.
      return { kind: "signed-out" };
    }
    console.warn("[claudeQuota] readFile failed:", (err as Error).message);
    return { kind: "skip" };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (err) {
    // Claude Code rewrites ~/.claude.json in place; a torn read is rare but
    // possible. Skip — don't let a 1-tick parse error wipe peers' view.
    console.warn("[claudeQuota] JSON parse failed (likely torn read):", (err as Error).message);
    return { kind: "skip" };
  }

  const quota = parseClaudeQuotaFromConfig(parsedJson);
  if (!quota) return { kind: "signed-out" };
  return { kind: "present", quota };
}

async function tick(): Promise<void> {
  if (!running) return;
  const result = await read();
  if (result.kind === "skip") return;

  const now = Date.now();
  if (result.kind === "present") {
    const next = result.quota;
    const changed = !quotaContentEquals(lastSent, next);
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
    // result.kind === "signed-out"
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
  // tick() awaits a disk read + a network POST, so stop() can land in
  // between. If it did, `running` is false and `timer` was cleared — don't
  // schedule a new interval that nothing tracks, or a later start() would
  // orphan it (overwriting `timer` without ever clearing this one) and end
  // up running two ticks per cycle.
  if (!running) return;
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
