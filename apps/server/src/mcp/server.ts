import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ServerOptions = {
  name: string;
  version: string;
};

export function createMcpServer(options: ServerOptions): McpServer {
  return new McpServer({ name: options.name, version: options.version });
}

type LogLevel = "debug" | "info" | "warn" | "error";

export function log(
  level: LogLevel,
  msg: string,
  data: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    level,
    msg,
    ts: new Date().toISOString(),
    ...data,
  });
  process.stderr.write(`${line}\n`);
}
