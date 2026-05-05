import { useEffect, useRef, useState, type ReactNode } from "react";

// Hold-then-swap window. When `data` flips to a different value, the wrapper
// keeps the previous render visible under a shimmer for this long, then swaps
// to the new render. Tuned against the 1.8s `shimmer-sweep` keyframe — long
// enough for the sweep band (≈540ms bright pass) to land at least once, short
// enough that an unchanged-but-refetched payload doesn't feel laggy.
const SWAP_DELAY_MS = 1000;

/** Wraps content that follows SWR semantics on the info card. The wrapper
 *  intentionally ignores in-flight fetch state — a refetch that returns the
 *  same payload (server cache hit) renders nothing visible. Only when `data`
 *  identity changes does the wrapper hold the prior render under a shimmer
 *  for ~1s, then cross to the new content. The first non-null fill swaps
 *  instantly so initial load isn't gated on the transition.
 *
 *  Pass the live data object as `data`; pass any value (including `null`)
 *  for the empty state. `subjectKey` identifies *which card* this is — when
 *  it changes (e.g. hovering from one user's bubble to another), the wrapper
 *  hard-resets to the new payload instantly with no shimmer, since the diff
 *  isn't a refresh of the same subject. */
export function StaleWrapper({
  data,
  subjectKey = null,
  children,
}: {
  data: unknown;
  subjectKey?: string | null;
  children: ReactNode;
}): JSX.Element {
  const signature = data == null ? null : JSON.stringify(data);
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const [displayed, setDisplayed] = useState<{ sig: string | null; node: ReactNode }>({
    sig: signature,
    node: children,
  });
  const [transitioning, setTransitioning] = useState(false);

  // Subject swap (e.g. hover from one bubble to another). Reset synchronously
  // during render — see https://react.dev/learn/you-might-not-need-an-effect
  // ("Adjusting some state when a prop changes"). Three setStates batch into
  // a single re-render with all three applied.
  const [prevSubject, setPrevSubject] = useState(subjectKey);
  if (subjectKey !== prevSubject) {
    setPrevSubject(subjectKey);
    setDisplayed({ sig: signature, node: children });
    setTransitioning(false);
  }

  useEffect(() => {
    if (signature === displayed.sig) return;
    // First fill (or clear back to empty) → swap instantly. Holding shimmer
    // over an empty placeholder or skipping the very first paint would both
    // look broken.
    if (displayed.sig == null || signature == null) {
      setDisplayed({ sig: signature, node: childrenRef.current });
      setTransitioning(false);
      return;
    }
    setTransitioning(true);
    const timer = setTimeout(() => {
      setDisplayed({ sig: signature, node: childrenRef.current });
      setTransitioning(false);
    }, SWAP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [signature, displayed.sig]);

  // Same-signature rerenders (parent state changes inside an unchanged data
  // payload — e.g. expanding a bucket) need to flow through to the held node
  // so internal UI state stays interactive.
  useEffect(() => {
    if (transitioning) return;
    if (signature !== displayed.sig) return;
    if (displayed.node === children) return;
    setDisplayed({ sig: signature, node: children });
  }, [children, signature, displayed.sig, displayed.node, transitioning]);

  return (
    <div className="relative">
      <div
        className={`transition-[opacity,filter] duration-200 ${
          transitioning ? "opacity-70 saturate-0" : "opacity-100 saturate-100"
        }`}
      >
        {displayed.node}
      </div>
      {transitioning && (
        <div className="shimmer-overlay absolute inset-0 pointer-events-none" aria-hidden />
      )}
    </div>
  );
}
