---
"@slashtalk/electron": patch
---

Tighten the gap above markdown blocks (e.g. PAST 24H summary in the hierarchy dashboard) by stripping the leading/trailing margin on the first and last children. The first paragraph's `my-2` was stacking on top of the container's padding, making the section look visibly looser than the adjacent "Now" block.
