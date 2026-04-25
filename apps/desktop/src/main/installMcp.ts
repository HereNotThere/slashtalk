// Auto-install the Slashtalk MCP server into local AI-client configs.
//
// Only Claude Code is truly automatable: we read-modify-write ~/.claude.json,
// touching only our own `slashtalk-mcp` entry under `mcpServers`.
//
// Claude Desktop and claude.ai both add custom connectors via their UIs (stored
// in an internal app DB / web state), not via a config file we can write to,
// so those targets just get a "copy URL" action in the renderer.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import * as backend from "./backend";

export type McpTarget = "claude-code";

export interface TargetState {
  installed: boolean;
  path: string;
}

export interface InstallStatus {
  claudeCode: TargetState;
}

const BAKED_MCP_URL = import.meta.env.MAIN_VITE_SLASHTALK_MCP_URL as
  | string
  | undefined;
const MCP_KEY = "slashtalk-mcp";

interface ConfigShape {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function configPath(target: McpTarget): string {
  if (target === "claude-code") {
    return path.join(os.homedir(), ".claude.json");
  }
  // Exhaustiveness — if a new target is added, the switch forces handling.
  throw new Error(`unknown target: ${target as string}`);
}

function entry(token?: string | null): unknown {
  const e: { type: string; url: string; headers?: Record<string, string> } = {
    type: "http",
    url: mcpUrl(),
  };
  if (token) e.headers = { Authorization: `Bearer ${token}` };
  return e;
}

async function readConfig(file: string): Promise<ConfigShape> {
  try {
    const raw = await fs.readFile(file, "utf8");
    if (raw.trim() === "") return {};
    return JSON.parse(raw) as ConfigShape;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writeConfig(file: string, config: ConfigShape): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const text = JSON.stringify(config, null, 2) + "\n";
  await fs.writeFile(file, text, "utf8");
}

export async function install(
  target: McpTarget,
  token?: string | null,
): Promise<TargetState> {
  const file = configPath(target);
  const config = await readConfig(file);
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[MCP_KEY] = entry(token);
  await writeConfig(file, config);
  return { installed: true, path: file };
}

export async function uninstall(target: McpTarget): Promise<TargetState> {
  const file = configPath(target);
  const config = await readConfig(file);
  if (config.mcpServers && MCP_KEY in config.mcpServers) {
    delete config.mcpServers[MCP_KEY];
    await writeConfig(file, config);
  }
  return { installed: false, path: file };
}

export async function status(): Promise<InstallStatus> {
  const check = async (target: McpTarget): Promise<TargetState> => {
    const file = configPath(target);
    try {
      const config = await readConfig(file);
      return {
        installed: Boolean(config.mcpServers && MCP_KEY in config.mcpServers),
        path: file,
      };
    } catch {
      return { installed: false, path: file };
    }
  };
  return { claudeCode: await check("claude-code") };
}

export function mcpUrl(): string {
  return (
    process.env["SLASHTALK_MCP_URL"] ??
    BAKED_MCP_URL ??
    `${backend.getBaseUrl()}/mcp`
  );
}
