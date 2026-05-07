---
"@slashtalk/electron": patch
---

Force WS-triggered session refreshes to bypass the 15s-poll in-flight. Without
this, a `session_updated` or `collision_detected` event landing while the
renderer's poll fetch is mid-flight would join that in-flight, resolve with
pre-event data, and repopulate the cache stale — defeating the invalidation.
Most visible failure mode: collision rings silently not painting on a real
collision when the verify call raced a poll fetch. Now `fetchSessionsForHead`
takes `{ force?: boolean }` mirroring `fetchProjectOverviewForRepo`, threaded
through `refreshNow` and the collision verifier.
