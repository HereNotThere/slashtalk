# packages/shared (`@slashtalk/shared`)

Source-only TypeScript types + runtime const objects (`SessionState`, `SOURCES`, `EVENT_KINDS`, `PROVIDERS`) shared between `apps/server` and `apps/desktop`.

## No build, no `dist/`

[`package.json`](package.json) exposes `main` and `types` as `src/index.ts` directly. Consumers resolve it via workspace linking ([`apps/server`](../../apps/server) resolves via `main`; [`apps/desktop`](../../apps/desktop) additionally maps it via `paths` in `tsconfig.web.json`).

**Do not** add a build step, emit a `dist/`, or add runtime exports that depend on compilation. See [core-beliefs #5](../../docs/design-docs/core-beliefs.md#5-slashtalkshared-is-source-only).

## What belongs here

- Types used on both server and desktop (`SessionSnapshot`, `FeedSessionSnapshot`, `TokenUsage`, `PrActivityMessage`, `SessionUpdatedMessage`, `ChatMessage`, `ChatCitation`, `ManagedAgentSessionRow`, …).
- Const objects used as runtime enums (`SessionState`, `SOURCES`, `EVENT_KINDS`, `PROVIDERS`).
- API request/response interfaces (`IngestResponse`, `SyncStateEntry`, `ChatAskRequest`, `ChatAskResponse`, `ApiResponse<T>`, `ApiError`).

## What does not belong

- Code that needs compilation — decorators, `const enum`, non-pure functions touching IO.
- Types only one side uses — keep those in the owning workspace.
- Runtime behavior (network, file system, timers). This package is pure types + const data.

## Commands

```sh
bun run typecheck
```

## Adding a new type

1. Add the interface/type to [`src/index.ts`](src/index.ts).
2. For discriminated unions, keep `type` as the literal discriminant.
3. Consumers pick it up on next typecheck — no build needed.
4. **If it's a WS message payload** — update [`apps/desktop/src/main/ws.ts`](../../apps/desktop/src/main/ws.ts)'s `onmessage` switch in the same PR.
