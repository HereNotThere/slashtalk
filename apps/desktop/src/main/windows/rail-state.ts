// Rail-state preferences (pinned / session-only / collapse-inactive /
// show-timestamps / spotify-share) — the store-backed knobs the user
// controls from the tray popup. This module owns the persistence keys, the
// getter/setter pairs, and the rail-target broadcasts that fan each change
// out to the overlay, main, and tray-popup renderers.
//
// Cross-cutting reconciliation (apply pin to the overlay's setAlwaysOnTop,
// arm/disarm hover polling, surface session-only-mode visibility) stays in
// index.ts — those side effects span hover-polling and rail-visibility too.

import type { BrowserWindow } from "electron";
import type { DashboardScope } from "@slashtalk/shared";
import * as store from "../store";
import { broadcast } from "./broadcast";

const PINNED_KEY = "railPinned";
const SESSION_ONLY_KEY = "railSessionOnlyMode";
const COLLAPSE_INACTIVE_KEY = "railCollapseInactive";
const SHOW_ACTIVITY_TIMESTAMPS_KEY = "showActivityTimestamps";
const SPOTIFY_SHARE_KEY = "spotifyShareEnabled";
const DASHBOARD_SCOPE_KEY = "dashboardScope";

const VALID_DASHBOARD_SCOPES: readonly DashboardScope[] = ["today", "past24h"];

interface RailStateDeps {
  getOverlay: () => BrowserWindow | null;
  getMainWindow: () => BrowserWindow | null;
  getTrayPopup: () => BrowserWindow | null;
}

let deps: RailStateDeps | null = null;

export function configureRailState(d: RailStateDeps): void {
  deps = d;
}

// ---------- Getters ----------

/** Pinned (default): rail floats above everything. Unpinned: rail behaves
 *  like a normal app window — on top only when Slashtalk is focused. */
export function getRailPinned(): boolean {
  const v = store.get<boolean>(PINNED_KEY);
  return v === undefined ? true : v;
}

/** Opt-in "show only during active sessions" mode. When on AND the rail is
 *  not pinned, the rail stays hidden until the signed-in user has a
 *  BUSY/ACTIVE session (or force-opens via the tray), then auto-hides 15
 *  min after the last session ends. Pinned wins; this preference is
 *  ignored while pinned. */
export function getRailSessionOnlyMode(): boolean {
  return store.get<boolean>(SESSION_ONLY_KEY) ?? false;
}

/** Opt-in: off by default so the macOS Automation permission dialog only
 *  fires when the user explicitly ticks the toggle in the tray popup. */
export function getSpotifyShareEnabled(): boolean {
  return store.get<boolean>(SPOTIFY_SHARE_KEY) ?? false;
}

/** On by default — peers idle past 24h collapse into a hover-expanding
 *  stack so the rail stays compact. Users can opt out via the tray to
 *  render every teammate inline. */
export function getRailCollapseInactive(): boolean {
  return store.get<boolean>(COLLAPSE_INACTIVE_KEY) ?? true;
}

/** On by default — the "Xm" / "Xh" / "Xd" age pill renders on each
 *  chathead. Users can toggle off in the tray to declutter the rail. */
export function getShowActivityTimestamps(): boolean {
  return store.get<boolean>(SHOW_ACTIVITY_TIMESTAMPS_KEY) ?? true;
}

/** Time window driving every dashboard surface (user-card PRs/standup +
 *  project-card overview). Default `today` — anchored to the *target's* tz
 *  on user surfaces, the *caller's* tz on the project surface. Switching to
 *  `past24h` collapses both into a single tz-neutral window, useful when
 *  caller and target are on different calendar dates. Validated against the
 *  enum so a stale serialised value can't poison the dashboards. */
export function getDashboardScope(): DashboardScope {
  const v = store.get<string>(DASHBOARD_SCOPE_KEY);
  return (VALID_DASHBOARD_SCOPES as readonly string[]).includes(v ?? "")
    ? (v as DashboardScope)
    : "today";
}

// ---------- Setters ----------

export function setRailPinned(value: boolean): void {
  store.set(PINNED_KEY, value);
}

export function setRailSessionOnlyMode(value: boolean): void {
  store.set(SESSION_ONLY_KEY, value);
}

export function setRailCollapseInactive(value: boolean): void {
  store.set(COLLAPSE_INACTIVE_KEY, value);
}

export function setShowActivityTimestamps(value: boolean): void {
  store.set(SHOW_ACTIVITY_TIMESTAMPS_KEY, value);
}

export function setSpotifyShareEnabled(value: boolean): void {
  store.set(SPOTIFY_SHARE_KEY, value);
}

export function setDashboardScope(value: DashboardScope): void {
  if (!(VALID_DASHBOARD_SCOPES as readonly string[]).includes(value)) return;
  store.set(DASHBOARD_SCOPE_KEY, value);
}

// ---------- Broadcasts ----------

/** Send `payload` on `channel` to every renderer that consumes rail state:
 *  overlay (the rail itself), main (settings UI), tray popup (toggles). */
function broadcastToRailTargets<T>(channel: string, payload: T): void {
  if (!deps) return;
  broadcast(channel, payload, deps.getOverlay(), deps.getMainWindow(), deps.getTrayPopup());
}

export function broadcastRailPinned(): void {
  broadcastToRailTargets("rail:pinned", getRailPinned());
}

export function broadcastRailSessionOnlyMode(): void {
  broadcastToRailTargets("rail:sessionOnlyMode", getRailSessionOnlyMode());
}

export function broadcastRailCollapseInactive(): void {
  broadcastToRailTargets("rail:collapseInactive", getRailCollapseInactive());
}

export function broadcastShowActivityTimestamps(): void {
  broadcastToRailTargets("rail:showActivityTimestamps", getShowActivityTimestamps());
}

export function broadcastDashboardScope(): void {
  broadcastToRailTargets("rail:dashboardScope", getDashboardScope());
}
