import type { ReactNode } from "react";

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
  return (
    <div className="relative">
      <div
        className={`transition-[opacity,filter] duration-200 ${
          stale ? "opacity-70 saturate-0" : "opacity-100 saturate-100"
        }`}
      >
        {children}
      </div>
      {stale && (
        <div className="shimmer-overlay absolute inset-0 pointer-events-none" aria-hidden />
      )}
    </div>
  );
}
