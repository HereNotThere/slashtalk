// Per-user "active org + selected repos" state.
//
// Backend is the social-graph source of truth — every org-mate is visible in
// the feed regardless of this state. This module powers a client-only filter
// so the user can prune their own chathead rail and tray popup to the repos
// they're focused on today.
//
// Shape:
//   - orgs                : the user's GitHub orgs (proxied via /api/me/orgs)
//   - activeOrg           : one org at a time; switcher lives in the tray popup
//   - reposByOrg          : cached /api/me/orgs/:org/repos per active org
//   - selectedByOrg       : per-org Set of selected repo fullNames (default = all on)
//
// The selection is persisted to the local store so it survives relaunch.

import type { OrgRepo, OrgSummary } from "@slashtalk/shared";
import * as backend from "./backend";
import * as store from "./store";
import { createEmitter } from "./emitter";

const ACTIVE_ORG_KEY = "orgRepos.activeOrg";
const SELECTED_BY_ORG_KEY = "orgRepos.selectedByOrg";

let orgs: OrgSummary[] = [];
let activeOrg: string | null = null;
const reposByOrg = new Map<string, OrgRepo[]>();
const selectedByOrg = new Map<string, Set<string>>();

const orgsChanges = createEmitter<OrgSummary[]>();
const activeOrgChanges = createEmitter<string | null>();
const reposChanges = createEmitter<OrgRepo[]>();
const selectionChanges = createEmitter<string[]>();

export const onOrgsChange = orgsChanges.on;
export const onActiveOrgChange = activeOrgChanges.on;
export const onReposChange = reposChanges.on;
export const onSelectionChange = selectionChanges.on;

export function getOrgs(): OrgSummary[] {
  return orgs;
}

export function getActiveOrg(): string | null {
  return activeOrg;
}

export function getReposForActiveOrg(): OrgRepo[] {
  if (!activeOrg) return [];
  return reposByOrg.get(activeOrg) ?? [];
}

export function getSelectedFullNamesSet(): Set<string> {
  if (!activeOrg) return new Set();
  return selectedByOrg.get(activeOrg) ?? new Set();
}

export function getSelectedFullNames(): string[] {
  return [...getSelectedFullNamesSet()];
}

/** True once we have a non-empty repo list for the currently active org.
 *  The rail filter keys on this: it only narrows peers when we actually
 *  have data to narrow by. A pending fetch, a permissions error, or a
 *  scope-blocked OAuth token all land as "empty" on the desktop — and we
 *  treat those the same as "not loaded" so the rail never silently empties.
 *  A genuine zero-repo org is rare and indistinguishable from an error, so
 *  we lean toward over-showing peers rather than hiding them. */
export function hasLoadedReposForActiveOrg(): boolean {
  if (!activeOrg) return false;
  const list = reposByOrg.get(activeOrg);
  return !!list && list.length > 0;
}

function persistActiveOrg(): void {
  if (activeOrg == null) store.del(ACTIVE_ORG_KEY);
  else store.set(ACTIVE_ORG_KEY, activeOrg);
}

function persistSelection(): void {
  const obj: Record<string, string[]> = {};
  for (const [org, set] of selectedByOrg) obj[org] = [...set];
  store.set(SELECTED_BY_ORG_KEY, obj);
}

function restoreFromStore(): void {
  const savedActive = store.get<string>(ACTIVE_ORG_KEY);
  if (typeof savedActive === "string") activeOrg = savedActive;
  const savedSelection = store.get<Record<string, string[]>>(
    SELECTED_BY_ORG_KEY,
  );
  if (savedSelection && typeof savedSelection === "object") {
    for (const [org, list] of Object.entries(savedSelection)) {
      if (Array.isArray(list)) selectedByOrg.set(org, new Set(list));
    }
  }
}

async function loadOrgs(): Promise<void> {
  try {
    const fetched = await backend.listOrgs();
    orgs = fetched;
    orgsChanges.emit(orgs);

    // Drop a restored activeOrg that no longer matches any fetched org.
    if (activeOrg && !orgs.some((o) => o.login === activeOrg)) {
      activeOrg = null;
      persistActiveOrg();
      activeOrgChanges.emit(null);
    }

    // If nothing is active and we've got at least one org, default to first.
    if (!activeOrg && orgs.length > 0) {
      await setActiveOrg(orgs[0].login);
    } else if (activeOrg) {
      // Re-hydrate repo list for the restored active org.
      await loadReposForActiveOrg();
    }
  } catch (err) {
    console.warn("[orgRepos] loadOrgs failed:", (err as Error).message);
  }
}

async function loadReposForActiveOrg(): Promise<void> {
  const org = activeOrg;
  if (!org) {
    reposChanges.emit([]);
    return;
  }
  try {
    const fetched = await backend.listOrgRepos(org);
    reposByOrg.set(org, fetched);
    reposChanges.emit(fetched);

    // Default-on: seed selection to every fetched repo when we've never
    // recorded a selection for this org. A stored empty set is respected —
    // the user explicitly cleared everything.
    if (!selectedByOrg.has(org)) {
      selectedByOrg.set(org, new Set(fetched.map((r) => r.fullName)));
      persistSelection();
      selectionChanges.emit([...selectedByOrg.get(org)!]);
    }
  } catch (err) {
    console.warn("[orgRepos] loadReposForActiveOrg failed:", (err as Error).message);
  }
}

export async function setActiveOrg(login: string): Promise<void> {
  if (!orgs.some((o) => o.login === login)) return;
  if (activeOrg === login) return;
  activeOrg = login;
  persistActiveOrg();
  activeOrgChanges.emit(activeOrg);
  // Emit the (possibly empty) cached repos for this org so the tray can paint
  // immediately; the fresh fetch arrives next.
  reposChanges.emit(reposByOrg.get(login) ?? []);
  selectionChanges.emit([...(selectedByOrg.get(login) ?? new Set())]);
  await loadReposForActiveOrg();
  selectionChanges.emit([...(selectedByOrg.get(login) ?? new Set())]);
}

export function toggleRepo(fullName: string): string[] {
  if (!activeOrg) return [];
  const current = selectedByOrg.get(activeOrg) ?? new Set<string>();
  if (current.has(fullName)) current.delete(fullName);
  else current.add(fullName);
  selectedByOrg.set(activeOrg, current);
  persistSelection();
  const asList = [...current];
  selectionChanges.emit(asList);
  return asList;
}

function clearOnSignOut(): void {
  orgs = [];
  activeOrg = null;
  reposByOrg.clear();
  selectedByOrg.clear();
  store.del(ACTIVE_ORG_KEY);
  store.del(SELECTED_BY_ORG_KEY);
  orgsChanges.emit(orgs);
  activeOrgChanges.emit(null);
  reposChanges.emit([]);
  selectionChanges.emit([]);
}

export function start(): void {
  restoreFromStore();
  backend.onChange((state) => {
    if (state.signedIn) void loadOrgs();
    else clearOnSignOut();
  });
  if (backend.getAuthState().signedIn) void loadOrgs();
}

export async function refreshForActiveOrg(): Promise<void> {
  await loadReposForActiveOrg();
}

export async function refreshOrgs(): Promise<void> {
  await loadOrgs();
}
