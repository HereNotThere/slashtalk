// Idempotent upsert for managed-agent session pointers. Clients PUT the
// current known state of a session and the endpoint merges it into
// agent_sessions without letting late partial updates wipe richer state.

import { Elysia, t } from "elysia";
import { and, desc, eq, sql } from "drizzle-orm";
import type { ManagedAgentSessionRow } from "@slashtalk/shared";
import type { Database } from "../db";
import { apiKeyAuth } from "../auth/middleware";
import { agentSessions } from "../db/schema";

const LIST_LIMIT = 50;

type AgentSessionSelect = typeof agentSessions.$inferSelect;

export const managedAgentSessionRoutes = (db: Database) =>
  new Elysia({ prefix: "/v1", name: "managed-agent-sessions" })
    .use(apiKeyAuth)
    .put(
      "/managed-agent-sessions",
      async ({ body, user }) => {
        const lastActivity = body.lastActivity
          ? new Date(body.lastActivity)
          : new Date();

        await db
          .insert(agentSessions)
          .values({
            userLogin: user.githubLogin,
            agentId: body.agentId,
            sessionId: body.sessionId,
            mode: body.mode,
            visibility: body.visibility,
            name: body.name ?? null,
            startedAt: new Date(body.startedAt),
            endedAt: body.endedAt ? new Date(body.endedAt) : null,
            lastActivity,
            summary: body.summary ?? null,
            summaryModel: body.summaryModel ?? null,
            summaryTs: body.summaryTs ? new Date(body.summaryTs) : null,
          })
          .onConflictDoUpdate({
            target: [agentSessions.userLogin, agentSessions.sessionId],
            set: {
              agentId: sql`excluded.agent_id`,
              mode: sql`excluded.mode`,
              visibility: sql`excluded.visibility`,
              name: sql`coalesce(excluded.name, ${agentSessions.name})`,
              startedAt: sql`excluded.started_at`,
              endedAt: sql`coalesce(excluded.ended_at, ${agentSessions.endedAt})`,
              lastActivity: sql`greatest(excluded.last_activity, ${agentSessions.lastActivity})`,
              summary: sql`coalesce(excluded.summary, ${agentSessions.summary})`,
              summaryModel: sql`coalesce(excluded.summary_model, ${agentSessions.summaryModel})`,
              summaryTs: sql`coalesce(excluded.summary_ts, ${agentSessions.summaryTs})`,
            },
          });

        console.info(
          JSON.stringify({
            level: "info",
            msg: "agent_session_upsert",
            ts: new Date().toISOString(),
            userId: user.githubLogin,
            sessionId: body.sessionId,
            agentId: body.agentId,
            mode: body.mode,
            hasSummary: Boolean(body.summary),
            ended: Boolean(body.endedAt),
          }),
        );

        return { ok: true as const };
      },
      {
        body: t.Object({
          agentId: t.String({ minLength: 1 }),
          sessionId: t.String({ minLength: 1 }),
          mode: t.Union([t.Literal("cloud"), t.Literal("local")]),
          visibility: t.Union([t.Literal("private"), t.Literal("team")]),
          name: t.Optional(t.String()),
          startedAt: t.String({ format: "date-time" }),
          endedAt: t.Optional(t.String({ format: "date-time" })),
          lastActivity: t.Optional(t.String({ format: "date-time" })),
          summary: t.Optional(t.String()),
          summaryModel: t.Optional(t.String()),
          summaryTs: t.Optional(t.String({ format: "date-time" })),
        }),
      },
    )
    .get("/managed-agent-sessions", async ({ request, user, set }) => {
      const url = new URL(request.url);
      const target = url.searchParams.get("userLogin") ?? user.githubLogin;
      const agentId = url.searchParams.get("agentId");
      if (target !== user.githubLogin) {
        set.status = 403;
        return { error: "forbidden" };
      }

      const conditions = [
        eq(agentSessions.userLogin, target),
        eq(agentSessions.visibility, "team"),
      ];
      if (agentId) conditions.push(eq(agentSessions.agentId, agentId));

      const rows = await db
        .select()
        .from(agentSessions)
        .where(and(...conditions))
        .orderBy(desc(agentSessions.startedAt))
        .limit(LIST_LIMIT);

      return { sessions: rows.map(toApiRow) };
    });

function toApiRow(row: AgentSessionSelect): ManagedAgentSessionRow {
  return {
    userLogin: row.userLogin,
    agentId: row.agentId,
    sessionId: row.sessionId,
    mode: row.mode as ManagedAgentSessionRow["mode"],
    visibility: row.visibility as ManagedAgentSessionRow["visibility"],
    name: row.name,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    lastActivity: row.lastActivity.toISOString(),
    summary: row.summary,
    summaryModel: row.summaryModel,
    summaryTs: row.summaryTs?.toISOString() ?? null,
  };
}
