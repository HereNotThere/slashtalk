---
"@slashtalk/electron": patch
---

Fix the info popover dismissing instantly when opened by clicking an avatar in a project card's Active strip. The popover used the same hover-managed lifecycle for click and hover, so a click that triggered a reposition (the new head's bubble lives elsewhere on the rail than the previous one) immediately fired `mouseleave` and dismissed the card before the user could interact with it.

Click-opened popovers are now pinned: `info:hoverLeave` is a no-op until the cursor enters the window, at which point the pin "graduates" to the normal hover-managed mode (so hovering off → onto another bubble dismisses naturally). ESC and clicking another of our windows still dismiss while pinned. No new UI affordance.
