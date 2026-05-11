---
"@slashtalk/electron": minor
---

Use the user's installed `claude` CLI instead of bundling the ~200MB platform-specific binary. The packaged DMG drops from ~250MB to ~190MB; on-disk app from ~677MB to ~487MB. Slashtalk now expects Claude Code to already be installed on the user's machine and resolves it via `command -v claude` in a login shell (picks up nvm/Volta/Bun/Homebrew PATH mutations that GUI-launched Electron doesn't inherit on macOS), falling back to common install locations (`/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin`, `~/.bun/bin`, `~/.npm-global/bin`, `~/.volta/bin`). When no `claude` is found, the chat surfaces a clear "install Claude Code" message instead of a cryptic spawn failure.
