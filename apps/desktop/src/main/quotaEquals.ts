// Single source of truth for "do two QuotaPresence values represent the same
// thing the user would see?" Two consumers need this: the desktop collector
// (claudeQuota) for skip-if-unchanged debouncing, and the diff emitter
// (peerPresenceDiff) for deciding when to fire onChange. Sharing one helper
// keeps the equality semantics in lockstep — adding a new field to
// QuotaWindow or relaxing positional comparison only needs to happen here.
//
// Inputs are typed structurally so callers can pass either the wire shape
// (`QuotaPresence`, with `updatedAt` and `source` — both ignored) or a parsed
// pre-wire shape (`{ plan, windows }`) without conversion.

import type { QuotaWindow } from "@slashtalk/shared";

interface QuotaContent {
  plan: string | null;
  windows: QuotaWindow[];
}

/**
 * True when two quotas would render identically. Both `null` / `undefined`
 * are treated as "no quota" and compare equal to each other but not to a
 * present value. `updatedAt` (when present on the inputs) is intentionally
 * not compared — it ticks on every keepalive POST and would otherwise cause
 * spurious change events / wasted re-POSTs.
 *
 * Window comparison is positional today: reordered windows compare unequal.
 * That matches Codex's stable primary/secondary ordering and is the right
 * default — if a future source emits windows in arbitrary order, change
 * this one site rather than tracking down two copies.
 */
export function quotaContentEquals(
  a: QuotaContent | null | undefined,
  b: QuotaContent | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.plan !== b.plan) return false;
  if (a.windows.length !== b.windows.length) return false;
  for (let i = 0; i < a.windows.length; i++) {
    const x = a.windows[i]!;
    const y = b.windows[i]!;
    if (x.label !== y.label || x.usedPercent !== y.usedPercent || x.resetsAt !== y.resetsAt) {
      return false;
    }
  }
  return true;
}
