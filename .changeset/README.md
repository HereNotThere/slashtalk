# Changesets

Slashtalk uses [changesets](https://github.com/changesets/changesets) to drive desktop-app releases. Server, web, website, and shared packages are listed in `ignore` in [`config.json`](config.json) — only `@slashtalk/electron` is versioned.

## Adding a changeset

When you make a change to `apps/desktop` that should produce a new release, add a changeset:

```bash
bun run changeset
```

Pick `@slashtalk/electron`, choose a bump type (`patch` / `minor` / `major`), and write a one-line summary. Commit the resulting `.changeset/*.md` file alongside your code change.

## How releases happen

1. PRs that include a changeset are merged to `main`.
2. The [`release` workflow](../.github/workflows/release.yml) opens (or updates) a "chore: version packages" PR that bumps `apps/desktop/package.json` and updates the changelog.
3. Merging the version PR triggers a tag + a macOS build job that signs, notarizes, and attaches the `.dmg` to a GitHub Release.
4. The website's Download button points to `releases/latest/download/Slashtalk-mac.dmg` — a stable URL that always serves the most recent release, so the site never needs to be rebuilt per release.

Releases never go to npm; the `publish` step only creates git tags via `changeset tag`.
