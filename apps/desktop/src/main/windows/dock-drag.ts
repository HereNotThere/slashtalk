import { BrowserWindow, ipcMain, screen } from "electron";
import type { DockConfig, DockOrientation } from "../../shared/types";
import { OVERLAY_WIDTH, computeDockBoundsOn, dockFromPoint, overlaySize } from "./dock-geometry";
import { animateOverlayTo, cancelOverlayAnimation } from "./overlay-animation";
import { hardenWindow, rendererWebPreferences } from "./lib";

interface DockDragDeps {
  getOverlay: () => BrowserWindow | null;
  effectiveOverlayLength: (orientation: DockOrientation, display: Electron.Display) => number;
  // Reposition info + chat each tick during drag and during the snap animation.
  onTick: () => void;
  onHideInfoNow: () => void;
  onSendOverlayConfig: () => void;
  onSavePosition: () => void;
}

const DOCK_ANIM_MS = 180;

// Set on register; the exported `currentDock` / `getIsDragging` callers are
// only reached after registration so we use `!` rather than a runtime guard.
let deps: DockDragDeps | null = null;
let dragOffset: { dx: number; dy: number } | null = null;
let dragTicker: ReturnType<typeof setInterval> | null = null;
// showInfo reads getIsDragging() so a hover under the moving rail doesn't
// pop the popover mid-drag/snap.
let isDraggingStack = false;
let dockPlaceholderWindow: BrowserWindow | null = null;

export function getIsDragging(): boolean {
  return isDraggingStack;
}

function overlayDisplay(): Electron.Display {
  const overlay = deps!.getOverlay();
  if (!overlay || overlay.isDestroyed()) return screen.getPrimaryDisplay();
  return screen.getDisplayMatching(overlay.getBounds());
}

export function currentDock(): DockConfig {
  const overlay = deps!.getOverlay();
  if (!overlay || overlay.isDestroyed()) {
    return { orientation: "vertical", side: "end" };
  }
  const b = overlay.getBounds();
  const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  return dockFromPoint(center, overlayDisplay());
}

function computeDockBounds(dock: DockConfig): Electron.Rectangle {
  const display = overlayDisplay();
  return computeDockBoundsOn(
    display,
    dock,
    deps!.effectiveOverlayLength(dock.orientation, display),
  );
}

function ensureDockPlaceholder(): BrowserWindow {
  if (dockPlaceholderWindow && !dockPlaceholderWindow.isDestroyed()) {
    return dockPlaceholderWindow;
  }
  // Radius matches the overlay's pill cap (half the short axis = OVERLAY_WIDTH/2).
  // Both orientations share the same short axis, so the same radius gives
  // perfect semi-circle caps whether the placeholder is tall or wide.
  const radius = Math.round(OVERLAY_WIDTH / 2);
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden;height:100%;}
    .pill{
      position:fixed;inset:0;box-sizing:border-box;
      border:2px dashed rgba(255,255,255,0.55);
      border-radius:${radius}px;
      background:rgba(255,255,255,0.05);
    }
  </style></head><body><div class="pill"></div></body></html>`;
  // Initial size is irrelevant — updateDockPlaceholder() runs setBounds before
  // the window becomes visible. Pass overlaySize(0,…) to satisfy the BrowserWindow
  // constructor without leaking a "heads count" coupling.
  const initialSize = overlaySize(0, "vertical");
  dockPlaceholderWindow = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: rendererWebPreferences(),
  });
  hardenWindow(dockPlaceholderWindow);
  dockPlaceholderWindow.setAlwaysOnTop(true, "floating");
  dockPlaceholderWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });
  dockPlaceholderWindow.setIgnoreMouseEvents(true);
  void dockPlaceholderWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  dockPlaceholderWindow.on("closed", () => {
    dockPlaceholderWindow = null;
  });
  return dockPlaceholderWindow;
}

function updateDockPlaceholder(): void {
  const ph = ensureDockPlaceholder();
  ph.setBounds(computeDockBounds(currentDock()));
  if (!ph.isVisible()) ph.showInactive();
}

function hideDockPlaceholder(): void {
  if (!dockPlaceholderWindow || dockPlaceholderWindow.isDestroyed()) return;
  if (dockPlaceholderWindow.isVisible()) dockPlaceholderWindow.hide();
}

export function registerDockDrag(d: DockDragDeps): void {
  deps = d;
  const { getOverlay, onTick, onHideInfoNow, onSendOverlayConfig, onSavePosition } = d;

  ipcMain.handle("drag:start", (): void => {
    const overlay = getOverlay();
    if (!overlay || overlay.isDestroyed()) return;
    // A new drag cancels any in-flight dock tween.
    cancelOverlayAnimation();

    const cursor = screen.getCursorScreenPoint();
    const win = overlay.getBounds();
    dragOffset = { dx: cursor.x - win.x, dy: cursor.y - win.y };
    isDraggingStack = true;
    // Kill any visible/pending info card so it doesn't trail the stack.
    onHideInfoNow();
    updateDockPlaceholder();

    if (dragTicker) clearInterval(dragTicker);
    dragTicker = setInterval(() => {
      const o = getOverlay();
      if (!o || o.isDestroyed() || !dragOffset) return;
      const p = screen.getCursorScreenPoint();
      o.setPosition(p.x - dragOffset.dx, p.y - dragOffset.dy);
      onTick();
      updateDockPlaceholder();
    }, 16);
  });

  ipcMain.handle("drag:end", (): void => {
    if (dragTicker) clearInterval(dragTicker);
    dragTicker = null;
    dragOffset = null;
    hideDockPlaceholder();

    const overlay = getOverlay();
    if (!overlay || overlay.isDestroyed()) {
      isDraggingStack = false;
      onSavePosition();
      return;
    }

    const target = computeDockBounds(currentDock());
    // Push the new dock to the overlay renderer first so flex direction + FLIP
    // tracking swap before the window resizes. The renderer will see the new
    // size via its resize event during the animation, but with the right flex
    // orientation already in place.
    onSendOverlayConfig();
    // Keep isDraggingStack on through the slide so bubble hovers under the
    // moving window don't pop the info card mid-tween.
    animateOverlayTo(overlay, target, DOCK_ANIM_MS, {
      onTick: () => onTick(),
      onDone: () => {
        isDraggingStack = false;
        onSavePosition();
      },
    });
  });
}
