import { Elysia, t } from "elysia";
import { eq } from "drizzle-orm";
import {
  SOURCES,
  type EventSource,
  type IngestResponse,
  type SyncStateEntry,
} from "@slashtalk/shared";
import type { Database } from "../db";
import { sessions, events, heartbeats } from "../db/schema";
import { apiKeyAuth } from "../auth/middleware";
import type { RedisBridge } from "../ws/redis-bridge";
import { classifyEvent } from "./classifier";

interface ParsedLine {
  lineSeq: number;
  event: unknown;
}

/**
 * Parse an NDJSON chunk into numbered lines starting at `fromLineSeq`. Every
 * `\n`-delimited line consumes one seq; blank and malformed lines are dropped
 * but still consume their seq so client and server stay aligned on retries.
 */
function parseChunk(
  text: string,
  fromLineSeq: number
): { parsed: ParsedLine[]; nextLineSeq: number } {
  if (text.length === 0) return { parsed: [], nextLineSeq: fromLineSeq };

  const rawLines = text.split("\n");
  if (rawLines[rawLines.length - 1] === "") rawLines.pop();

  const parsed: ParsedLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.trim().length === 0) continue;
    try {
      parsed.push({ lineSeq: fromLineSeq + i, event: JSON.parse(line) });
    } catch {
      // intentional: don't fail the batch on a mid-flush partial line
    }
  }
  return { parsed, nextLineSeq: fromLineSeq + rawLines.length };
}

export const ingestRoutes = (db: Database, redis: RedisBridge) =>
  new Elysia({ prefix: "/v1", name: "ingest" })
    .use(apiKeyAuth)
    .onParse({ as: "local" }, async ({ request, contentType }) => {
      if (
        contentType === "application/x-ndjson" ||
        contentType === "text/plain"
      ) {
        return await request.text();
      }
    })

    // POST /v1/ingest — upload NDJSON event chunk
    .post(
      "/ingest",
      async ({ body, query, user, device }): Promise<IngestResponse> => {
        const source: EventSource = query.source ?? "claude";
        // onParse above returns the chunk as a string already.
        const text = body as string;
        const fromLineSeq = Number(query.fromLineSeq);
        const { parsed, nextLineSeq } = parseChunk(text, fromLineSeq);

        if (nextLineSeq === fromLineSeq) {
          return { acceptedEvents: 0, duplicateEvents: 0, serverLineSeq: fromLineSeq };
        }

        let acceptedEvents = 0;
        let duplicateEvents = 0;

        if (parsed.length > 0) {
          const rows = parsed.map(({ lineSeq, event }) => {
            const n = classifyEvent(source, event);
            return {
              sessionId: query.session,
              lineSeq,
              userId: user.id,
              project: query.project,
              source,
              ts: n.ts,
              rawType: n.rawType,
              kind: n.kind,
              turnId: n.turnId,
              callId: n.callId,
              eventId: n.eventId,
              parentId: n.parentId,
              payload: event,
            };
          });

          const inserted = await db
            .insert(events)
            .values(rows)
            .onConflictDoNothing({
              target: [events.sessionId, events.lineSeq],
            })
            .returning({ lineSeq: events.lineSeq });
          acceptedEvents = inserted.length;
          duplicateEvents = rows.length - acceptedEvents;
        }

        // source is immutable after first insert — only update mutable fields.
        const [sessionRow] = await db
          .insert(sessions)
          .values({
            sessionId: query.session,
            userId: user.id,
            deviceId: device?.id ?? null,
            source,
            project: query.project,
            serverLineSeq: nextLineSeq,
            prefixHash: query.prefixHash ?? null,
          })
          .onConflictDoUpdate({
            target: sessions.sessionId,
            set: {
              serverLineSeq: nextLineSeq,
              prefixHash: query.prefixHash ?? undefined,
            },
          })
          .returning({ repoId: sessions.repoId });

        if (acceptedEvents > 0 && sessionRow?.repoId) {
          await redis.publish(`repo:${sessionRow.repoId}`, {
            type: "session_updated",
            session_id: query.session,
            user_id: user.id,
            github_login: user.githubLogin,
            repo_id: sessionRow.repoId,
          });
        }

        return {
          acceptedEvents,
          duplicateEvents,
          serverLineSeq: nextLineSeq,
        };
      },
      {
        query: t.Object({
          project: t.String(),
          session: t.String(),
          fromLineSeq: t.String(),
          prefixHash: t.Optional(t.String()),
          source: t.Optional(t.Union(SOURCES.map((s) => t.Literal(s)))),
        }),
      }
    )

    // GET /v1/sync-state — get server-side sync state for resume
    .get(
      "/sync-state",
      async ({ user }): Promise<Record<string, SyncStateEntry>> => {
        const rows = await db
          .select({
            sessionId: sessions.sessionId,
            serverLineSeq: sessions.serverLineSeq,
            prefixHash: sessions.prefixHash,
          })
          .from(sessions)
          .where(eq(sessions.userId, user.id));

        const state: Record<string, SyncStateEntry> = {};
        for (const row of rows) {
          state[row.sessionId] = {
            serverLineSeq: row.serverLineSeq ?? 0,
            prefixHash: row.prefixHash,
          };
        }
        return state;
      }
    )

    // POST /v1/heartbeat — session heartbeat
    .post(
      "/heartbeat",
      async ({ body, user, device }) => {
        await db
          .insert(heartbeats)
          .values({
            sessionId: body.sessionId,
            userId: user.id,
            deviceId: device?.id ?? null,
            pid: body.pid ?? null,
            kind: body.kind ?? null,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: heartbeats.sessionId,
            set: {
              pid: body.pid ?? null,
              kind: body.kind ?? null,
              updatedAt: new Date(),
            },
          });

        return { ok: true };
      },
      {
        body: t.Object({
          sessionId: t.String(),
          pid: t.Optional(t.Number()),
          kind: t.Optional(t.String()),
          cwd: t.Optional(t.String()),
          version: t.Optional(t.String()),
          startedAt: t.Optional(t.String()),
        }),
      }
    );
