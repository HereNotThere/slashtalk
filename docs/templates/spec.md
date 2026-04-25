<!--
Template: product spec — public surface contract.
Place this file at: docs/product-specs/<name>.md (kebab-case).
A product spec describes a public surface (HTTP endpoint, ingest
protocol, WebSocket message type, MCP tool, CLI command). It is the
contract between server and client; downstream code is authoritative
for behavior, but the spec is authoritative for *intent*.
Replace every <placeholder>. Delete this comment block before committing.
-->

# <Surface name> spec

<One paragraph: what this surface does, who calls it, what guarantees it provides.>

## Scope

<What this surface does. What it does *not* do. Drawing the boundary explicitly is more useful than describing the inside in detail.>

## Authentication

<Which auth scheme applies. Reference [core-beliefs #2](../design-docs/core-beliefs.md#2-route-prefix-encodes-auth) for routes.>

- **Auth:** `<jwtAuth | apiKeyAuth | none>`
- **Required scopes / claims:** <if any>

## Endpoints / messages

<Repeat this block for each endpoint or message type.>

### `<METHOD> /path` — <short description>

**Request:**

```json
{
  "<field>": "<type and example>"
}
```

**Response (2xx):**

```json
{
  "<field>": "<type and example>"
}
```

**Errors:**

| Status | `error` code | When |
| --- | --- | --- |
| 400 | `<code>` | <condition> |
| 401 | `<code>` | <condition> |
| 403 | `<code>` | <condition> |

**Side effects:**

- <database writes, if any>
- <pub/sub publishes, if any>
- <other observable effects>

## Invariants

<What must always be true about this surface. Reference `core-beliefs.md` rules where applicable.>

- <Invariant 1>
- <Invariant 2>

## Versioning

<How is this surface versioned? URL prefix? Header? Backward-compat policy?>

## See also

- [`<related-spec>`](<path>) — <why related>
- [`<related-design-doc>`](../design-docs/<name>.md) — <why related>
