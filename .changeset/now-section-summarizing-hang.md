---
"@slashtalk/electron": patch
---

Fix the "Now" section getting stuck on "Summarizing…" indefinitely. A transient analyzer error was clearing the previously-computed description from the snapshot even though the prior good output was preserved in the database. Surface the preserved output across errors, and hide the description line entirely when no summary exists rather than showing a misleading active-state placeholder.
