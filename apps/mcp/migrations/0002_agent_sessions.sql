-- One row per managed-agent session (Anthropic conversation_id). Stores a
-- pointer + a client-generated summary, never raw events. Raw transcripts
-- live with Anthropic (cloud) or slashtalk (local / claude-code) — see
-- agent-ingest-plan.md.

create table if not exists agent_sessions (
  id            bigserial primary key,
  user_login    text not null,
  agent_id      text not null,
  session_id    text not null,
  mode          text not null,                       -- 'cloud' for v1
  visibility    text not null default 'private',     -- 'private' | 'team'
  name          text,
  started_at    timestamptz not null,
  ended_at      timestamptz,
  last_activity timestamptz not null default now(),
  summary       text,
  summary_model text,
  summary_ts    timestamptz
);

create unique index if not exists agent_sessions_session_id_key
  on agent_sessions (session_id);
create index if not exists agent_sessions_user_started_idx
  on agent_sessions (user_login, started_at desc);
create index if not exists agent_sessions_agent_started_idx
  on agent_sessions (agent_id, started_at desc);
