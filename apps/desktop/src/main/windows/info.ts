import { BrowserWindow, ipcMain, nativeTheme, screen } from "electron";
import type { ChatHead, InfoSession } from "../../shared/types";
import type { ChatThread } from "@slashtalk/shared";
import * as backend from "../backend";
import * as rail from "../rail";
import * as peerPresence from "../peerPresence";
import * as peerLocations from "../peerLocations";
import { setMacCornerRadius } from "../macCorners";
import { BUBBLE_PAD, BUBBLE_SIZE, PADDING_Y } from "./dock-geometry";
import { currentDock, getIsDragging } from "./dock-drag";
import { broadcast } from "./broadcast";
import { loadRenderer, preloadPath } from "./lib";

interface InfoDeps {
  getOverlay: () => BrowserWindow | null;
  getHeads: () => ChatHead[];
}

const INFO_WIDTH = 340;
const INFO_INITIAL_HEIGHT = 80; // small placeholder; renderer reports actual on mount
const INFO_GAP = 8; // distance from the pill's outer edge to the info window
// Match Tailwind `rounded-3xl` (1.5rem). Native clipping (setMacCornerRadius)
// applies on macOS 15+; older versions fall back to a plain rectangle. We
// keep the native clip even without vibrancy so the dropped shadow follows
// the rounded silhouette instead of a sharp rectangle.
const INFO_RADIUS = 24;

const RESIZE_MIN = 60;
// Info window caps at whichever is smaller: a hard ceiling, or 2/3 of the
// screen's work area. Computed per-resize so a display change just works.
// Absolute cap is set high enough to fit a UserHeader + 5-session preview +
// "Show all" button + the "Asked Slashtalk" section without scrolling on
// typical 1080p+ displays. The 2/3 screen fraction stays as the binding
// constraint on shorter screens so the popover never dominates the desktop.
const INFO_MAX_ABSOLUTE = 900;
const INFO_MAX_SCREEN_FRACTION = 2 / 3;

// Delay between the user leaving a rail bubble and the info window actually
// hiding. Gives them time to move the cursor onto the info panel, which cancels
// the pending hide via infoHoverEnter.
const INFO_HIDE_GRACE_MS = 180;

// Matches the renderer's CSS fade-out duration. After the opacity transition,
// the NSWindow is hidden so it doesn't intercept events while invisible.
const INFO_FADE_OUT_MS = 90;

// Cap on how long showInfo waits for the renderer's measured-height ack
// before positioning. Renderer dispatches in a layout effect (sub-frame in
// practice); 80ms is a safety net so a wedged renderer can't strand the
// popover.
const INFO_SHOW_READY_TIMEOUT_MS = 80;

// `session_updated` fires on every ingest batch — potentially many per second
// during an active session. Coalesce refreshes so the info window re-renders
// at most once per REFRESH_DEBOUNCE_MS regardless of WS traffic.
const REFRESH_DEBOUNCE_MS = 300;

let deps: InfoDeps;
let infoWindow: BrowserWindow | null = null;

// Tracked dynamically — renderer reports its content height via IPC and we
// resize/reposition the window each time it changes.
let infoCurrentHeight = INFO_INITIAL_HEIGHT;

// Last observed rendered height per head, keyed by head id. Populated from
// renderer resize reports. Lets subsequent shows of the same head size the
// window correctly on first paint instead of resizing after render.
const infoHeightByHead = new Map<string, number>();

// Pending "user left the rail" hide. Cancelled if the cursor enters the info
// panel or re-enters a bubble within INFO_HIDE_GRACE_MS.
let infoHideGraceTimer: NodeJS.Timeout | null = null;

// Pending `win.hide()` after the renderer has faded out. Cancelled if we
// re-show before the fade completes.
let infoHideFadeTimer: NodeJS.Timeout | null = null;

let selectedHeadId: string | null = null;
// Stashed bubble screen-coords for the selected head. positionInfo's
// fallback (rail-derived idx * cell) misses by a slot for peers in a
// peek-collapsed stack, so resize-driven reposition uses this directly.
// Dock flips / rail slides intentionally don't pass it — the rail itself
// moved, so the stash is stale.
let selectedBubbleScreen: { x: number; y: number } | null = null;

const sessionCache = new Map<string, InfoSession[]>();

// Mirrors sessionCache but for the "Asked Slashtalk" panel, keyed by github
// login (not head id, because peer questions are scoped per user across all
// repos). Populated lazily on the first hover for a user and re-populated by
// the renderer's 15s refresh through `chat:questionsForLogin`. Without this,
// every hover refetched the same threads end-to-end and a section visibly
// popped in mid-show.
const questionsCache = new Map<string, ChatThread[]>();

// Coalesce concurrent callers (showInfo's bg fetch + the renderer's load
// effect on cache miss) onto one HTTP request.
const questionsInFlight = new Map<string, Promise<ChatThread[]>>();

type InfoShowReadyResolver = (height: number | null) => void;
// FIFO queue: each ack drains exactly one resolver so concurrent showInfo
// calls (rapid head switches) get matched 1:1 with the renderer's acks
// instead of the first ack settling all pending resolvers with the wrong
// head's height.
const infoShowReadyResolvers: InfoShowReadyResolver[] = [];

let refreshTimer: NodeJS.Timeout | null = null;

// ---------- Public getters ----------

export function getInfoWindow(): BrowserWindow | null {
  return infoWindow;
}

export function getSelectedHeadId(): string | null {
  return selectedHeadId;
}

export function getCachedSessions(headId: string): InfoSession[] | undefined {
  return sessionCache.get(headId);
}

// ---------- Cache invalidation ----------

export function invalidateSessionCache(headId: string): void {
  sessionCache.delete(headId);
}

export function invalidateQuestionsForLogin(login: string): void {
  questionsCache.delete(login);
}

export function clearQuestionsCache(): void {
  questionsCache.clear();
}

// ---------- Window plumbing ----------

// Match `--color-surface-2` per theme so the window background doesn't flash
// the wrong color before the renderer paints (and so light mode never shows a
// dark NSWindow behind any sub-pixel gap on the body).
function infoBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#2c2c2c" : "#ffffff";
}

// Module-level listener: applies to whichever infoWindow exists when the
// system theme flips. Registered once so re-creating the window doesn't leak
// listeners.
nativeTheme.on("updated", () => {
  if (!infoWindow || infoWindow.isDestroyed()) return;
  infoWindow.setBackgroundColor(infoBackgroundColor());
});

function ensureInfoWindow(): BrowserWindow {
  if (infoWindow && !infoWindow.isDestroyed()) return infoWindow;

  infoWindow = new BrowserWindow({
    width: INFO_WIDTH,
    height: INFO_INITIAL_HEIGHT,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    // Vibrancy was visually disabled by the renderer's opaque `bg-surface-2`
    // anyway, but the NSVisualEffectView still re-rendered every setBounds
    // and could desync from the web-contents layer during fast head-switches,
    // showing as edge tearing. Drop it; the renderer fully owns the painted
    // surface.
    backgroundColor: infoBackgroundColor(),
    hasShadow: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
    },
  });

  infoWindow.setAlwaysOnTop(true, "floating");
  infoWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  setMacCornerRadius(infoWindow, INFO_RADIUS);

  loadRenderer(infoWindow, "info");

  // No blur-hide: hover model owns visibility; a blur-triggered hide fights
  // with the leave-timer and click-outside logic.
  infoWindow.on("closed", () => {
    infoWindow = null;
  });

  return infoWindow;
}

function clampInfoHeight(height: number): number {
  const rounded = Math.round(height);
  if (!infoWindow || infoWindow.isDestroyed()) {
    return Math.max(RESIZE_MIN, rounded);
  }
  const { height: screenH } = screen.getDisplayMatching(infoWindow.getBounds()).workAreaSize;
  const maxForWin = Math.min(INFO_MAX_ABSOLUTE, Math.floor(screenH * INFO_MAX_SCREEN_FRACTION));
  return Math.max(RESIZE_MIN, Math.min(maxForWin, rounded));
}

function waitForInfoShowReady(timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (h: number | null): void => {
      if (settled) return;
      settled = true;
      const i = infoShowReadyResolvers.indexOf(finish);
      if (i >= 0) infoShowReadyResolvers.splice(i, 1);
      resolve(h);
    };
    infoShowReadyResolvers.push(finish);
    setTimeout(() => finish(null), timeoutMs);
  });
}

function positionInfo(headId: string, bubbleScreen?: { x: number; y: number }): void {
  if (!infoWindow || infoWindow.isDestroyed()) return;
  const overlay = deps.getOverlay();
  if (!overlay || overlay.isDestroyed()) return;

  const stackBounds = overlay.getBounds();
  const display = screen.getDisplayMatching(stackBounds);
  const screenFrame = display.workArea;
  const dock = currentDock();

  // Fallback coord when the renderer didn't report a bubble rect (e.g.
  // repositions during drag/slide). Derived from the head's position on the
  // rail. Each wrapper is `cell` long; the bubble inside sits BUBBLE_PAD past
  // the wrapper top.
  const cell = BUBBLE_SIZE + BUBBLE_PAD * 2;
  const heads = deps.getHeads();
  const idx = heads.findIndex((h) => h.id === headId);
  const fallbackAxisOffset = PADDING_Y + BUBBLE_PAD + Math.max(0, idx) * cell;

  if (dock.orientation === "vertical") {
    const infoX =
      dock.side === "start"
        ? stackBounds.x + stackBounds.width + INFO_GAP
        : stackBounds.x - INFO_GAP - INFO_WIDTH;
    const avatarTopY = bubbleScreen?.y ?? stackBounds.y + fallbackAxisOffset;
    const desiredY = Math.round(avatarTopY - 16);
    const bottomLimit = screenFrame.y + screenFrame.height - 32;
    const maxY = bottomLimit - infoCurrentHeight;
    const infoY = Math.max(screenFrame.y + 8, Math.min(desiredY, maxY));
    infoWindow.setBounds({
      x: Math.round(infoX),
      y: infoY,
      width: INFO_WIDTH,
      height: infoCurrentHeight,
    });
    return;
  }

  // Horizontal: info sits below (top-docked) or above (bottom-docked) the
  // rail. Anchor X to the bubble's screen-X when available.
  const infoY =
    dock.side === "start"
      ? stackBounds.y + stackBounds.height + INFO_GAP
      : stackBounds.y - INFO_GAP - infoCurrentHeight;
  const avatarLeftX = bubbleScreen?.x ?? stackBounds.x + fallbackAxisOffset;
  const desiredX = Math.round(avatarLeftX - 16);
  const rightLimit = screenFrame.x + screenFrame.width - 8;
  const maxX = rightLimit - INFO_WIDTH;
  const infoX = Math.max(screenFrame.x + 8, Math.min(desiredX, maxX));
  infoWindow.setBounds({
    x: infoX,
    y: Math.round(infoY),
    width: INFO_WIDTH,
    height: infoCurrentHeight,
  });
}

// Sends an info:show with whatever's currently in main's caches. No-op if a
// newer hover has taken over (head no longer selected).
function pushInfoShowSnapshot(
  win: BrowserWindow | null,
  head: ChatHead,
  expandSessionId?: string,
): void {
  if (!win || win.isDestroyed()) return;
  if (selectedHeadId !== head.id) return;
  const login = rail.parseUserHeadId(head.id);
  const cachedQuestions = login ? questionsCache.get(login) : null;
  win.webContents.send("info:show", {
    head,
    sessions: sessionCache.get(head.id) ?? null,
    expandSessionId: expandSessionId ?? null,
    spotify: login ? (peerPresence.get(login) ?? null) : null,
    location: login ? (peerLocations.get(login) ?? null) : null,
    isSelf: backend.isSelf(login),
    questions: login && cachedQuestions ? { login, threads: cachedQuestions } : null,
  });
}

async function showInfo(
  headId: string,
  bubbleScreen?: { x: number; y: number },
  expandSessionId?: string,
): Promise<void> {
  if (getIsDragging()) return;
  const head = deps.getHeads().find((h) => h.id === headId);
  if (!head) return;

  // Cancel any pending hide so fast re-entry just swaps content.
  if (infoHideGraceTimer) {
    clearTimeout(infoHideGraceTimer);
    infoHideGraceTimer = null;
  }
  if (infoHideFadeTimer) {
    clearTimeout(infoHideFadeTimer);
    infoHideFadeTimer = null;
  }

  const win = ensureInfoWindow();
  selectedHeadId = head.id;
  selectedBubbleScreen = bubbleScreen ?? null;

  if (win.webContents.isLoading()) {
    await new Promise<void>((resolve) => {
      win.webContents.once("did-finish-load", () => resolve());
    });
    // A newer show/hide may have fired while we awaited load.
    if (selectedHeadId !== head.id) return;
    if (win.isDestroyed()) return;
  }

  // Size the window using the cached height for this head (if we've rendered
  // it before) so first paint lands at the right size instead of mid-resize.
  const cachedHeight = infoHeightByHead.get(head.id);
  if (cachedHeight) infoCurrentHeight = cachedHeight;

  const login = rail.parseUserHeadId(head.id);
  const firstShow = !win.isVisible();
  // Send the current cache snapshot immediately. Cache misses surface as null
  // and the renderer paints loading placeholders; the background fetches
  // below resolve and re-push with the same snapshot helper.
  pushInfoShowSnapshot(win, head, expandSessionId);

  // Wait for the renderer's measured-height ack so position+content land on
  // the same paint frame and the bottom-clamp uses the right height (no
  // overflow-then-snap when the new card is taller than the previous).
  const ackedHeight = await waitForInfoShowReady(INFO_SHOW_READY_TIMEOUT_MS);
  if (selectedHeadId !== head.id) return;
  if (!infoWindow || infoWindow.isDestroyed()) return;
  if (ackedHeight != null) {
    const clamped = clampInfoHeight(ackedHeight);
    infoCurrentHeight = clamped;
    infoHeightByHead.set(head.id, clamped);
  }
  positionInfo(head.id, bubbleScreen);
  if (firstShow) win.showInactive();
  broadcast("info:state", { visible: true, headId: head.id }, deps.getOverlay());

  // Fetch any cache misses in parallel and push the merged snapshot once
  // both settle, so the renderer doesn't ping-pong through two resize cycles.
  // Drop expandSessionId on the follow-up: the initial push already carried
  // it, and re-sending bumps expandRequest.nonce in the renderer, which
  // re-expands a session the user may have manually collapsed mid-fetch.
  const pending: Promise<unknown>[] = [];
  if (!sessionCache.has(head.id)) pending.push(fetchSessionsForHead(head.id));
  if (login && !questionsCache.has(login)) pending.push(fetchQuestionsForLoginCached(login));
  if (pending.length > 0) {
    void Promise.all(pending).then(() => {
      pushInfoShowSnapshot(infoWindow, head, undefined);
    });
  }
}

function scheduleHideInfo(): void {
  if (!infoWindow || infoWindow.isDestroyed()) return;
  if (infoHideGraceTimer) clearTimeout(infoHideGraceTimer);
  infoHideGraceTimer = setTimeout(() => {
    infoHideGraceTimer = null;
    hideNow();
  }, INFO_HIDE_GRACE_MS);
}

function cancelHideInfo(): void {
  if (infoHideGraceTimer) {
    clearTimeout(infoHideGraceTimer);
    infoHideGraceTimer = null;
  }
  if (infoHideFadeTimer) {
    clearTimeout(infoHideFadeTimer);
    infoHideFadeTimer = null;
  }
}

export function hideNow(): void {
  selectedHeadId = null;
  selectedBubbleScreen = null;
  broadcast("info:state", { visible: false, headId: null }, deps.getOverlay());
  if (infoWindow && !infoWindow.isDestroyed()) {
    infoWindow.webContents.send("info:hide");
    // Defer the actual NSWindow hide until the renderer's fade-out completes
    // so we don't clip the transition.
    if (infoHideFadeTimer) clearTimeout(infoHideFadeTimer);
    infoHideFadeTimer = setTimeout(() => {
      infoHideFadeTimer = null;
      if (infoWindow && !infoWindow.isDestroyed() && selectedHeadId === null) {
        infoWindow.hide();
      }
    }, INFO_FADE_OUT_MS);
  }
}

// Re-anchor using fallback math (rail-derived bubble position). For dock
// flips and drag ticks where the rail has moved.
export function repositionIfVisible(): void {
  if (!selectedHeadId) return;
  if (!deps.getHeads().some((h) => h.id === selectedHeadId)) return;
  positionInfo(selectedHeadId);
}

// Re-anchor against the stashed bubble screen-coords. For data-only changes
// (rail.onChange) where the bubble itself hasn't moved — the fallback math
// would miss by a slot for peers in a peek-collapsed stack.
export function repositionIfVisibleAtStash(): void {
  if (!selectedHeadId) return;
  if (!deps.getHeads().some((h) => h.id === selectedHeadId)) return;
  positionInfo(selectedHeadId, selectedBubbleScreen ?? undefined);
}

// ---------- Cache + fetchers ----------

export async function fetchSessionsForHead(headId: string): Promise<InfoSession[]> {
  const cached = sessionCache.get(headId);
  if (cached) return cached;

  const state = backend.getAuthState();
  if (!state.signedIn) return [];

  // Demo head previews the new hierarchy against the viewer's own data so the
  // "Now" section can light up when they actually have a live session.
  if (rail.isDemoHeadId(headId)) {
    try {
      const sessions = await backend.listOwnSessions();
      sessionCache.set(headId, sessions);
      return sessions;
    } catch {
      return [];
    }
  }

  const login = rail.parseUserHeadId(headId);
  if (login) {
    try {
      const sessions =
        state.user.githubLogin === login
          ? await backend.listOwnSessions()
          : await backend.listFeedSessionsForUser(login);
      sessionCache.set(headId, sessions);
      return sessions;
    } catch {
      return [];
    }
  }

  return [];
}

async function fetchQuestionsForLoginCached(login: string): Promise<ChatThread[]> {
  const cached = questionsCache.get(login);
  if (cached) return cached;
  const inFlight = questionsInFlight.get(login);
  if (inFlight) return inFlight;
  const promise = backend
    .fetchQuestionsForLogin(login)
    .then((res) => {
      questionsCache.set(login, res.threads);
      return res.threads;
    })
    .catch(() => [] as ChatThread[])
    .finally(() => {
      questionsInFlight.delete(login);
    });
  questionsInFlight.set(login, promise);
  return promise;
}

// ---------- Refresh debouncing ----------

export function scheduleRefresh(sessionId: string | null): void {
  if (!selectedHeadId) return;
  if (!infoWindow || infoWindow.isDestroyed() || !infoWindow.isVisible()) {
    return;
  }
  // If we know which session changed, skip refreshes whose session isn't in
  // the currently-shown head. Fall through when we can't tell.
  if (sessionId) {
    const cached = sessionCache.get(selectedHeadId);
    if (cached && !cached.some((s) => s.id === sessionId)) return;
  }
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshNow();
  }, REFRESH_DEBOUNCE_MS);
}

async function refreshNow(): Promise<void> {
  if (!selectedHeadId) return;
  if (!infoWindow || infoWindow.isDestroyed() || !infoWindow.isVisible()) {
    return;
  }
  const head = deps.getHeads().find((h) => h.id === selectedHeadId);
  if (!head) return;
  // Only drop the selected head's cache; other heads stay warm until clicked.
  sessionCache.delete(head.id);
  try {
    await fetchSessionsForHead(head.id);
    pushInfoShowSnapshot(infoWindow, head, undefined);
  } catch (e) {
    console.warn("[ws] refreshInfoNow failed:", e);
  }
}

// ---------- Heads-change orchestration ----------

// Called from rail.onChange after `heads` updates. Drops the selection if
// its head left the rail, repositions the popover against the stashed bubble
// (rail data changed but bubble screen-coords are still valid), and pre-warms
// the session cache for newly-arrived heads.
export function onHeadsChanged(heads: ChatHead[]): void {
  if (selectedHeadId && !heads.some((h) => h.id === selectedHeadId)) {
    hideNow();
  }
  if (heads.length > 0) {
    repositionIfVisibleAtStash();
  }
  for (const h of heads) {
    if (!sessionCache.has(h.id)) void fetchSessionsForHead(h.id);
  }
}

// ---------- window:requestResize bridge ----------

// Returns true when the resize was for the info window and was handled. The
// caller (index.ts) falls through to the tray-popup case otherwise so we
// don't have to leak the tray dispatch into this module.
export function tryHandleResize(win: BrowserWindow, height: number): boolean {
  if (win !== infoWindow) return false;
  const h = clampInfoHeight(height);
  if (h === infoCurrentHeight) return true;
  infoCurrentHeight = h;
  if (selectedHeadId) infoHeightByHead.set(selectedHeadId, h);

  if (selectedHeadId) {
    repositionIfVisibleAtStash();
  } else {
    // Nothing selected (renderer resizing during fade-out or initial load).
    // Apply the new height so the next show lands correctly.
    const b = win.getBounds();
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: h });
  }
  return true;
}

// ---------- IPC + side-effect subscriptions ----------

export function registerInfo(d: InfoDeps): void {
  deps = d;

  ipcMain.handle(
    "heads:showInfo",
    (_e, headId: string, bubbleScreen?: { x: number; y: number }): void => {
      if (!d.getHeads().some((h) => h.id === headId)) return;
      void showInfo(headId, bubbleScreen);
    },
  );

  ipcMain.handle("info:hide", (): void => scheduleHideInfo());
  ipcMain.handle("info:hoverEnter", (): void => cancelHideInfo());
  ipcMain.handle("info:hoverLeave", (): void => scheduleHideInfo());

  // Renderer signals it has committed the latest info:show payload and reports
  // its measured content height. showInfo awaits this so it can size + place
  // the window correctly on the first setBounds, instead of positioning with
  // the previous head's height and then snapping up on the next requestResize.
  // Use `on` (fire-and-forget) — the renderer doesn't need a reply.
  ipcMain.on("info:show:ready", (_e, height?: unknown): void => {
    const safeHeight =
      typeof height === "number" && Number.isFinite(height) && height > 0
        ? Math.round(height)
        : null;
    const next = infoShowReadyResolvers.shift();
    if (next) next(safeHeight);
  });

  ipcMain.handle("sessions:forHead", async (_e, headId: string): Promise<InfoSession[]> => {
    return fetchSessionsForHead(headId);
  });

  // Preload sessions for a head on hover to avoid flicker when opening info window
  ipcMain.handle("sessions:preload", async (_e, headId: string): Promise<void> => {
    void fetchSessionsForHead(headId);
  });

  ipcMain.handle(
    "chat:openSessionCard",
    (_e, payload: { sessionId: string; login: string }): void => {
      const headId = rail.userHeadId(payload.login);
      if (!d.getHeads().some((h) => h.id === headId)) return;
      void showInfo(headId, undefined, payload.sessionId);
    },
  );

  // Renderer's 15s refresh wants fresh data, but also fires the same fetcher
  // on initial load when main hasn't cached yet. Dedupe against any in-flight
  // fetch (so showInfo's bg fetch + this IPC share one HTTP request); fall
  // back to a fresh fetch when nothing's pending so the 15s tick stays live.
  ipcMain.handle("chat:questionsForLogin", async (_e, login: string) => {
    const inFlight = questionsInFlight.get(login);
    if (inFlight) return { threads: await inFlight };
    const res = await backend.fetchQuestionsForLogin(login);
    questionsCache.set(login, res.threads);
    return res;
  });

  // Push a presence update into the info window only while it's showing the
  // head whose login just changed. Fallback poll lives in the renderer.
  peerPresence.onChange(({ login, presence }) => {
    if (!infoWindow || infoWindow.isDestroyed() || !selectedHeadId) return;
    const shownLogin = rail.parseUserHeadId(selectedHeadId);
    if (shownLogin !== login) return;
    infoWindow.webContents.send("info:presence", { login, spotify: presence });
  });
}
