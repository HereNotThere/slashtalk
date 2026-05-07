---
"@slashtalk/electron": patch
---

Hide the info window's "Now" section for sessions that don't yet have an analyzer-generated description.

Brand-new sessions (under three events) haven't run the summary analyzer, so their description is `null` and the "Now" card was rendering a placeholder ("Summarizing…") that read as broken. The picker now skips description-less sessions in both the live and recent-fallback branches; if nothing qualifies, the section hides and the past-day standup takes its place until Haiku catches up.
