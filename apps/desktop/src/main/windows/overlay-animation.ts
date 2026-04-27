// Tween a BrowserWindow's bounds to `target` with easeOutCubic. A monotonic
// internal token handles cancellation: starting a new animation (or calling
// `cancelOverlayAnimation`) bumps the token so any in-flight step bails on
// its next tick — that's how a re-drag mid-slide cancels cleanly.

import type { BrowserWindow } from "electron";

let latestToken = 0;
const FRAME_MS = 16;

interface AnimateOpts {
  /** Called every frame after the window's bounds update. Used to keep
   *  popovers (info card, chat pill) anchored to the moving window. */
  onTick?: () => void;
  /** Called once the animation reaches the target (skipped if cancelled). */
  onDone?: () => void;
}

export function animateOverlayTo(
  win: BrowserWindow,
  target: Electron.Rectangle,
  duration: number,
  opts: AnimateOpts = {},
): void {
  if (win.isDestroyed()) return;
  latestToken += 1;
  const myToken = latestToken;
  const start = win.getBounds();
  const t0 = Date.now();
  const ease = (t: number): number => 1 - Math.pow(1 - t, 3); // easeOutCubic
  const step = (): void => {
    if (myToken !== latestToken || win.isDestroyed()) return;
    const t = Math.min(1, (Date.now() - t0) / duration);
    const e = ease(t);
    win.setBounds({
      x: Math.round(start.x + (target.x - start.x) * e),
      y: Math.round(start.y + (target.y - start.y) * e),
      width: Math.round(start.width + (target.width - start.width) * e),
      height: Math.round(start.height + (target.height - start.height) * e),
    });
    opts.onTick?.();
    if (t < 1) setTimeout(step, FRAME_MS);
    else opts.onDone?.();
  };
  step();
}

/** Cancel any in-flight animation. Subsequent calls to `animateOverlayTo`
 *  start fresh. Used by drag:start so a new drag immediately interrupts
 *  the current dock-snap tween. */
export function cancelOverlayAnimation(): void {
  latestToken += 1;
}
