import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Asks the main process to size the BrowserWindow to the renderer's content.
 *
 * Measures an element's `getBoundingClientRect().height` after every React
 * render (useLayoutEffect, no deps) AND on async size changes via
 * ResizeObserver (font/image loads). All sends are coalesced into a single rAF
 * tick so a burst of state updates produces at most one IPC call per frame.
 *
 * By default measures `#root`. Pass a ref to measure a different element —
 * useful when the outer box is height-capped (max-h-screen + scroll) and the
 * real content size lives on an inner, unconstrained wrapper.
 */
export function useAutoResize(ref?: RefObject<HTMLElement | null>): void {
  const lastSent = useRef(0);
  const pending = useRef<number | null>(null);

  const getEl = (): HTMLElement | null => ref?.current ?? document.getElementById("root");

  const flush = useRef<() => void>(() => {});
  flush.current = (): void => {
    pending.current = null;
    const el = getEl();
    if (!el) return;
    const h = Math.ceil(el.getBoundingClientRect().height);
    if (h <= 0 || h === lastSent.current) return;

    lastSent.current = h;
    void window.chatheads.requestResize(h);
  };

  const schedule = (): void => {
    if (pending.current != null) return;
    pending.current = requestAnimationFrame(() => flush.current());
  };

  // After every render — catches all React state changes (heads list, etc).
  useLayoutEffect(() => {
    schedule();
  });

  // Once — for non-React size changes (font/image load).
  useEffect(() => {
    const el = getEl();
    if (!el) return;
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (pending.current != null) cancelAnimationFrame(pending.current);
    };
    // getEl closes over ref; stable identity (refs don't change). Deliberately
    // empty deps — attach once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
