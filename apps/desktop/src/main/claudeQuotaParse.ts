// Pure parser for the Claude quota collector. Isolated from electron/backend
// imports so it's reachable from bun test. Reads the slice of ~/.claude.json
// we care about and produces a QuotaPresence-shaped value (without
// updatedAt — the server stamps that on write).
//
// What we report and why:
//
// Claude Code never persists its 5h/weekly rate-limit windows to disk — those
// only exist in the runtime, populated from API response headers. The only
// honest signal we have on disk is the user's plan tier. That's what this
// produces: plan + an empty windows[] array, so the UI can render
// "Claude · Max 5x" alongside Codex's full breakdown without fabricating
// percentages.
//
// When (if) Anthropic eventually surfaces window state on disk, extend
// `windows` here — the wire shape and renderer already accommodate it.

import type { QuotaSource, QuotaWindow } from "@slashtalk/shared";

export interface ParsedClaudeQuota {
  source: Extract<QuotaSource, "claude">;
  plan: string | null;
  windows: QuotaWindow[];
}

interface OAuthAccountSlice {
  organizationRateLimitTier?: string | null;
  userRateLimitTier?: string | null;
  organizationType?: string | null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Turn a raw tier string into something a human would recognize.
 *
 *   "default_claude_max_5x"  → "Max 5x"
 *   "default_claude_max_20x" → "Max 20x"
 *   "default_claude_pro"     → "Pro"
 *   "claude_team"            → "Team"
 *   null / ""                → null
 *
 * Strips a leading `default_` and a leading `claude_` (in either order),
 * then title-cases each underscore-separated segment, preserving "Nx"
 * suffixes so "5x" stays lowercase.
 */
export function prettifyTier(tier: string | null | undefined): string | null {
  if (!tier) return null;
  let s = tier.trim();
  if (!s) return null;
  if (s.startsWith("default_")) s = s.slice("default_".length);
  if (s.startsWith("claude_")) s = s.slice("claude_".length);
  if (!s) return null;
  return s
    .split("_")
    .filter((part) => part.length > 0)
    .map((word) => {
      if (/^\d+x$/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/**
 * Pluck the slice of ~/.claude.json we need. Tolerant of missing fields:
 * returns null when there's nothing useful to report (e.g. the user is
 * signed out and oauthAccount is empty).
 */
export function parseClaudeQuotaFromConfig(raw: unknown): ParsedClaudeQuota | null {
  if (!isObj(raw)) return null;
  const oauth = isObj(raw.oauthAccount) ? (raw.oauthAccount as OAuthAccountSlice) : null;
  if (!oauth) return null;

  // Org tier dominates user tier when both are present — the org's rate-limit
  // bucket is what actually constrains the user. userRateLimitTier is usually
  // null on Max accounts; fall back to it when the org tier is missing.
  const tier = asString(oauth.organizationRateLimitTier) ?? asString(oauth.userRateLimitTier);
  const plan = prettifyTier(tier);

  // No on-disk window data exists today. See module header for context.
  const windows: QuotaWindow[] = [];

  // If we have nothing meaningful to surface, return null so the collector
  // can suppress the POST instead of writing an empty row.
  if (!plan && windows.length === 0) return null;

  return { source: "claude", plan, windows };
}
