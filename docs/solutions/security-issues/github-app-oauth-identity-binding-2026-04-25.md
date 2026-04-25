---
title: GitHub App OAuth grants must be bound to the Slashtalk user
date: 2026-04-25
category: security-issues
module: GitHub App OAuth and private repo claims
problem_type: security_issue
component: authentication
symptoms:
  - Desktop opened a plain GitHub App connect URL that relied on the browser's Slashtalk session
  - GitHub App callback stored returned app user tokens without checking the authorizing GitHub account
  - GitHub App status reported connected when encrypted tokens existed but were expired or unusable
root_cause: missing_validation
resolution_type: code_fix
severity: high
tags: [github-app, oauth, desktop-auth, repo-claims, token-refresh]
---

# GitHub App OAuth grants must be bound to the Slashtalk user

## Problem

Private repo verification needed a narrow GitHub App user authorization, but the first implementation let the browser session decide which Slashtalk user received the GitHub App token. That made desktop setup fragile and created a security boundary problem: a GitHub App grant could be stored for a Slashtalk user without proving the GitHub account that granted it was the same account.

## Symptoms

- Desktop called `/api/me/github-app/status`, then opened the returned `/auth/github-app` URL in the system browser.
- `/auth/github-app` authenticated with the browser's `session` cookie, while desktop sign-in stores JWT/device credentials locally.
- `/auth/github-app/callback` exchanged the GitHub App OAuth code and stored the returned app user token on the current Slashtalk user without calling GitHub `/user`.
- The desktop could poll forever if the browser was signed into a different Slashtalk account than the desktop app.
- The status endpoint returned `connected: true` for any non-null `github_app_user_token`, even when the token and refresh token were expired or corrupt.

## What Didn't Work

- Relying on browser cookies for a desktop-initiated setup flow. Desktop auth and browser auth are separate surfaces, so browser cookies are not a reliable identity binding for the desktop user.
- Treating successful GitHub App OAuth token exchange as proof of identity. The token proves someone authorized the GitHub App, not that the authorizing GitHub account matches the Slashtalk account receiving the token.
- Checking token presence for connection status. Presence is not usability; expired, undecryptable, or unrefreshable tokens must be treated as disconnected.

## Solution

Bind the GitHub App flow to the authenticated desktop user before opening the browser, then verify the GitHub identity returned by the app token before storing it.

The server now returns user-bound connect URLs from `/api/me/github-app/status`:

```ts
export function githubAppConnectUrlForUser(
  userId: number,
  options: { install?: boolean } = {},
): string {
  const url = new URL("/auth/github-app", config.baseUrl);
  url.searchParams.set("intent", signGithubAppConnectIntent(userId));
  if (options.install) url.searchParams.set("install", "1");
  return url.toString();
}
```

`/auth/github-app` validates that signed intent and writes it to an httpOnly callback cookie. The callback uses that intent to select the Slashtalk user instead of trusting the browser session:

```ts
const intent = verifyGithubAppConnectIntent(
  stringCookieValue(cookie[INTENT_COOKIE]?.value),
);
const user = intent
  ? await findUserById(db, intent.userId)
  : await sessionUser(db, jwt, stringCookieValue(cookie.session?.value));
```

Before storing tokens, the callback now verifies the GitHub account behind the returned app token:

```ts
const identity = await fetchGitHubUserIdentity(tokenData.access_token);
if (!identity || identity.id !== user.githubId) {
  set.status = identity ? 403 : 502;
  return {
    error: identity
      ? "GitHub App account mismatch"
      : "GitHub App identity check failed",
  };
}

await storeGitHubAppTokens(db, user.id, tokenData);
```

The status endpoint also uses token usability instead of token presence:

```ts
export async function githubAppConnectionStatus(
  db: Database,
  userId: number,
): Promise<{ configured: boolean; connected: boolean }> {
  const configured = isGithubAppConfigured();
  if (!configured) return { configured, connected: false };
  const token = await fetchUserGithubAppToken(db, userId);
  return { configured, connected: token.ok };
}
```

The repo-claim API kept the stable `no_access` error contract and added opt-in fields for the GitHub App setup path:

```ts
return {
  error: "no_access",
  message: "Private repo access needs the Slashtalk GitHub App...",
  requiresGithubApp: true,
  connectUrl: githubAppConnectUrlForUser(user.id),
};
```

## Why This Works

The signed intent separates "who started this desktop flow" from "which browser cookies happen to exist." It is short-lived, HMAC-signed, and scoped to the GitHub App connection purpose, so the callback can recover the desktop-authenticated Slashtalk user even when the browser has no Slashtalk session.

The GitHub `/user` check closes the privilege boundary: app user tokens are only stored when the app-authorizing GitHub account has the same `githubId` as the Slashtalk user. That prevents one account's private repo visibility from being attached to another account.

Connection status now tracks actual token usability. Expired tokens can be refreshed; expired refresh tokens or corrupt ciphertext make the user disconnected and prompt a new setup flow.

## Prevention

- Desktop-initiated browser OAuth flows should carry a server-signed, purpose-scoped intent or nonce tied to the authenticated desktop user.
- OAuth callbacks that store provider-specific user grants should verify the provider identity before persisting tokens.
- Status endpoints should report credential usability, not merely whether credential columns are non-null.
- Preserve established API error enums when adding guided remediation fields; add fields like `requiresGithubApp` and `connectUrl` instead of breaking existing clients.
- Keep authenticated middleware projections narrow enough that unrelated routes do not depend on newly added migration columns.

Regression tests added:

- GitHub App callback rejects mismatched GitHub accounts.
- Desktop-bound connect intents work without a browser Slashtalk session.
- `install=1` survives the Slashtalk sign-in redirect.
- Expired GitHub App tokens refresh before private repo verification.
- Expired app and refresh tokens report disconnected.

## Related Issues

- Related code: `apps/server/src/auth/github-app.ts`
- Related code: `apps/server/src/user/routes.ts`
- Related code: `apps/desktop/src/main/backend.ts`
- Related docs: `docs/SECURITY.md`
- Related docs: `docs/design-docs/core-beliefs.md`
