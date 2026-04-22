# analyze-sessions

Tools for inspecting Claude Code session logs on disk — both a one-shot CLI
report and a live dashboard. Both read the JSONL files that Claude Code writes
to `~/.claude/projects/<slugified-cwd>/<sessionId>.jsonl` as a conversation
progresses, and the small pid-heartbeat files under `~/.claude/sessions/`.

No dependencies — stdlib Python 3 only.

## `analyze.py` — one-shot report

```
python3 analyze.py [PROJECT_DIR]
```

Walks every `*.jsonl` in one project directory (default is the hard-coded
`-Users-erikolsson-dev-hntlabs-chat` slug; override with an argument). For each
session it parses the stream of `user` / `assistant` / `attachment` events and
aggregates:

- message counts, tool calls, tool errors, sidechain (subagent) messages
- token usage split into input / cache-write-5m / cache-write-1h / cache-read /
  output, plus an estimated $ cost using hard-coded per-1M prices for the
  opus / sonnet / haiku families
- which models and Claude Code versions were used, which git branches the
  session touched, top files read/edited/written, top bash commands (by first
  token), which subagents were invoked

Prints a project-wide totals block, top-N breakdowns, a per-session table
(time, duration, events, prompts, tool calls, output tokens, cost, branch),
and a sample of the first lines of the first user prompts. Pure stdout — no
state written.

## `server.py` — live dashboard

```
python3 server.py               # http://127.0.0.1:8787
PORT=9000 HOST=0.0.0.0 python3 server.py
PROJECTS=-Users-foo-bar,-Users-foo-baz python3 server.py
```

A tiny `ThreadingHTTPServer` with a built-in HTML page (`INDEX_HTML`) and two
JSON endpoints:

- `GET /api/sessions` — snapshot of every tracked session
- `GET /api/session/<id>` — full detail for one session

### How it tracks state

A background thread runs `scan_once()` every `POLL_S` (2s). Each pass:

1. Reads `~/.claude/sessions/*.json` and keeps only entries whose `pid` is
   still alive (`os.kill(pid, 0)`) — this is the source of truth for "which
   sessions have a live CLI attached".
2. Globs `~/.claude/projects/*/*.jsonl`, filters to `TRACKED_PROJECTS` (a
   hard-coded allowlist, overridable with the `PROJECTS` env var), and for
   each matching file maintains a `SessionState` that **tails the file
   incrementally** — remembering the byte offset, re-seeking on each tick,
   and only parsing whole lines (partial last lines are left for the next
   tick).

Each `SessionState._ingest` event updates counters (messages, tool calls,
tokens, cost), records the latest model / branch / cwd / version, tracks
outstanding tool calls by `tool_use_id` (removed when a matching
`tool_result` arrives), captures a rolling `RECENT_EVENTS=20` tail, and
classifies session state.

### "Busy" is computed, not observed

The interesting subtlety: a thinking block can run for tens of seconds
without emitting any JSONL event, so you can't rely purely on "last event
timestamp" to know if Claude is working. The server tracks an `in_turn`
flag that flips **on** at every real user prompt or queued command, and
flips **off** only when it sees `stop_reason == "end_turn"` on an assistant
message. State buckets in `snapshot()`:

- `busy`   — pid alive and `in_turn` is True (covers silent thinking)
- `active` — pid alive, last event within `BUSY_WINDOW_S` (10s)
- `idle`   — pid alive, no recent event
- `recent` — pid gone but file mtime within `RUN_WINDOW_S` (1h)
- `ended`  — everything else

### Queued-command handling

`attachment` events of type `queued_command` are appended to `self.queued`
(minus `<task-notification…>` injections). At snapshot time the queue is
filtered by `last_boundary_ts` — the timestamp of the most recent "turn
boundary" (a real user message or an assistant `end_turn`). Only queued
items strictly newer than that boundary are still pending. This is
self-correcting: we never mutate state at the exact "drain" moment, and
even a missed event gets reconciled once the next boundary arrives.

### Frontend

`INDEX_HTML` is a single self-contained page. It polls `/api/sessions`
every 3s and patches the DOM **in place** — each session has a cached
row/detail node pair keyed by id, fields are only rewritten when they
actually change, and the recent-events feed is appended to rather than
re-rendered so its scroll position survives polls. Filter buttons
(`all` / `live` / `busy` / `active` / `recent`) show/hide rows without
destroying the nodes.

## Mockups

`mockup.html`, `mockup-brutalist.html`, `mockup-eurorack.html`,
`mockup-swiss.html` — static design explorations for alternative dashboard
UIs. Not wired into `server.py`; open them directly in a browser.

---

# Backend spec (for the LLM building the server)

You are building the server half of this system. Today `server.py` runs on
the user's laptop, reads JSONL files directly from `~/.claude/projects/`,
and serves a dashboard. We want to move that to a hosted backend: a thin
client on each laptop ships JSONL deltas up to you; the server stores them,
computes the same summary, and serves the same dashboard API.

Read the sections above first — the existing local `server.py` is the
reference implementation of the summary logic. Your job is to replicate
its output over the network with a multi-user-capable storage layer.

## Data volume and shape (orientation)

- Typical laptop: **~3,000 JSONL files, ~1.3 GB total**, across ~20
  project directories. Per-session files range from a few KB to tens of
  MB; median is ~500 KB.
- Files are **append-only** while a session is live, then quiescent.
  Claude Code never rewrites past lines.
- Each line is one JSON object representing one event; files live at
  `~/.claude/projects/<slugified-cwd>/<sessionId>.jsonl`. The slug is
  derived from the working directory (e.g. `/Users/foo/dev/x` →
  `-Users-foo-dev-x`). `<sessionId>` is a UUID. This slug is an opaque
  session key, not a reliable repo identifier.

## JSONL event schema (what to ingest)

Every line has at least `{type, timestamp, uuid, sessionId}`. Only the
fields you need for the summary are listed below — preserve the full
payload verbatim in storage so you can add derived metrics later without
re-ingesting.

Common top-level fields:

- `type`: one of `"user"`, `"assistant"`, `"attachment"`,
  `"file-history-snapshot"`, `"system"`, plus a long tail of others —
  don't hard-fail on unknown types; just store them.
- `uuid`: stable per-event UUID. **Use this as the idempotency key**
  for ingest dedup.
- `parentUuid`: nullable; forms the conversation DAG.
- `timestamp`: ISO-8601 string, UTC with `Z` suffix.
- `sessionId`: UUID matching the filename stem.
- `cwd`, `gitBranch`, `version`: environment metadata, present on most
  events. Take the latest non-null for the session.
- Repo matching should prefer `cwd`; `project` is only a slugified copy
  of that path and is insufficient on its own for worktrees or
  arbitrary clone directory names.
- `isSidechain`: true for subagent-internal events.
- `isMeta`: true for machinery events that should not count as user
  messages.

`type == "user"`:
- `message.content` is either a string or an array of content blocks.
- In array form, blocks have `type` in `{"text", "tool_result"}`.
- A `tool_result` has `tool_use_id` (matches an earlier `tool_use.id`)
  and optional `is_error: true`.
- Strings starting with `<local-command` or `<command` are CLI-internal
  — exclude from "real user prompt" tracking.

`type == "assistant"`:
- `message.model`: e.g. `claude-opus-4-7`, `claude-sonnet-4-6`.
- `message.stop_reason`: e.g. `"end_turn"`, `"tool_use"`. `end_turn` is
  the signal that the model finished its turn.
- `message.usage`: `{input_tokens, output_tokens, cache_read_input_tokens,
  cache_creation_input_tokens, cache_creation: {ephemeral_5m_input_tokens,
  ephemeral_1h_input_tokens}}`. Prefer the detailed `cache_creation`
  object; fall back to the flat `cache_creation_input_tokens` as
  5-minute-cache writes when the detailed object is absent.
- `message.content`: array of blocks with `type` in
  `{"text", "thinking", "tool_use"}`.
- `tool_use` blocks: `{id, name, input}`. Notable names: `Bash`, `Read`,
  `Edit`, `MultiEdit`, `Write`, `Grep`, `Glob`, `Agent`/`Task` (has
  `input.subagent_type`), `WebFetch`, `WebSearch`.

`type == "attachment"`:
- `attachment.type == "queued_command"` is the one that matters:
  `{prompt, commandMode}` — a user message typed while the model was
  still working. Skip prompts starting with `<task-notification`.

## Pricing table (for `$cost`)

Per **1M tokens** — `(input, cache_w_5m, cache_w_1h, cache_read, output)`:

```
opus:   15.00, 18.75, 30.00, 1.50, 75.00
sonnet:  3.00,  3.75,  6.00, 0.30, 15.00
haiku:   0.80,  1.00,  1.60, 0.08,  4.00
```

Family is matched by substring on `message.model` (`opus` / `haiku` else
`sonnet`). Sum of `tokens × price` ÷ 1e6 per event, added to session cost.

## Delta sync protocol (client ↔ server)

The client is a small watcher that the user runs on their laptop. It
polls (or fs-notifies) `~/.claude/projects/*/*.jsonl` and uploads new
bytes. **The server is append-only and dedups by event UUID.**

Client state lives in a sidecar JSON (e.g. `~/.claude/sync-state.json`):
```
{ "<sessionId>": { "offset": <bytes>, "size": <bytes>, "mtime": <float>, "prefixHash": "<hex>" } }
```
`prefixHash` is sha256 of the first 4 KiB of the file — used to detect
the (very rare) case where a file was replaced/truncated. If the prefix
hash changes, the client re-uploads from offset 0.

### Required endpoints

1. `POST /v1/ingest`
   - Query/headers: `user` (authenticated identity), `project` (slug),
     `session` (UUID), `fromOffset` (int, bytes in source file where this
     chunk starts), `prefixHash` (hex). No device header is part of the
     protocol — device identity is derived from the authenticated
     credential, not from a client-supplied header.
   - Body: `Content-Type: application/x-ndjson` — raw JSONL bytes.
   - Server behavior:
     - Split on `\n`; ignore blank lines; parse each as JSON.
     - For each event, upsert by `uuid` with `ON CONFLICT DO NOTHING`.
     - Update derived per-session aggregates (see next section) from
       newly-inserted events only — never replay on duplicates.
     - Return `{ "acceptedBytes": <int>, "acceptedEvents": <int>,
       "duplicateEvents": <int>, "serverOffset": <int> }`.
     - `serverOffset` = highest `fromOffset + len(body)` seen for this
       session. The client uses it to resume after crashes.
   - Partial-line safety: the client only sends up to the last complete
     `\n`, so the server never needs to buffer cross-request tails.

2. `GET /v1/sync-state?user=…` → `{ "<sessionId>": {"serverOffset":…, "prefixHash":…} }`
   - For a fresh client install or after disk loss, so the client can
     rebuild its sidecar from the server's view.

### Dashboard endpoints (match `server.py` exactly)

The existing frontend polls these; keep shapes identical so
`INDEX_HTML` and the `mockup-*.html` files can point at the hosted
backend without changes.

- `GET /api/sessions?project=&state=` — array of session snapshots.
- `GET /api/session/<id>` — one full snapshot.

Snapshot JSON shape (all fields, from `SessionState.snapshot`):
```
{
  "id":              "<sessionId>",
  "project":         "<slug>",
  "title":           "first real user prompt, ≤80 chars",
  "queued":          [{"prompt": "...", "ts": "...", "mode": "..."}],  // filtered, see below
  "state":           "busy" | "active" | "idle" | "recent" | "ended",
  "pid":             <int | null>,    // null when remote / unknown
  "kind":            "<cli kind string | null>",
  "model":           "claude-opus-4-7",
  "version":         "1.2.3",
  "branch":          "main",
  "cwd":             "/Users/…",
  "firstTs":         "2026-04-22T09:12:33.001Z",
  "lastTs":          "2026-04-22T10:44:01.782Z",
  "idleS":           <int | null>,    // seconds since last event
  "durationS":       <int | null>,
  "userMsgs":        <int>,
  "assistantMsgs":   <int>,
  "toolCalls":       <int>,
  "toolErrors":      <int>,
  "events":          <int>,
  "tokens":          {"in":…, "cw5":…, "cw1":…, "cr":…, "out":…},
  "cost":            <float>,        // USD, rounded to 4dp
  "cacheHitRate":    <float 0..1>,
  "burnPerMin":      <int | null>,   // output_tokens / duration_min
  "lastUserPrompt":  "<string, ≤800 chars>",
  "currentTool":     {"name":…, "desc":…, "started":<float>} | null,
  "topFilesRead":    [[path, count], ...],  // up to 5
  "topFilesEdited":  [[path, count], ...],
  "topFilesWritten": [[path, count], ...],
  "toolUseNames":    [[name, count], ...],  // up to 10
  "recent":          [{"ts":…, "type":…, "summary":…}, ...]  // last 20
}
```

List-endpoint ordering: group by state in `[busy, active, idle, recent,
ended]` order; within a group, newest `lastTs` first.

## Deriving "busy" (important, easy to get wrong)

Claude can sit thinking for tens of seconds with **no JSONL events
emitted**. You cannot use "time since last event" alone. Maintain
per-session:

- `in_turn: bool` — flip **true** on any real user message (non-meta,
  not a `<local-command…>`/`<command…>` string) or on any `attachment:
  queued_command`. Flip **false** only when you observe an assistant
  event with `message.stop_reason == "end_turn"`.
- `last_boundary_ts: ISO8601 string` — timestamp of the most recent
  turn boundary (= the events that flip `in_turn`).
- `outstanding_tools: {tool_use_id → {name, desc, started}}` — add on
  assistant `tool_use`, remove when a matching `user.tool_result` arrives
  referencing that `tool_use_id`. `currentTool` is an arbitrary element
  of this dict (e.g. most recent), purely a display hint.

In a hosted backend there is no `pid_alive` check — the client must tell
you whether the CLI is still attached. Add one more ingest endpoint:

3. `POST /v1/heartbeat` with `{user, sessionId, pid, kind, cwd, version,
   startedAt}` every ~5 s while the CLI is alive; absence for >30 s
   means the CLI is no longer live.

State classification at snapshot time:
- `busy`   — heartbeat fresh **and** `in_turn` is true.
- `active` — heartbeat fresh **and** last event within 10 s.
- `idle`   — heartbeat fresh, no recent event.
- `recent` — heartbeat stale, last event within 1 h.
- `ended`  — otherwise.

## Queued-command handling (also non-obvious)

Append every `attachment.queued_command` event to a per-session list,
skipping prompts that begin with `<task-notification`. At snapshot
time, **filter** to items whose `ts > last_boundary_ts`. This is
self-correcting: even if you miss the exact event that drains the queue,
the next boundary event makes the filter do the right thing without
needing to mutate state at the right moment.

## Storage (suggested)

Two tables are enough to implement everything above:

```sql
create table events (
  uuid            uuid primary key,         -- from the JSONL line
  user_id         text not null,
  project         text not null,            -- slug
  session_id      uuid not null,
  ts              timestamptz not null,
  type            text not null,
  parent_uuid     uuid,
  byte_offset     bigint,                   -- offset in the source file
  payload         jsonb not null,           -- the raw line
  ingested_at     timestamptz default now()
);
create index on events (session_id, ts);
create index on events (user_id, project, ts desc);

create table sessions (
  session_id      uuid primary key,
  user_id         text not null,
  project         text not null,
  -- derived, updated in the same transaction as event inserts
  title           text,
  first_ts        timestamptz,
  last_ts         timestamptz,
  user_msgs       int default 0,
  assistant_msgs  int default 0,
  tool_calls      int default 0,
  tool_errors     int default 0,
  events          int default 0,
  tokens_in       bigint default 0,
  tokens_cw5      bigint default 0,
  tokens_cw1      bigint default 0,
  tokens_cr       bigint default 0,
  tokens_out      bigint default 0,
  cost_usd        numeric(12,4) default 0,
  model           text,
  version         text,
  branch          text,
  cwd             text,
  in_turn         bool default false,
  last_boundary_ts timestamptz,
  outstanding_tools jsonb default '{}',
  last_user_prompt text,
  top_files_read   jsonb default '[]',
  top_files_edited jsonb default '[]',
  top_files_written jsonb default '[]',
  tool_use_names   jsonb default '{}',
  queued           jsonb default '[]',
  recent_events    jsonb default '[]',      -- ring buffer, cap 20
  server_offset    bigint default 0,
  prefix_hash      text
);

create table heartbeats (
  session_id  uuid primary key,
  user_id     text,
  pid         int,
  kind        text,
  updated_at  timestamptz
);
```

Do session-aggregate updates inside the same transaction as the event
insert, keyed off `ON CONFLICT (uuid) DO NOTHING` so replays are free.
Object storage (R2/S3) is a fine alternative for raw JSONL archival if
cost matters, but Postgres alone handles this scale comfortably — 1.3 GB
of JSONL per user compresses to ~150–250 MB of `jsonb` rows.

## Frontend reuse

The existing `INDEX_HTML` in `server.py` and the `mockup-*.html` files
expect `/api/sessions` and `/api/session/<id>`. If your endpoints match
the shapes above, you can serve the same HTML unchanged — just add a
project picker (since a hosted backend has many users/projects) and an
auth layer.

## What you do NOT need to implement

- File watching — that is the client's job.
- Partial-line reassembly — the client only sends whole lines.
- PID liveness probing — replaced by `POST /v1/heartbeat`.
- Backfill of history files older than sync-state bootstrap — the
  client will send everything from offset 0 on first run and your UUID
  dedup absorbs any overlap.
