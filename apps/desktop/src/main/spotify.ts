// Polls the macOS Spotify desktop app via AppleScript and broadcasts the
// current track to the server so peers can see it on our user card. Clears
// when Spotify is stopped/paused/quit so the card goes blank.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as backend from "./backend";
import { parseSpotifyOutput, type Track } from "./spotifyParse";

const execFileAsync = promisify(execFile);

const POLL_MS = 10_000;
// Keep re-posting the same track every minute so the server's Redis TTL
// (120s) doesn't drop us while a long song plays.
const KEEPALIVE_MS = 60_000;
// If osascript hangs (Spotify beach-balling), don't block the poller.
const OSASCRIPT_TIMEOUT_MS = 3_000;

// Fields are tab-separated: state \t spotifyUri \t name \t artist.
// Sentinels: "not-running" | "stopped" | "error" | "".
const SCRIPT = `
tell application "System Events"
  if not (exists process "Spotify") then return "not-running"
end tell
tell application "Spotify"
  try
    set s to player state as string
    if s is "stopped" then return "stopped"
    set u to spotify url of current track
    set n to name of current track
    set a to artist of current track
    return s & tab & u & tab & n & tab & a
  on error
    return "error"
  end try
end tell
`;

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastSentId: string | null = null;
let lastSentAt = 0;

async function read(): Promise<Track | null> {
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", SCRIPT], {
      timeout: OSASCRIPT_TIMEOUT_MS,
    });
    return parseSpotifyOutput(stdout.trim());
  } catch {
    // macOS Automation permission denied, Spotify hung past timeout, or
    // AppleScript bridge refused — treat as "no track".
    return null;
  }
}

async function tick(): Promise<void> {
  if (!running) return;
  const track = await read();
  const now = Date.now();
  if (track) {
    const changed = lastSentId !== track.trackId;
    const stale = now - lastSentAt > KEEPALIVE_MS;
    if (!changed && !stale) return;
    try {
      await backend.postSpotifyPresence(track);
      lastSentId = track.trackId;
      lastSentAt = now;
      if (changed) {
        console.log(`[spotify] → ${track.name} — ${track.artist}`);
      }
    } catch (err) {
      console.warn("[spotify] post failed", err);
    }
  } else if (lastSentId !== null) {
    try {
      await backend.postSpotifyPresence(null);
      console.log("[spotify] cleared");
    } catch (err) {
      console.warn("[spotify] clear failed", err);
    }
    lastSentId = null;
    lastSentAt = now;
  }
}

export async function start(): Promise<void> {
  if (running) return;
  if (process.platform !== "darwin") {
    console.log("[spotify] skipped — macOS only");
    return;
  }
  running = true;
  lastSentId = null;
  lastSentAt = 0;
  await tick();
  timer = setInterval(() => void tick(), POLL_MS);
}

export function stop(): void {
  if (!running) return;
  running = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // Don't POST on stop — creds may already be gone. Server's Redis TTL
  // drops us within ~2 minutes.
  lastSentId = null;
  lastSentAt = 0;
}
