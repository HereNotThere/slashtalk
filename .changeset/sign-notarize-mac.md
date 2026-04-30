---
"@slashtalk/electron": patch
---

Sign and notarize macOS releases. The `build-mac` job now runs `dist:mac` (signed + notarized) instead of `dist:mac:unsigned`, using the Developer ID Application cert and App Store Connect API key from repo secrets. Users no longer need to right-click → Open or `xattr -cr` to launch the app.
