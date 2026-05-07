---
"@slashtalk/electron": patch
---

The PR list on your own user-card now respects the `user_repos` claim gate, matching the standup blurb rendered next to it. Previously the list came straight from `gh api graphql` (no repo filter) and showed PRs from any repo you'd authored on GitHub in the past 24h, even ones you hadn't claimed in slashtalk — visibly inconsistent with the standup, which only ever mentioned claimed-repo PRs. The desktop now uses `gh` only as the writer (push fresh PRs into the server's `pull_requests` table, which already gates upserts on `user_repos`), and reads the displayed list from the same server endpoint the peer path uses (`/api/users/:login/prs`).
