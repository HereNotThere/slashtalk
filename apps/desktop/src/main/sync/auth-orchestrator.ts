import * as anthropic from "../anthropic";
import * as backend from "../backend";
import * as chatheadsAuth from "../chatheadsAuth";
import * as githubAuth from "../githubDeviceAuth";
import * as heartbeat from "../heartbeat";
import * as localRepos from "../localRepos";
import * as peerLocations from "../peerLocations";
import * as peerPresence from "../peerPresence";
import * as uploader from "../uploader";
import * as ws from "../ws";
import * as info from "../windows/info";
import * as spotifyToggle from "./spotify-toggle";
import { broadcast } from "../windows/broadcast";
import { getMainWindow } from "../windows/main";
import { getTrayPopup } from "../windows/tray";

function applySyncForAuth(signedIn: boolean): void {
  if (signedIn) {
    // Without these catches a thrown start() (e.g. fs.mkdir EACCES on
    // ~/.claude/projects, or an fs.watch that fails on a quirky filesystem)
    // is swallowed and the UI flips to "signed in" while nothing is actually
    // running — same shape the cursor-bot caught on heartbeat.
    void uploader.start().catch((err) => console.warn("uploader.start failed:", err));
    void heartbeat.start().catch((err) => console.warn("heartbeat.start failed:", err));
    spotifyToggle.updateSpotifyRunning();
    void peerPresence.start().catch((err) => console.warn("peerPresence.start failed:", err));
    void peerLocations.start().catch((err) => console.warn("peerLocations.start failed:", err));
    ws.start();
  } else {
    heartbeat.stop();
    uploader.reset();
    spotifyToggle.updateSpotifyRunning();
    peerPresence.stop();
    peerLocations.stop();
    ws.stop();
    info.clearQuestionsCache();
  }
}

// Mirrors backend / chathead / github / anthropic / localRepos state changes
// out to the renderer windows that react to them. Each fan-out is one line —
// kept here (rather than at each module's call site) so the full picture of
// "who hears about auth state" lives in one place.
export function registerAuthOrchestrator(): void {
  backend.onChange((state) => applySyncForAuth(state.signedIn));

  backend.onChange((state) => broadcast("backend:authState", state, getMainWindow()));
  // Tray popup shows sign-in state too — mirror to it so the CTA flips live.
  backend.onChange((state) => broadcast("backend:authState", state, getTrayPopup()));

  localRepos.onChange((repos) =>
    broadcast("backend:trackedRepos", repos, getMainWindow(), getTrayPopup()),
  );
  localRepos.onSelectionChange((ids) =>
    broadcast("trackedRepos:selectionChange", [...ids], getMainWindow(), getTrayPopup()),
  );

  chatheadsAuth.onChange((state) => broadcast("chatheads:authState", state, getMainWindow()));
  githubAuth.onChange((state) => broadcast("github:state", state, getMainWindow()));
  anthropic.onConfiguredChange((configured) =>
    broadcast("agents:configured", configured, getMainWindow()),
  );
}

// Drives the initial sync run after the on-disk auth state has been
// restored. backend.onChange would fire applySyncForAuth on a later state
// transition, but the initial signed-in case needs an explicit kick.
export function applyInitialSync(): void {
  applySyncForAuth(backend.getAuthState().signedIn);
}
