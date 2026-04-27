// Pure overlay/rail layout math: bubble dimensions, dock-edge classification,
// and bound computation. No BrowserWindow refs and no module state — every
// stateful caller (current overlay window, current head count, etc.) is
// passed in. Lets index.ts keep the runtime state where it lives while this
// file owns the geometry.
//
// Constants must stay in sync with the overlay renderer's Tailwind classes:
// - BUBBLE_SIZE ↔ `w-[45px] h-[45px]` on Bubble/SearchBubble/CreateBubble
// - BUBBLE_PAD ↔ `py-[7px]` (vertical) / `px-[7px]` (horizontal) on each
//   bubble's wrapper. Adjacent wrappers touch — no flex gap — so adjacent
//   paddings sum to a visual 14px stride between bubbles.
// - PADDING_X ↔ `px-md` on the stack (12px) — cross-axis padding on the rail.
// - PADDING_Y ↔ `py-lg` on the stack (16px) — main-axis padding on the rail.
// Drift here = popovers misalign.

import type { DockConfig, DockOrientation } from "../../shared/types";

export const BUBBLE_SIZE = 45;
export const BUBBLE_PAD = 7;
const PADDING_X = 12;
export const PADDING_Y = 16;
export const OVERLAY_WIDTH = BUBBLE_SIZE + PADDING_X * 2;
const DOCK_EDGE_MARGIN = 6;

/** Main-axis length of the overlay rail for `count` chat heads, plus the
 *  two control bubbles (search + agent-create). Cross-axis is OVERLAY_WIDTH. */
export function overlayLength(count: number): number {
  const n = count + 2;
  return n * (BUBBLE_SIZE + BUBBLE_PAD * 2) + PADDING_Y * 2;
}

export function overlaySize(
  count: number,
  orientation: DockOrientation,
): { width: number; height: number } {
  const length = overlayLength(count);
  return orientation === "vertical"
    ? { width: OVERLAY_WIDTH, height: length }
    : { width: length, height: OVERLAY_WIDTH };
}

export function screenIdOf(display: Electron.Display): string {
  return String(display.id ?? `${display.bounds.x},${display.bounds.y}`);
}

type Edge = "left" | "right" | "top" | "bottom";

/** Edges of the display whose work area touches the screen bounds (no macOS
 *  Dock occupying that side). The top edge is always allowed: the menu bar
 *  is thin and DOCK_EDGE_MARGIN already clears it. */
export function availableDockEdges(display: Electron.Display): Set<Edge> {
  const b = display.bounds;
  const wa = display.workArea;
  const edges = new Set<Edge>(["left", "right", "top", "bottom"]);
  if (wa.x - b.x > 0) edges.delete("left");
  if (b.x + b.width - (wa.x + wa.width) > 0) edges.delete("right");
  if (b.y + b.height - (wa.y + wa.height) > 0) edges.delete("bottom");
  return edges;
}

/** Pick the nearest *allowed* work-area edge to `p`. Edges blocked by the
 *  macOS Dock are dropped — the next-closest allowed edge wins. */
export function dockFromPoint(
  p: { x: number; y: number },
  display: Electron.Display,
): DockConfig {
  const wa = display.workArea;
  const allowed = availableDockEdges(display);
  const candidates: Array<{ d: number; dock: DockConfig }> = [];
  if (allowed.has("left")) {
    candidates.push({ d: p.x - wa.x, dock: { orientation: "vertical", side: "start" } });
  }
  if (allowed.has("right")) {
    candidates.push({
      d: wa.x + wa.width - p.x,
      dock: { orientation: "vertical", side: "end" },
    });
  }
  if (allowed.has("top")) {
    candidates.push({ d: p.y - wa.y, dock: { orientation: "horizontal", side: "start" } });
  }
  if (allowed.has("bottom")) {
    candidates.push({
      d: wa.y + wa.height - p.y,
      dock: { orientation: "horizontal", side: "end" },
    });
  }
  // Defensive — shouldn't happen unless the whole display is reserved.
  if (candidates.length === 0) return { orientation: "vertical", side: "end" };
  candidates.sort((a, b) => a.d - b.d);
  return candidates[0].dock;
}

/** Anchor the rail of `count` heads at the requested edge of `display`'s
 *  work area, inset by DOCK_EDGE_MARGIN. */
export function computeDockBoundsOn(
  display: Electron.Display,
  dock: DockConfig,
  count: number,
): Electron.Rectangle {
  const wa = display.workArea;
  const { width, height } = overlaySize(count, dock.orientation);
  if (dock.orientation === "vertical") {
    const x =
      dock.side === "start" ? wa.x + DOCK_EDGE_MARGIN : wa.x + wa.width - width - DOCK_EDGE_MARGIN;
    const y = wa.y + Math.floor((wa.height - height) / 2);
    return { x, y, width, height };
  }
  const y =
    dock.side === "start" ? wa.y + DOCK_EDGE_MARGIN : wa.y + wa.height - height - DOCK_EDGE_MARGIN;
  const x = wa.x + Math.floor((wa.width - width) / 2);
  return { x, y, width, height };
}
