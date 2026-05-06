---
"@slashtalk/electron": patch
---

Fix two info-card glitches: the shimmer no longer flashes on every cached refetch, and it no longer fires when hovering between teammate or project cards. The transition only runs when the same card's payload actually changes — old content is held under shimmer for ~1s, then swaps to the new render.
