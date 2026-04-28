type PromptEntry = { ts?: unknown; text?: unknown };

export function topJsonbEntries(value: unknown, limit: number): [string, number][] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is [string, number] => {
        return Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number";
      })
      .slice(0, limit);
  }

  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

export function promptHistoryLines(stored: unknown, lastUserPrompt: string | null): string[] {
  const lines: string[] = [];
  if (Array.isArray(stored)) {
    for (const entry of stored as PromptEntry[]) {
      if (!entry || typeof entry !== "object" || typeof entry.text !== "string") continue;
      const text = entry.text.trim();
      if (text) lines.push(`- ${text}`);
    }
  }

  if (lines.length > 0) return lines.slice(-10);
  const fallback = lastUserPrompt?.trim();
  return fallback ? [`- ${fallback}`] : [];
}
