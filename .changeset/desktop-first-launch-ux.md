---
"@slashtalk/electron": patch
---

Fix the first-launch experience: signed-out users now see the sign-in window
on app start (previously only a tray icon was visible), and the rail's
"+ add repo" bubble reacts live to repo add/remove and to the tray's
checkbox selection — so it disappears once you add a repo and reappears if
you uncheck all of them.
