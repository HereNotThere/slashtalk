---
"@slashtalk/electron": patch
---

Stop the info window's "Now" section from sticking on a stale BUSY/ACTIVE session.

The desktop's per-head session cache held rows indefinitely until a `session_updated` WebSocket message invalidated them, but those messages are only emitted when the server's classification changes — so a stuck `inTurn=true` (or a single dropped packet during the BUSY → IDLE transition) left the cache serving "working now…" forever. Cache entries now expire after 10 seconds, so the renderer's 15s polling tick always refetches; rapid re-hovers within the window still hit cache for snappy paint.
