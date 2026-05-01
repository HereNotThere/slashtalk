// Electron on macOS launched from Finder/Dock inherits the system PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), not the user's shell PATH. Homebrew bins
// (/opt/homebrew/bin on Apple Silicon, /usr/local/bin on Intel) and version-
// manager shims (asdf, mise, fnm) are absent — so spawned CLIs like `gh` and
// `claude` ENOENT even when the user has them installed. Symptom: the user-
// card "PRs pushed" section flashes the install-gh nudge for self even after
// `brew install gh && gh auth login`.
//
// Fix: ask the user's interactive login shell for its PATH and prepend it.
// Static Homebrew defaults are layered in as a fallback so a slow or broken
// rc file can't leave us worse off than the system default. Runs once at
// main-process startup; must be called before any module's lazy CLI probe.

import { execFileSync } from "node:child_process";

const HOMEBREW_DEFAULTS = ["/opt/homebrew/bin", "/usr/local/bin"];

export function fixPath(): void {
  if (process.platform !== "darwin") return;

  const current = (process.env.PATH ?? "").split(":").filter(Boolean);
  let shellEntries: string[] = [];

  try {
    const shell = process.env.SHELL || "/bin/zsh";
    // `-ilc` runs an interactive login shell so PATH mutations in .zshrc /
    // .bash_profile take effect. printf (no newline) keeps stdout clean —
    // some users have rc files that echo banners; we only want PATH.
    const stdout = execFileSync(shell, ["-ilc", 'command printf %s "$PATH"'], {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    shellEntries = stdout.trim().split(":").filter(Boolean);
  } catch {
    // Probe failed (timeout, missing shell, bad rc). Fall through to static.
  }

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const p of [...shellEntries, ...HOMEBREW_DEFAULTS, ...current]) {
    if (!seen.has(p)) {
      seen.add(p);
      merged.push(p);
    }
  }
  process.env.PATH = merged.join(":");
}
