---
"@slashtalk/electron": patch
---

Auto-update via electron-updater + GitHub Releases. The desktop app checks for updates 5s after launch and every hour, auto-downloads, then prompts the user to restart now or apply on next quit. A "Check for updates" button in the tray popover triggers a manual check. Mac builds now ship per-arch `.zip` artifacts and `latest-mac.yml` alongside the existing DMGs so the updater has something to consume.
