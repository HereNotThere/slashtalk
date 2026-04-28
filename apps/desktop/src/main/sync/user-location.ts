import { ipcMain } from "electron";
import * as backend from "../backend";
import type { UserLocation } from "../../shared/types";

// User location — renderer reports IANA tz + resolved city. We cache the
// latest payload so a sign-in can re-post when the renderer reported it while
// signed out, and dedup so concurrent renderers don't each fire a POST.
// lastSent is keyed by login so an account switch doesn't dedup against the
// previous account's value (and a sign-out racing the POST can't restore a
// stale lastSent that hides the next account's flush).
let lastKnownUserLocation: UserLocation | null = null;
let lastSentUserLocation: { login: string; location: UserLocation } | null = null;
let userLocationFlush: Promise<void> | null = null;

async function flushUserLocation(): Promise<void> {
  if (userLocationFlush) return userLocationFlush;
  userLocationFlush = (async () => {
    try {
      // Loop so a setLocation arriving while the POST is in flight still
      // gets sent — otherwise the new value would land in lastKnown but
      // never trigger a follow-up flush.
      while (true) {
        const auth = backend.getAuthState();
        if (!auth.signedIn) return;
        const next = lastKnownUserLocation;
        if (!next) return;
        const login = auth.user.githubLogin;
        if (
          lastSentUserLocation &&
          lastSentUserLocation.login === login &&
          lastSentUserLocation.location.timezone === next.timezone &&
          lastSentUserLocation.location.city === next.city
        ) {
          return;
        }
        await backend.postUserLocation(next);
        // Re-check after await: if we signed out or switched accounts during
        // the POST, dropping the write keeps lastSent from masking the next
        // account's flush.
        const after = backend.getAuthState();
        if (after.signedIn && after.user.githubLogin === login) {
          lastSentUserLocation = { login, location: next };
        }
      }
    } catch (err) {
      console.warn("[user-location] post failed", err);
    } finally {
      userLocationFlush = null;
    }
  })();
  return userLocationFlush;
}

export function register(): void {
  ipcMain.handle("user:setLocation", async (_e, payload: UserLocation): Promise<void> => {
    lastKnownUserLocation = payload;
    await flushUserLocation();
  });

  backend.onChange((state) => {
    if (state.signedIn) void flushUserLocation();
  });
}
