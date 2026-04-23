-- Initial schema. Narrow and focused: persist identity, async messages, and
-- an append-only log of presence transitions. Live presence stays in-memory
-- (PresenceStore) — this table is for audit / "what happened while I was away".

create table if not exists users (
  github_login text primary key,
  github_id    bigint not null,
  name         text,
  avatar       text,
  tz           text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create table if not exists notes (
  id          uuid primary key default gen_random_uuid(),
  from_login  text not null,
  to_login    text not null,
  body        text not null,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists notes_to_unread_idx
  on notes (to_login, created_at desc)
  where read_at is null;

create table if not exists activity_log (
  id          bigserial primary key,
  user_login  text not null,
  session_id  text not null,
  event       text not null,   -- 'online' | 'offline' | 'workspace'
  payload     jsonb,
  ts          timestamptz not null default now()
);

create index if not exists activity_user_ts_idx
  on activity_log (user_login, ts desc);
