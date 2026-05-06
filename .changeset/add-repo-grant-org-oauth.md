---
"@slashtalk/electron": patch
---

When "Add local repo" fails because the repo's owning org hasn't authorized slashtalk's GitHub OAuth app, the error now shows a "Grant access on GitHub →" button that opens slashtalk's authorized-OAuth-apps page on github.com. From there a single click on "Grant" next to the org unblocks the claim. Previously the error explained the cause but left the user to find the page themselves. The server now also busts its 60-second org-membership cache after a `no_access` outcome and refetches once before giving up — without this, the user would keep seeing the same error for up to a minute after granting access on GitHub.
