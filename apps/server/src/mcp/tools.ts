import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Database } from "../db";
import { getSessionImpl, getTeamActivityImpl } from "../chat/tools";

export interface McpToolContext {
  db: Database;
  userId: number;
}

const stateSchema = z.enum(["busy", "active", "idle", "recent"]);

export function registerTeamActivityTools(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    "get_team_activity",
    {
      title: "Get team activity",
      description:
        "Return a per-teammate roll-up of recent Claude Code / Codex sessions across repos the caller can see. Use this for questions like 'what did the team do today?', 'what did eric do today?', or 'what is happening in owner/repo?'.",
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
        state: stateSchema.optional().describe("Filter to one computed session state."),
        login: z
          .string()
          .optional()
          .describe("GitHub login to scope the answer to one teammate. Do not include @."),
        repoFullName: z
          .string()
          .optional()
          .describe("owner/name repo to scope the answer. Must be visible to the caller."),
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
