import { useEffect, useState, type ReactNode } from "react";

// Sub-second refetches don't get a visual cue — the network round-trip
// finishes before the user can register the fade, so flipping it would just
// add flicker. After STALE_DELAY_MS of sustained fetching, switch on the
// fade + shimmer; the fade-back uses the same 200ms transition.
const STALE_DELAY_MS = 1000;

/** Wraps content that follows SWR semantics on the info card. While `stale`
 *  is true (in-flight refetch with prior content still on screen), the
 *  children fade and desaturate while a sweep highlight sits on top —
 *  signaling "this is being refreshed" without flickering through a loader.
 *  When false, both effects fade back to identity over the same 200ms.
 *  Both dashboards (user, project) share this so the cue is identical. */
export function StaleWrapper({
  stale,
  children,
}: {
  stale: boolean;
  children: ReactNode;
}): JSX.Element {
  const [showStale, setShowStale] = useState(false);
  useEffect(() => {
    if (!stale) {
      setShowStale(false);
      return;
    }
    const timer = setTimeout(() => setShowStale(true), STALE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [stale]);
  return (
    <div className="relative">
      <div
        className={`transition-[opacity,filter] duration-200 ${
          showStale ? "opacity-70 saturate-0" : "opacity-100 saturate-100"
        }`}
      >
        {children}
      </div>
      {showStale && (
        <div className="shimmer-overlay absolute inset-0 pointer-events-none" aria-hidden />
      )}
    </div>
  );
}
