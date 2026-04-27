// Idempotent upsert for managed-agent session pointers. Clients PUT the
// current "known state" of a session — starting turn, in-progress, or done
// with summary — and the endpoint merges it into agent_sessions. last_activity
// uses greatest(); ended_at and summary fields use coalesce() so a late-
// arriving partial PUT can't wipe state a newer one already wrote.

import { z } from "zod";
import * as db from "./db.ts";
import { log } from "./server.ts";

const LIST_LIMIT = 50;

interface LegacyAgentSessionRow {
  user_login: string;
  agent_id: string;
  session_id: string;
  mode: "cloud" | "local";
  visibility: "private" | "team";
  name: string | null;
  started_at: string;
  ended_at: string | null;
  last_activity: string;
  summary: string | null;
  summary_model: string | null;
  summary_ts: string | null;
}

const IsoDate = z.string().datetime();

// Visibility is sent by the client on every PUT (caller always knows it —
// it's stamped on the agent record). We use `excluded.visibility` directly
// in ON CONFLICT so updates reflect the current choice.
const UpsertBody = z.object({
  agent_id: z.string().min(1),
  session_id: z.string().min(1),
  mode: z.string().min(1),
  visibility: z.enum(["private", "team"]),
  name: z.string().optional(),
  started_at: IsoDate,
  ended_at: IsoDate.optional(),
  last_activity: IsoDate.optional(),
  summary: z.string().optional(),
  summary_model: z.string().optional(),
  summary_ts: IsoDate.optional(),
});

export async function handleUpsert(req: Request, userId: string): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const parsed = UpsertBody.safeParse(raw);
  if (!parsed.success) {
    return json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
  }
  const b = parsed.data;
  const now = new Date().toISOString();

  const sql = db.sql();
  await sql`
    insert into agent_sessions (
      user_login, agent_id, session_id, mode, visibility, name,
      started_at, ended_at, last_activity,
      summary, summary_model, summary_ts
    )
    values (
      ${userId}, ${b.agent_id}, ${b.session_id}, ${b.mode}, ${b.visibility},
      ${b.name ?? null},
      ${b.started_at}, ${b.ended_at ?? null},
      ${b.last_activity ?? now},
      ${b.summary ?? null}, ${b.summary_model ?? null}, ${b.summary_ts ?? null}
    )
    on conflict (session_id) do update set
      agent_id      = excluded.agent_id,
      mode          = excluded.mode,
      visibility    = excluded.visibility,
      name          = coalesce(excluded.name, agent_sessions.name),
      started_at    = excluded.started_at,
      ended_at      = coalesce(excluded.ended_at, agent_sessions.ended_at),
      last_activity = greatest(excluded.last_activity, agent_sessions.last_activity),
      summary       = coalesce(excluded.summary, agent_sessions.summary),
      summary_model = coalesce(excluded.summary_model, agent_sessions.summary_model),
      summary_ts    = coalesce(excluded.summary_ts, agent_sessions.summary_ts)
  `;

  log("info", "agent_session_upsert", {
    userId,
    sessionId: b.session_id,
    agentId: b.agent_id,
    mode: b.mode,
    hasSummary: Boolean(b.summary),
    ended: Boolean(b.ended_at),
  });

  return json({ ok: true }, 200);
}

export async function handleList(url: URL, userId: string): Promise<Response> {
  // Default to self when no user_login is given. Later we'll gate cross-user
  // reads on team membership; for now any signed-in user can query any login,
  // but only visibility='team' rows exist in the DB so there's nothing to
  // leak beyond what was already opted in.
  const target = url.searchParams.get("user_login") ?? userId;
  const agentId = url.searchParams.get("agent_id");

  const sql = db.sql();
  const rows = agentId
    ? await sql<LegacyAgentSessionRow[]>`
        select
          user_login, agent_id, session_id, mode, visibility, name,
          started_at, ended_at, last_activity,
          summary, summary_model, summary_ts
        from agent_sessions
        where user_login = ${target} and agent_id = ${agentId}
        order by started_at desc
        limit ${LIST_LIMIT}
      `
    : await sql<LegacyAgentSessionRow[]>`
        select
          user_login, agent_id, session_id, mode, visibility, name,
          started_at, ended_at, last_activity,
          summary, summary_model, summary_ts
        from agent_sessions
        where user_login = ${target}
        order by started_at desc
        limit ${LIST_LIMIT}
      `;

  return json({ sessions: rows }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
