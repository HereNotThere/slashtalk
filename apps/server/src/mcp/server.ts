import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ServerOptions = {
  name: string;
  version: string;
};

export function createMcpServer(options: ServerOptions): McpServer {
  const server = new McpServer({ name: options.name, version: options.version });
  installEmptyListHandlers(server);
  return server;
}

function installEmptyListHandlers(server: McpServer): void {
  // The SDK only installs list handlers after something registers that
  // capability. During this migration phase the server intentionally exposes no
  // tools/resources/prompts, but clients such as Codex still probe the list
  // methods during startup. Keep those probes successful with empty lists.
  const internal = server as unknown as {
    setToolRequestHandlers: () => void;
    setResourceRequestHandlers: () => void;
    setPromptRequestHandlers: () => void;
  };
  internal.setToolRequestHandlers();
  internal.setResourceRequestHandlers();
  internal.setPromptRequestHandlers();
}

type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, msg: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    level,
    msg,
    ts: new Date().toISOString(),
    ...data,
  });
  process.stderr.write(`${line}\n`);
}
