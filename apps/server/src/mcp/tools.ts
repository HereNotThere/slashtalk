import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Database } from "../db";
import { getSessionImpl, getTeamActivityImpl } from "../chat/tools";

export interface McpToolContext {
  db: Database;
  userId: number;
}

const stateSchema = z.enum(["busy", "active", "idle", "recent", "ended"]);

export function registerTeamActivityTools(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    "get_team_activity",
    {
      title: "Get team activity",
      description:
        "Return a per-teammate roll-up of recent Claude Code / Codex sessions across repos the caller can see. Use this for two things. (1) Team-status questions: 'what did the team do today?', 'what did eric do today?', 'what is happening in owner/repo?'. (2) Proactive conflict detection: whenever the user is about to edit a file, call this with `repoFullName` and `filePath` set to surface live overlap with teammates currently editing the same file. In the conflict-detection case, mention overlap to the user when (a) a returned session is `busy` or `active` and belongs to someone else, OR (b) the response's `openPrs` array is non-empty — an open PR on that file from another teammate is a conflict signal even if no one is currently typing. Stay silent otherwise. State thresholds: `busy` = heartbeat fresh (<30s) and in a turn; `active` = heartbeat fresh and last event <30s; `idle` = heartbeat fresh and last event >30s; `recent` = no fresh heartbeat but last event <1h; `ended` = no fresh heartbeat and last event >1h. By default `ended` sessions are omitted from the teammates roll-up — pass `includeEnded: true` or `state: \"ended\"` to include them. Each session also carries `pr` (the matched PR by branch, when known). Prefer `since` over `sinceHours` for calendar-relative questions like 'today'.",
      inputSchema: {
        sinceHours: z
          .number()
          .int()
          .min(1)
          .max(168)
          .optional()
          .describe(
            "Lookback window in hours. Default is 48. Prefer since for calendar-relative questions like today.",
          ),
        since: z
          .string()
          .optional()
          .describe(
            "ISO8601 inclusive window start. Prefer this for calendar-relative questions like today.",
          ),
        state: stateSchema
          .optional()
          .describe(
            "Filter to one computed session state. Pass `ended` to opt into ended sessions (omitted by default).",
          ),
        includeEnded: z
          .boolean()
          .optional()
          .describe(
            "Include `ended` sessions in the roll-up without filtering to only ended. Default false.",
          ),
        login: z
          .string()
          .optional()
          .describe("GitHub login to scope the answer to one teammate. Do not include @."),
        repoFullName: z
          .string()
          .optional()
          .describe("owner/name repo to scope the answer. Must be visible to the caller."),
        filePath: z
          .string()
          .optional()
          .describe(
            "Conflict-detection filter. When set, returns only teammates with a recent session whose top edited files include this path; the caller is omitted. Response also gains a top-level `openPrs` array of any open PRs whose branch had a teammate session touching that file (included even if the matching session is `ended`). Absolute or repo-relative paths are accepted — matching is segment-aware suffix on both sides. Lockfiles and similar high-traffic paths (package.json, bun.lock, yarn.lock, …) always return no overlap; they are noise, not collaboration. Pair with `repoFullName` to keep the answer tight.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const result = await getTeamActivityImpl(ctx.db, ctx.userId, args);
      return jsonText(result);
    },
  );

  server.registerTool(
    "get_session",
    {
      title: "Get session detail",
      description:
        "Return full detail for one visible Claude Code / Codex session, including summaries, recent state, files, prompt, and repo metadata. Use this after get_team_activity when the user asks for more detail about a specific session.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Session UUID returned by get_team_activity."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sessionId }) => {
      const result = await getSessionImpl(ctx.db, ctx.userId, { sessionId });
      if (result.kind === "error") {
        return {
          isError: true,
          content: [{ type: "text" as const, text: result.message }],
        };
      }

      return jsonText(result.session);
    },
  );
}

function jsonText(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}
