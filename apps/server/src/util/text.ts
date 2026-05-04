export function truncateWithEllipsis(value: string, maxChars: number): string;
export function truncateWithEllipsis(value: string | null, maxChars: number): string | null;
export function truncateWithEllipsis(value: string | null, maxChars: number): string | null {
  if (value === null) return null;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}
