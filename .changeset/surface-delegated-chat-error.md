---
"@slashtalk/electron": patch
---

Surface the real failure reason when the Ask window's local agent run fails. Previously a non-success result from the Claude Agent SDK was collapsed to "Local agent returned an empty answer." in the renderer, hiding spawn/PATH/auth errors that only show up in the installed `.app` (Finder-launched env doesn't inherit the user's shell). The runner now captures the SDK's error message, logs it to the main process, and the IPC handler returns it as `{kind: "error"}` so the renderer renders the actual reason.
