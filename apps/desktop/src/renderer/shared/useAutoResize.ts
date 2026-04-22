import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Asks the main process to size the BrowserWindow to the renderer's content.
 *
 * Measures `#root.getBoundingClientRect().height` after every React render
 * (useLayoutEffect, no deps) AND on async size changes via ResizeObserver
 * (font/image loads). All sends are coalesced into a single rAF tick so a burst
 * of state updates produces at most one IPC call per frame.
 *
 * Assumes the body is transparent and the root div is intrinsically sized
 * (no `h-full` on outer wrappers).
 */
export function useAutoResize(): void {
  const lastSent = useRef(0);
  const pending = useRef<number | null>(null);

  const flush = useRef<() => void>(() => {});
  flush.current = (): void => {
    pending.current = null;
    const root = document.getElementById('root');
    if (!root) return;
    const h = Math.ceil(root.getBoundingClientRect().height);
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
    const root = document.getElementById('root');
    if (!root) return;
    const ro = new ResizeObserver(schedule);
    ro.observe(root);
    return () => {
      ro.disconnect();
      if (pending.current != null) cancelAnimationFrame(pending.current);
    };
  }, []);
}
