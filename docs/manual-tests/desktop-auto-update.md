# Desktop Auto-Update Manual Test

Use this after changing desktop packaging, signing, release upload, or updater IPC/UI.

## Prerequisites

- `HereNotThere/slashtalk` GitHub Releases are public.
- The release build is signed and notarized with the Developer ID Application certificate.
- The release assets include:
  - `Slashtalk-mac-universal.dmg`
  - `Slashtalk-mac-universal.zip`
  - `Slashtalk-mac-universal.dmg.blockmap`
  - `Slashtalk-mac-universal.zip.blockmap`
  - `latest-mac.yml`

## Happy Path

1. Install the signed Slashtalk desktop app at version `N`.
2. Publish version `N+1` through the release workflow.
3. Launch version `N`.
4. Open Settings or the tray popup and click **Check** in Updates.
5. Verify the UI moves through checking/downloading and then shows **Restart**.
6. Choose **Restart** when prompted.
7. After relaunch, verify Settings shows version `N+1`.

## Failure Checks

- In `bun run dev`, the Updates row should say updates are only available in packaged builds.
- If GitHub release assets are missing `latest-mac.yml`, the release workflow must fail before creating/updating the release.
- If the update check errors, the Updates row should show the error without crashing the app.
