# Installable web app

Slashtalk's desktop app currently does two jobs: it ingests local Claude/Codex
session data, and it renders the team presence feed. A browser app can only do
the second job. This doc defines the web app as an installable PWA that renders
the same server-backed presence, session, dashboard, chat, and notification
surfaces without pretending it can replace the desktop uploader.

## Decision

Add a new workspace named `apps/web`, package name `@slashtalk/web`, for the
authenticated product app. Keep `apps/website` as the public marketing site.
`apps/web` should be a Vite + React PWA because the desktop renderer is already
React, the shared UI/refactor path is straightforward, and the app is mostly
client-side authenticated state rather than content pages.

Serve the PWA on the same origin as the API under `/app/*` when possible. The
server already issues httpOnly `session` and `refresh` cookies for browser OAuth,
so same-origin hosting lets the web app call `/api/*` with
`credentials: "include"` and avoids exposing JWTs to JavaScript. If production
keeps the marketing site and API on different origins, prefer a dedicated app
origin such as `app.<production-domain>` with explicit CORS and cookie domain
settings; do not move browser auth to localStorage.

The web app is read/control plane only:

- It reads `/api/feed`, `/api/feed/users`, `/api/session/:id`,
  `/api/session/:id/events`, `/api/users/:login/{prs,standup,questions}`,
  `/api/chat/*`, `/api/presence/*`, and `/api/me/*`.
- It can claim/unclaim repos through `/api/me/repos` and use the existing
  `/api/me/orgs` and `/api/me/orgs/:org/repos` pickers.
- It cannot ingest local sessions, post heartbeats, register local repo paths,
  manage the local MCP proxy, run local delegated agents, or read Spotify
  locally. Those remain desktop-only.

## Product scope

MVP screens:

- **Team Now**: a dense web equivalent of the desktop rail plus info popover.
  Users see self, local agents only if server-backed, teammates, active/live
  state, recent session timestamp, PR activity, collisions, Spotify presence,
  and location/weather once available.
- **Session detail**: full `SessionSnapshot`, recent prompts/events, top files,
  queued commands, token usage, current tool, linked PR, rolling summary, and a
  paginated event view.
- **Ask**: web version of the response window using `/api/chat/ask` and
  `/api/chat/history`. If the server returns `delegation`, render it as
  "requires desktop" until there is a web-safe remote delegation story.
- **Repos**: claim/unclaim repos by org/repo; no local path management.
- **Notifications**: install/PWA state, browser permission state, subscription
  state, category toggles, and a test notification.

Installability requirements:

- `public/manifest.webmanifest` with stable `id`, `scope: "/app/"`,
  `start_url: "/app/"`, `display: "standalone"`, `theme_color`,
  `background_color`, and maskable icons.
- A service worker that precaches the shell and uses network-first data reads.
  Cache authenticated API responses only when they are safe to show to the same
  browser profile later; never cache raw event payloads longer than needed for
  back/forward resilience.
- Offline behavior is "shell plus last-known summaries", not a full offline
  client. Session events, chat, and repo management stay online-only.

## Push notifications

Use standards-based Web Push: Push API + Notifications API + Service Worker.
Current browser constraints matter:

- MDN marks Push API broadly available and notes that receiving push requires an
  active service worker and a `PushSubscription` containing an endpoint and
  encryption keys.
- WebKit supports Web Push for iOS/iPadOS Home Screen web apps starting in
  16.4, and the permission request must be triggered by direct user interaction.
- Apple's developer docs describe Web Push as cross-browser Push API,
  Notifications API, Badging API, and Service Worker standards, and call out
  Safari requirements and badge support.

Add a server domain `push` under `apps/server/src/push/`:

- `GET /api/push/vapid-public-key` returns the base64url VAPID public key.
- `POST /api/push/subscriptions` stores the caller's browser subscription.
- `DELETE /api/push/subscriptions` deletes the caller's current subscription by
  endpoint hash.
- `POST /api/push/test` sends a test notification to the caller's active
  subscriptions.
- `GET/PUT /api/push/preferences` stores notification categories, watched repos,
  and quiet-hours settings.

Add a `web_push_subscriptions` table:

- `id serial primary key`
- `user_id references users(id) on delete cascade`
- `endpoint_hash text unique not null`
- `subscription_ciphertext text not null`
- `user_agent text`
- `created_at`, `updated_at`, `last_success_at`, `last_failure_at`
- `failure_count integer default 0`
- `revoked_at timestamp`

The endpoint is a capability URL, so store the full subscription encrypted with
the existing server encryption key and keep only the hash plaintext for lookup.
On push responses that indicate an expired subscription, mark it revoked or
delete it. Do not log endpoints or decrypted subscription JSON.

Notification categories should start conservative:

- **Collision**: default on. Notify only users involved in the
  `collision_detected` payload, excluding the actor when appropriate.
- **PR activity**: default off or watched-repos only. Notify when a teammate
  opens or merges a PR on a repo the user watches.
- **Session live**: default off. Notify when a watched teammate/repo transitions
  into BUSY/ACTIVE.
- **Summary ready**: default off. Notify when a watched session gets a new
  summary/rolling-summary insight.

Push sending should be best-effort and soft-fail like Redis publish. Add a
`push/dispatcher.ts` with domain-specific functions called after the existing
publish points, rather than hiding push sends inside `RedisBridge`. The publish
paths already know the domain event and can cheaply query affected users and
preferences; `RedisBridge` should remain transport plumbing.

Push payloads carry minimal display data and a deep link, not full snapshots:

```json
{
  "kind": "collision",
  "title": "Possible file collision",
  "body": "@austin and @sam are editing src/auth.ts",
  "url": "/app/sessions/9f4b..."
}
```

The service worker opens/focuses the linked app URL on click. The app re-fetches
fresh data through normal `/api/*` auth.

## WebSocket auth

The current desktop WebSocket authenticates with `/ws?token=<jwt-or-api-key>`.
The browser app should not receive a readable JWT, so extend `/ws` to accept the
httpOnly `session` cookie during the upgrade. Keep the existing query-token path
for desktop/API-key clients.

The route still follows the existing auth model: `/ws` accepts JWT, else API
key; browser cookies are just another JWT presentation mechanism. Update
`ARCHITECTURE.md`, `AGENTS.md`, and `docs/SECURITY.md` when implementing this
so the map does not imply query tokens are the only browser-compatible path.

The web client should treat WS messages the same way as desktop: they invalidate
or decorate cached data, then the app fetches full snapshots under `/api/*`.
Unknown `type` values remain ignored.

## Code sharing refactors

Do these before or alongside `apps/web`, otherwise the web app will fork the
desktop renderer in hard-to-merge ways.

### 1. Shared API client

Create `packages/client` as a source-only TypeScript package. Move the generic
parts of `apps/desktop/src/main/backend.ts` into it:

- typed wrappers for `/api/feed*`, `/api/session*`, `/api/users/:login/*`,
  `/api/chat/*`, `/api/presence/*`, `/api/me/*`, and push endpoints;
- JSON fetch/error handling;
- single-flight refresh behavior;
- typed `HttpError`.

Keep credential strategy injected:

- desktop strategy reads/writes JWT + refresh token through `safeStorage` and
  sends `Cookie: session=<jwt>` manually from the main process;
- web strategy uses `credentials: "include"` and calls `/auth/refresh` without
  reading tokens;
- API-key-only desktop calls (`/v1/ingest`, `/v1/heartbeat`, `/v1/devices/*`,
  `/v1/presence/spotify`, `/v1/me/prs`) stay desktop-only adapters.

### 2. Shared UI package

Create `packages/ui` as source-only React/TSX. Move presentational pieces that
do not depend on Electron IPC:

- `Markdown`, `MarkdownLink`, `Button`, relative-time formatting, token/status
  formatters, provider/source icons;
- session cards and compact session rows;
- the pure sections of `HierarchyDashboard`;
- chat transcript/citation rendering from the response window;
- Tailwind theme tokens from `apps/desktop/src/renderer/shared/tailwind.css`.

Desktop windows keep their BrowserWindow-specific CSS and `window.chatheads`
bridge adapters. Web imports the same UI components with browser adapters.

### 3. Pure presence/session derivation

Extract pure derivation logic out of desktop main-process modules:

- `rail.ts` head derivation from self user + `FeedUser[]` + `FeedSessionSnapshot[]`;
- session status labels and "now session" selection from `HierarchyDashboard`;
- `peerPresenceDiff`;
- collision verification predicate for "does a live session touch this file".

These can live in `packages/client` if they are domain logic, or `packages/ui`
if they are tightly tied to rendering labels. Avoid putting React or fetch code
into `@slashtalk/shared`; that package should remain source-only protocol types
and runtime constants.

### 4. Web-safe app contracts

Add shared types to `@slashtalk/shared` only for wire contracts:

- `WebPushSubscriptionRequest`
- `WebPushPreferences`
- `WebNotificationKind`
- `PushTestResponse`
- optional browser-specific auth/profile response shapes if `/api/me` expands

Do not move Electron IPC types from `apps/desktop/src/shared/types.ts` into
`@slashtalk/shared`; those are not server contracts.

## Server changes

Implementation sequence:

1. Add `apps/web` workspace with PWA manifest, service worker, auth shell, and
   typed API client consumption. The first implementation ships a minimal Team
   Now shell; deeper session detail, repo management, and notification settings
   can build on the same route.
2. Add cookie-auth support to `/ws` and web tests for cookie-only upgrade.
3. Add push schema + migration + `push` route plugin + tests.
4. Add push dispatcher calls at collision, PR activity, and optional session
   state-change publish points.
5. Add static serving for `/app/*` from the server. If production later moves
   the app to a separate origin, document the cookie/CORS settings in this spec
   before doing so.
6. Update root maps and workspace AGENTS once the workspace exists.

Server tests should cover:

- unauthenticated push subscribe rejects;
- subscription upsert dedupes by endpoint hash;
- unsubscribe only deletes the caller's subscription;
- expired push endpoints are revoked on 404/410-style responses;
- `/ws` accepts a valid `session` cookie and rejects missing/invalid cookies;
- push dispatch never fails the source domain operation.

## Security and privacy

- No readable browser tokens. Keep JWT/refresh in httpOnly cookies.
- No device API keys in the browser.
- No Web Push subscription endpoints in logs.
- Push payloads must be summaries and IDs only. Full session content is fetched
  after the user opens the app.
- Push preferences are per user. Repo-scoped notifications must still use
  `user_repos` visibility as the authorization boundary.
- Service worker caches must be scoped under `/app/` and must not cache
  `/auth/*`, `/mcp`, `/v1/*`, or raw event pages indefinitely.

## Alternatives considered

- **Reuse `apps/website`** — rejected because the existing Astro app is the
  public site. Mixing marketing pages, OAuth app shell, service worker scope,
  and notification settings makes deploy and cache boundaries muddy.
- **Name it `apps/webapp`** — rejected because `webapp` describes the category,
  not the workspace. `apps/web` is shorter and conventional next to
  `apps/server`, `apps/desktop`, and `apps/website`.
- **Make the browser app a full desktop replacement** — rejected because browser
  APIs cannot watch local Claude/Codex files, own a local MCP proxy, or keep
  device API keys with the same trust model.
- **Put shared UI into `@slashtalk/shared`** — rejected because that package is
  a protocol/type package. Mixing React/Tailwind into it would make every server
  import pay for frontend concerns.
- **Send push from `RedisBridge`** — rejected because notification fan-out needs
  user preferences, repo visibility, subscription lifecycle handling, and
  category-specific copy. That belongs in a push domain, not the Redis transport.

## See also

- [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) — current server/desktop map.
- [`../SECURITY.md`](../SECURITY.md) — cookie auth, repo visibility, PII rules.
- [`core-beliefs.md`](core-beliefs.md) — route-prefix auth and shared package constraints.
- [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API) —
  Push API/service worker contract.
- [WebKit Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) —
  iOS/iPadOS Home Screen web app push behavior.
- [Apple Web Push documentation](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers) —
  Safari/Web Push requirements and badge support.
