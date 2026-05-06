---
"@slashtalk/electron": patch
---

The fallback repo label in the info dashboard no longer chops dashes out of repo names that lack an `org/` prefix. Previously the slugified project path was split on both `/` and `-`, so `test-repo` rendered as `repo`. The fallback now uses the session's `cwd` basename, which preserves real path boundaries.
