import { shortRepoName, type TokenUsage } from "@slashtalk/shared";

export { shortRepoName };

export function timeAgo(value: string | null | undefined): string {
  if (!value) return "No activity yet";
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return "Unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function fmtDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

export function fmtTokens(tokens: TokenUsage | undefined): string | null {
  if (!tokens) return null;
  const total = tokens.in + tokens.out + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning;
  if (total <= 0) return null;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`;
  return `${total}`;
}

export function repoName(fullName: string | null | undefined): string {
  return fullName ? shortRepoName(fullName) : "Unmatched repo";
}
