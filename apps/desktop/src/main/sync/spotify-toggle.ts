import { ipcMain } from "electron";
import * as backend from "../backend";
import * as spotify from "../spotify";
import { broadcast } from "../windows/broadcast";
import { getMainWindow } from "../windows/main";
import { getTrayPopup } from "../windows/tray";
import { getSpotifyShareEnabled, setSpotifyShareEnabled } from "../windows/rail-state";

// Spotify share is darwin-only — the spotify module reads NSAppleScript to
// observe the player. Keeping the platform check in updateSpotifyRunning
// (rather than at module load) lets the IPC and store still expose the toggle
// on every platform; the renderer hides it when isSupported returns false.
function updateSpotifyRunning(): void {
  const shouldRun =
    backend.getAuthState().signedIn && getSpotifyShareEnabled() && process.platform === "darwin";
  if (shouldRun) void spotify.start().catch((err) => console.warn("spotify.start failed:", err));
  else spotify.stop();
}

export function register(): void {
  ipcMain.handle("spotify:isSupported", (): boolean => process.platform === "darwin");
  ipcMain.handle("spotify:getShareEnabled", (): boolean => getSpotifyShareEnabled());
  ipcMain.handle("spotify:setShareEnabled", async (_e, enabled: boolean): Promise<void> => {
    const next = !!enabled;
    const prev = getSpotifyShareEnabled();
    if (prev === next) return;
    setSpotifyShareEnabled(next);
    broadcast("spotify:shareEnabled", next, getMainWindow(), getTrayPopup());
    // Turning off while signed in: clear peers immediately so the card
    // disappears in seconds instead of waiting for the 120s Redis TTL.
    if (prev && !next && backend.getAuthState().signedIn) {
      try {
        await backend.postSpotifyPresence(null);
      } catch (err) {
        console.warn("[spotify] clear on disable failed", err);
      }
    }
    updateSpotifyRunning();
  });
}

// Sign-in/sign-out side-effect — caller invokes from applySyncForAuth.
export { updateSpotifyRunning };
