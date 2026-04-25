# references/

Third-party library notes in [llms.txt format](https://llmstxt.org). One `.txt` file per pinned library, capturing the version, load-bearing gotchas, and where the library is used in this codebase.

For the authoring rules, see [`../CONVENTIONS.md`](../CONVENTIONS.md).

## Why `.txt`, not `.md`

These files follow the [llms.txt convention](https://llmstxt.org) for plain-text, LLM-readable third-party context. The format is intentional — it sits adjacent to but separate from the markdown doc system, so an agent searching for repo conventions does not collide with upstream library notes.

## What's here

| File | Library | Used in |
| --- | --- | --- |
| [`anthropic-sdk-llms.txt`](anthropic-sdk-llms.txt) | Anthropic SDK | `apps/server/src/analyzers/llm.ts` |
| [`drizzle-llms.txt`](drizzle-llms.txt) | Drizzle ORM | `apps/server/src/db/` |
| [`electron-llms.txt`](electron-llms.txt) | Electron | `apps/desktop/` |
| [`elysia-llms.txt`](elysia-llms.txt) | Elysia | `apps/server/` |
| [`ioredis-llms.txt`](ioredis-llms.txt) | ioredis | `apps/server/src/ws/redis-bridge.ts` |

## Naming

`<library>-llms.txt` — kebab-case library name + `-llms.txt` suffix. Examples: `elysia-llms.txt`, `anthropic-sdk-llms.txt`. The suffix is load-bearing; tools that consume the llms.txt format look for it.

## File shape

Plain text, no frontmatter. Recommended sections:

```
<Library name> — our version: <semver>

A short framing of what the library does.

Load-bearing gotchas
--------------------

- Bullet points of upstream behavior we have to honor.
- Reference our own design-docs / core-beliefs where applicable.

Where we use it
---------------

- apps/server/src/<file>     — <one-line description>
- apps/desktop/src/<file>    — <one-line description>

Upstream docs: <link>
```

See [`elysia-llms.txt`](elysia-llms.txt) for the canonical example.

## Adding a new library reference

1. Pin the library version (commit a lockfile change).
2. Create `<library>-llms.txt` here.
3. Fill out the four sections above.
4. Add a row to the table in this README.
5. Reference the file from `ARCHITECTURE.md` if the library is core to a domain.

## When to update an existing reference

- A new upstream gotcha is encountered (capture it before it becomes tribal knowledge).
- The pinned version changes in a way that affects load-bearing behavior.
- A new internal consumer is added (update "Where we use it").
