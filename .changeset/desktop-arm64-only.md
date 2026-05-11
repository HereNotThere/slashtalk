---
"@slashtalk/electron": minor
---

Ship Apple Silicon (arm64) builds only. The universal target embedded both x64 and arm64 slices of the Electron framework into every download (~415MB raw); dropping x64 halves that, and Apple has not shipped Intel Macs since mid-2023. Intel Mac users on the existing universal build won't auto-update (electron-updater filters `latest-mac.yml` by `process.arch` and there'll be no x64 entry); they can keep using their installed version.
