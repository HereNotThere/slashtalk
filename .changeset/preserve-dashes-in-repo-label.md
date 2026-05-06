---
"@slashtalk/electron": patch
---

Fix the repo label on info-dashboard "Now" cards. Previously the fallback split a dash-slugified project path on `/` and `-`, so a repo named `test-repo` rendered as `repo`. Two changes: peer sessions (with a matched `repo_full_name`) now render that name; while the match is still loading they render nothing instead of flashing a misleading cwd segment like "desktop". Own sessions fall back to the cwd basename, which preserves dashes inside repo names.
