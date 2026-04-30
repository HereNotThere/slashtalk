# Releasing the desktop app

Desktop releases are driven by [changesets](https://github.com/changesets/changesets). Only `@slashtalk/electron` is versioned — server, web, landing, blog, and shared packages are listed in `ignore` in [`.changeset/config.json`](../.changeset/config.json).

## Author flow

1. Make a desktop change in a feature branch.
2. From the repo root, create a changeset:
   ```sh
   bun run changeset
   ```
   Pick `@slashtalk/electron`, choose a bump type (`patch` / `minor` / `major`), and write a one-line summary. Commit the generated `.changeset/*.md` alongside your code.
3. Open and merge the PR to `main`.

## What CI does

The [`release` workflow](../.github/workflows/release.yml) runs on every push to `main`:

1. **`release` job** (ubuntu) — runs `changesets/action`. If pending changesets exist, it opens (or updates) a `chore: version packages` PR that bumps `apps/desktop/package.json` and updates the changelog.
2. When that PR is merged, the same job runs `changeset tag` and pushes the new tag (`@slashtalk/electron@<version>`).
3. **`build-mac` job** (macos-latest) — gated on the publish output. Runs `bun run dist:mac` to produce a **signed + notarized** `.dmg` using the repo secrets (`MAC_CERT_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`). The signed flow uses hardened runtime + entitlements at [`apps/desktop/build/entitlements.mac.plist`](../apps/desktop/build/entitlements.mac.plist).
4. The signed DMG (universal binary), zip, blockmaps, and `latest-mac.yml` are uploaded to a fresh GitHub Release tagged `@slashtalk/electron@<version>`.
5. **Update Homebrew tap** step — rewrites `Casks/slashtalk.rb` in [`HereNotThere/homebrew-tap`](https://github.com/HereNotThere/homebrew-tap) with the new version + DMG SHA256, and pushes a `slashtalk <version>` commit.

## Stable download URLs

The website (or anywhere else) should link to one of these:

```
https://github.com/HereNotThere/slashtalk/releases/latest/download/Slashtalk-mac-universal.dmg
https://github.com/HereNotThere/slashtalk/releases/latest/download/Slashtalk-mac-universal.zip
```

GitHub redirects these to the most recent release's assets, so the URLs never have to change.

Or via Homebrew:

```sh
brew install --cask herenotthere/tap/slashtalk
```

## Required repo secrets

| Secret                 | What it is                                                              |
| ---------------------- | ----------------------------------------------------------------------- |
| `MAC_CERT_BASE64`      | `base64 -i DeveloperID.p12` of the Developer ID Application cert        |
| `MAC_CERT_PASSWORD`    | Password for the `.p12`                                                 |
| `APPLE_API_KEY_BASE64` | `base64 -i AuthKey_XXXX.p8` from App Store Connect                      |
| `APPLE_API_KEY_ID`     | Key ID shown next to the key in App Store Connect                       |
| `APPLE_API_ISSUER`     | Issuer ID at the top of App Store Connect → Users and Access → Keys     |
| `HOMEBREW_TAP_TOKEN`   | Fine-grained PAT with `Contents: Read and write` on `homebrew-tap` repo |

The cert is bound to your Apple Developer team; the API key drives notarization. To rotate either, regenerate, re-base64, and update the secret. The Homebrew tap token rotates per its own expiration policy.

## Manual / unsigned local build

For day-to-day local packaging without going through Apple, unset `CSC_LINK` and override the mac config:

```sh
cd apps/desktop
bun run build
bunx electron-builder --mac --config.mac.identity=null --config.mac.notarize=false
```

This produces an unsigned `.dmg` in `apps/desktop/dist/` that macOS will Gatekeeper-block on first launch (right-click → Open to bypass) — fine for testing, not for distribution.

For the full electron-builder + signing/notarization detail (env vars, verification commands), see [`apps/desktop/AGENTS.md`](../apps/desktop/AGENTS.md#packaging-electron-builder).
