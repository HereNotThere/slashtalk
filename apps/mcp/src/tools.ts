import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Root } from "./presence.ts";

export interface ToolContext {
  onWorkspace: (sessionId: string, roots: Root[]) => void;
}

// `share_workspace` — called by the MCP client at session start (or any time)
// to report its working directory, so teammates can see "who's working on
// what" in the info panel.
//
// This exists because `roots/list` (the spec-native way for a server to ask a
// client for its roots) is advertised by Claude Code's capabilities but never
// responded to in practice (times out 100% of the time in our tests).
//
// Registering the tool also flips `tools.listChanged: true` in our
// capabilities, which is what coaxes MCP clients to keep a long-lived GET
// SSE stream open — and that long-lived stream is how we get instant
// disconnect detection via its abort signal.
export function registerDefaultTools(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "share_workspace",
    {
      title: "Share workspace",
      description:
        "Share your current working directory with teammates on the Chatheads " +
        "presence network. Call this at the start of each session so " +
        "teammates can see what project you're in. Pass `path` = the " +
        "absolute path of the directory you're working in.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute filesystem path of your current working directory. " +
              "Example: /Users/giuseppe/dev/slashtalk",
          ),
        name: z
          .string()
          .optional()
          .describe("Optional friendly name (e.g. repo slug or project name)."),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, name }, extra) => {
      const sid = extra.sessionId;
      if (!sid) {
        return {
          isError: true,
          content: [
            { type: "text", text: "No session context available." },
          ],
        };
      }
      const uri = path.startsWith("file://") ? path : `file://${path}`;
      ctx.onWorkspace(sid, [{ uri, name }]);
      return {
        content: [
          {
            type: "text",
            text: `Shared workspace "${name ?? path}" with teammates.`,
          },
        ],
      };
    },
  );
}
