import { BrowserWindow, ipcMain, nativeTheme, screen } from "electron";
import type { ChatHead, GhStatus, InfoDashboardData, InfoSession } from "../../shared/types";
import type { ProjectOverviewResponse, UserPr } from "@slashtalk/shared";
import * as backend from "../backend";
import * as localRepos from "../localRepos";
import * as rail from "../rail";
import * as peerPresence from "../peerPresence";
import * as peerLocations from "../peerLocations";
import { fetchGhUserPrs } from "../ghPrs";
import { getDashboardScope } from "./rail-state";
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

// Per-login dashboard cache covering both PRs and standup for that user.
// Keyed by github login because the data is target-specific (a PR list /
// standup blurb is about that user's day). Cleared inline by refreshNow on
// session updates for the currently-shown head. Server caches the standup
// for ~5 min so the cost of a refetch is mostly the DB round-trip.
const dashboardCache = new Map<string, InfoDashboardData>();
const dashboardInFlight = new Map<string, Promise<InfoDashboardData>>();

// Per-repo project-overview cache. Same SWR pattern as `dashboardCache`:
// every showProjectInfo deletes the entry and refetches so the renderer
// paints from the previous snapshot for instant feedback and re-renders
// when the fresh data lands. Server caches the LLM-derived pulse+buckets
// for ~5min with a key that folds in the in-window PR set (see
// apps/server/src/repo/overview.ts), so a single PR change naturally busts
// the LLM cache on the next request.
const projectOverviewCache = new Map<string, ProjectOverviewResponse>();
// Promises stored here always resolve (never reject) — see
// fetchProjectOverviewForRepo. Null means the fetch failed; callers
// `.finally()` chain on this map's entries can't trip an unhandled rejection.
const projectOverviewInFlight = new Map<string, Promise<ProjectOverviewResponse | null>>();

// User toggled which local repos are tracked: clear optimistically so the
// next hover doesn't paint stale cache. Then again on `onClaimsSettled` to
// pick up the server's post-sync view (claim succeeded, `noClaimedRepos`
// flipped, etc.). Cheap: at most one HTTP roundtrip per visible login on
// next paint.
export const clearDashboardCache = (): void => {
  if (dashboardCache.size === 0) return;
  dashboardCache.clear();
};
localRepos.onSelectionChange(clearDashboardCache);
localRepos.onClaimsSettled(clearDashboardCache);

// Repo claim/selection changes also affect what overview data the caller is
// allowed to see (gate is `user_repos`). Wholesale-clear so the next hover
// repaints from fresh data.
export const clearProjectOverviewCache = (): void => {
  if (projectOverviewCache.size === 0) return;
  projectOverviewCache.clear();
};
localRepos.onSelectionChange(clearProjectOverviewCache);
localRepos.onClaimsSettled(clearProjectOverviewCache);

/** Drop the cached overview for one repo. Used by the WS handler when a
 *  `pr_activity` lands so the next hover repaints with fresh data. */
export function invalidateProjectOverview(repoFullName: string): void {
  projectOverviewCache.delete(repoFullName);
}

/** Toggling the dashboard scope retargets the server window, so every cached
 *  entry is stale AND any in-flight fetch is producing old-scope data. Drop
 *  in-flight maps too — the `=== promise` identity guard at write-time then
 *  rejects those late-landing writes instead of letting them poison the
 *  freshly-cleared cache. */
export function onDashboardScopeChanged(): void {
  clearDashboardCache();
  clearProjectOverviewCache();
  dashboardInFlight.clear();
  projectOverviewInFlight.clear();
  if (selectedHeadId && infoWindow && !infoWindow.isDestroyed() && infoWindow.isVisible()) {
    refreshNow();
  }
}

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
// newer hover has taken over (head no longer selected). `dashboardFetching`
// and `projectOverviewFetching` derive from their in-flight maps so a
// superseded promise's settled push can't accidentally mark a still-pending
// newer fetch as "done."
function pushInfoShowSnapshot(
  win: BrowserWindow | null,
  head: ChatHead,
  expandSessionId?: string,
): void {
  if (!win || win.isDestroyed()) return;
  if (selectedHeadId !== head.id) return;
  const login = rail.parseUserHeadId(head.id);
  const dashboard = login ? (dashboardCache.get(login) ?? null) : null;
  const dashboardFetching = login ? dashboardInFlight.has(login) : false;
  const repoFullName = head.kind === "project" ? (head.repoFullName ?? null) : null;
  const projectOverview = repoFullName ? (projectOverviewCache.get(repoFullName) ?? null) : null;
  const projectOverviewFetching = repoFullName ? projectOverviewInFlight.has(repoFullName) : false;
  win.webContents.send("info:show", {
    head,
    sessions: sessionCache.get(head.id) ?? null,
    expandSessionId: expandSessionId ?? null,
    spotify: login ? (peerPresence.get(login) ?? null) : null,
    location: login ? (peerLocations.get(login) ?? null) : null,
    isSelf: backend.isSelf(login),
    dashboard,
    dashboardFetching,
    projectOverview,
    projectOverviewFetching,
  });
}

async function showInfo(
  headId: string,
  bubbleScreen?: { x: number; y: number },
  expandSessionId?: string,
  headOverride?: ChatHead,
): Promise<void> {
  if (getIsDragging()) return;
  // Project heads are synthetic — they don't live in `getHeads()`. Callers
  // that build a project head pass it in directly via `headOverride`.
  const head = headOverride ?? deps.getHeads().find((h) => h.id === headId);
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
  const projectFullName = head.kind === "project" ? (head.repoFullName ?? null) : null;
  const firstShow = !win.isVisible();
  // Kick off the dashboard refetch *before* the snapshot push so
  // `dashboardInFlight` is populated by the time the snapshot reads it.
  // Otherwise the renderer would treat any cached `summary: null` as
  // "genuinely empty" instead of showing the shimmer. SWR pattern: the
  // snapshot still paints the previous cache entry; the fetch lands later
  // and re-pushes the fresh value.
  const dashboardPromise = login ? fetchDashboardForLogin(login, { force: true }) : null;
  const projectOverviewPromise = projectFullName
    ? fetchProjectOverviewForRepo(projectFullName, { force: true })
    : null;
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

  // Push as each fetch settles independently — the dashboard standup can
  // take several seconds on a cache miss, and we don't want to gate the
  // (typically faster) session refresh behind it. Two re-renders are fine;
  // each push reads the latest cache state. Drop expandSessionId on these
  // follow-ups: the initial push already carried it, and re-sending bumps
  // expandRequest.nonce in the renderer, which re-expands a session the
  // user may have manually collapsed mid-fetch.
  const pushFollowUp = (): void => pushInfoShowSnapshot(infoWindow, head, undefined);
  // Project heads don't have per-head sessions — skip the session fetch.
  if (head.kind !== "project" && !sessionCache.has(head.id)) {
    void fetchSessionsForHead(head.id).finally(pushFollowUp);
  }
  if (dashboardPromise) void dashboardPromise.finally(pushFollowUp);
  if (projectOverviewPromise) void projectOverviewPromise.finally(pushFollowUp);
}

/** Hover-show entry for a synthetic project head. The repo full-name is the
 *  canonical id; the ChatHead shape lives in rail.ts so callers don't need
 *  to know the tint/avatar conventions. */
async function showProjectInfo(
  repoFullName: string,
  bubbleScreen?: { x: number; y: number },
): Promise<void> {
  const head = rail.projectHead(repoFullName);
  return showInfo(head.id, bubbleScreen, undefined, head);
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

// True when the selected head is a synthetic project head — those don't
// live in `getHeads()`, so the membership guard below would wrongly bail.
function selectedIsSynthetic(): boolean {
  return selectedHeadId !== null && rail.parseProjectHeadId(selectedHeadId) !== null;
}

// Re-anchor using fallback math (rail-derived bubble position). For dock
// flips and drag ticks where the rail has moved.
export function repositionIfVisible(): void {
  if (!selectedHeadId) return;
  // Synthetic project heads have no rail bubble — fallback math collapses to
  // idx 0 (top of rail) which mispositions the popover. Skip; the popover
  // stays put through the drag and the next hover snaps it back.
  if (selectedIsSynthetic()) return;
  if (!deps.getHeads().some((h) => h.id === selectedHeadId)) return;
  positionInfo(selectedHeadId);
}

// Re-anchor against the stashed bubble screen-coords. For data-only changes
// (rail.onChange) where the bubble itself hasn't moved — the fallback math
// would miss by a slot for peers in a peek-collapsed stack.
export function repositionIfVisibleAtStash(): void {
  if (!selectedHeadId) return;
  if (!selectedIsSynthetic() && !deps.getHeads().some((h) => h.id === selectedHeadId)) return;
  positionInfo(selectedHeadId, selectedBubbleScreen ?? undefined);
}

// ---------- Cache + fetchers ----------

export async function fetchSessionsForHead(headId: string): Promise<InfoSession[]> {
  const cached = sessionCache.get(headId);
  if (cached) return cached;

  const state = backend.getAuthState();
  if (!state.signedIn) return [];

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

async function fetchProjectOverviewForRepo(
  repoFullName: string,
  opts: { force?: boolean } = {},
): Promise<ProjectOverviewResponse | null> {
  if (!opts.force) {
    const cached = projectOverviewCache.get(repoFullName);
    if (cached) return cached;
    const inFlight = projectOverviewInFlight.get(repoFullName);
    if (inFlight) return inFlight;
  }
  // IIFE always resolves (mirrors fetchDashboardForLogin's posture): callers
  // chain `.finally()` directly off the returned promise, so a raw fetch
  // rejection here would surface as an unhandled rejection.
  const promise = (async (): Promise<ProjectOverviewResponse | null> => {
    try {
      return await backend.fetchProjectOverview(repoFullName, getDashboardScope());
    } catch (err) {
      console.warn(`[info] project overview fetch failed repo=${repoFullName}:`, err);
      return null;
    }
  })();
  projectOverviewInFlight.set(repoFullName, promise);
  void promise
    .then((data) => {
      // Same superseded-write guard as fetchDashboardForLogin: only commit
      // to the cache when this is still the active in-flight, and only when
      // the fetch produced data (skip the null-on-error case).
      if (data && projectOverviewInFlight.get(repoFullName) === promise) {
        projectOverviewCache.set(repoFullName, data);
      }
    })
    .finally(() => {
      if (projectOverviewInFlight.get(repoFullName) === promise) {
        projectOverviewInFlight.delete(repoFullName);
      }
    });
  return promise;
}

async function fetchDashboardForLogin(
  login: string,
  opts: { force?: boolean } = {},
): Promise<InfoDashboardData> {
  // `force` bypasses BOTH the cache and the in-flight dedupe so callers that
  // intentionally invalidated state (showInfo, refreshNow) don't get served
  // a result from a fetch started before the invalidation.
  if (!opts.force) {
    const cached = dashboardCache.get(login);
    if (cached) return cached;
    const inFlight = dashboardInFlight.get(login);
    if (inFlight) return inFlight;
  }

  // Build the result without writing cache or in-flight tracking inside the
  // IIFE — the caller-visible promise resolves with the data; mutation of
  // shared state happens in the .then below, gated on still being the
  // active in-flight. This prevents a superseded promise (bumped by a
  // forced refetch) from clobbering newer data.
  const promise = (async (): Promise<InfoDashboardData> => {
    // Self → local gh (zero poller lag + push-back to server). Peer → server
    // endpoint so its PRs and the standup blurb share one target-tz window.
    const scope = getDashboardScope();
    const standupP = backend.fetchUserStandup(login, scope);
    const prsP: Promise<{ prs: UserPr[]; ghStatus: GhStatus }> = backend.isSelf(login)
      ? fetchGhUserPrs(login, scope).then(async (r) => {
          // Soft-fail: network blip must not break the user-card.
          if (r.prs.length > 0) {
            void backend
              .pushSelfPrs(r.prs)
              .then((p) => {
                if (p.upserted > 0) {
                  console.log(
                    `[info] pushed ${p.upserted} self PR(s) to server (${p.unknownRepos} unknown repo)`,
                  );
                }
              })
              .catch((err) => {
                console.warn(`[info] pushSelfPrs failed:`, (err as Error).message);
              });
          }
          return { prs: r.prs, ghStatus: r.ghStatus };
        })
      : backend
          .fetchUserPrs(login, scope)
          .then((r) => ({ prs: r.prs, ghStatus: "ready" as const }));
    const [prsRes, standupRes] = await Promise.allSettled([prsP, standupP]);
    if (prsRes.status === "rejected") {
      console.warn(`[info] dashboard prs fetch failed login=${login}:`, prsRes.reason);
    }
    if (standupRes.status === "rejected") {
      console.warn(`[info] dashboard standup fetch failed login=${login}:`, standupRes.reason);
    }
    const prs = prsRes.status === "fulfilled" ? prsRes.value.prs : [];
    const ghStatus = prsRes.status === "fulfilled" ? prsRes.value.ghStatus : "ready";
    const standup = standupRes.status === "fulfilled" ? standupRes.value.summary : null;
    // peer 403s short-circuit before reaching here; self gh-path has no claim concept.
    const noClaimedRepos =
      standupRes.status === "fulfilled" && standupRes.value.noClaimedRepos === true;
    const targetTimezone =
      backend.isSelf(login) || standupRes.status !== "fulfilled"
        ? null
        : (standupRes.value.timezone ?? null);
    return { prs, standup, noClaimedRepos, ghStatus, targetTimezone };
  })();
  dashboardInFlight.set(login, promise);
  void promise
    .then((data) => {
      if (dashboardInFlight.get(login) === promise) {
        dashboardCache.set(login, data);
      }
    })
    .finally(() => {
      if (dashboardInFlight.get(login) === promise) {
        dashboardInFlight.delete(login);
      }
    });
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

function refreshNow(): void {
  if (!selectedHeadId) return;
  if (!infoWindow || infoWindow.isDestroyed() || !infoWindow.isVisible()) {
    return;
  }
  const head = deps.getHeads().find((h) => h.id === selectedHeadId);
  if (!head) return;
  // Only drop the selected head's cache; other heads stay warm until clicked.
  sessionCache.delete(head.id);
  const login = rail.parseUserHeadId(head.id);
  // Push each fetch independently. The session_updated signal is what
  // triggered us, so the new session data should reach the renderer ASAP —
  // not block on the standup endpoint, which can take several seconds on
  // a server-cache miss. `force: true` makes the dashboard refetch bypass
  // any in-flight that started before this signal landed.
  const pushFollowUp = (): void => pushInfoShowSnapshot(infoWindow, head, undefined);
  void fetchSessionsForHead(head.id)
    .catch((e) => console.warn("[ws] refreshNow sessions failed:", e))
    .finally(pushFollowUp);
  if (login) {
    void fetchDashboardForLogin(login, { force: true })
      .catch((e) => console.warn("[ws] refreshNow dashboard failed:", e))
      .finally(pushFollowUp);
  }
}

// ---------- Heads-change orchestration ----------

// Called from rail.onChange after `heads` updates. Drops the selection if
// its head left the rail, repositions the popover against the stashed bubble
// (rail data changed but bubble screen-coords are still valid), and pre-warms
// the session cache for newly-arrived heads.
export function onHeadsChanged(heads: ChatHead[]): void {
  // Skip the "selection left rail" check for synthetic heads (project) —
  // they don't live in `heads` to begin with, so absence is the steady state.
  if (selectedHeadId && !selectedIsSynthetic() && !heads.some((h) => h.id === selectedHeadId)) {
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
    (
      _e,
      headId: string,
      bubbleScreen?: { x: number; y: number },
      fallbackAvatarUrl?: string,
    ): void => {
      if (d.getHeads().some((h) => h.id === headId)) {
        void showInfo(headId, bubbleScreen);
        return;
      }
      // Not on the rail: synthesize when the headId is a well-formed user
      // (project-card active-people path — they're claimed user_repos
      // members but not necessarily in the social feed). Avatar URL comes
      // from the calling card so the synthetic head paints correctly.
      const login = rail.parseUserHeadId(headId);
      if (!login) return;
      void showInfo(headId, bubbleScreen, undefined, rail.synthUserHead(login, fallbackAvatarUrl));
    },
  );

  ipcMain.handle(
    "heads:showProjectInfo",
    (_e, repoFullName: string, bubbleScreen?: { x: number; y: number }): void => {
      if (typeof repoFullName !== "string" || !repoFullName.includes("/")) return;
      void showProjectInfo(repoFullName, bubbleScreen);
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

  // Push a presence update into the info window only while it's showing the
  // head whose login just changed. Fallback poll lives in the renderer.
  peerPresence.onChange(({ login, presence }) => {
    if (!infoWindow || infoWindow.isDestroyed() || !selectedHeadId) return;
    const shownLogin = rail.parseUserHeadId(selectedHeadId);
    if (shownLogin !== login) return;
    infoWindow.webContents.send("info:presence", { login, spotify: presence });
  });
}
