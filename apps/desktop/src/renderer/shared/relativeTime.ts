/** Compact relative-time label for ISO timestamps surfaced in lists.
 *  "just now" under a minute, then `Nm ago` / `Nh ago` / `Nd ago`.
 *  The response window has its own variant with a finer-grained
 *  sub-minute scale; keep it separate unless its semantics change. */
export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
