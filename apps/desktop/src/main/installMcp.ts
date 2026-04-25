// Auto-install the Slashtalk MCP server into local AI-client configs.
//
// Claude Code and Codex are local config-file integrations. The default mode
// points both clients at the desktop-local proxy so the Slashtalk device API
// key stays in Electron safeStorage instead of being written into client config.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export type McpTarget = "claude-code" | "codex";
export type McpInstallMode = "local-proxy" | "legacy-bearer";

export interface TargetState {
  installed: boolean;
  path: string;
}

export interface InstallStatus {
  claudeCode: TargetState;
  codex: TargetState;
}

export interface InstallOptions {
  mode?: McpInstallMode;
  token?: string | null;
}

interface InstallerDeps {
  homeDir?: string;
  localProxyUrl?: () => string;
  remoteMcpUrl?: () => string;
}

interface ConfigShape {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Installer {
  install: (
    target: McpTarget,
    optionsOrToken?: InstallOptions | string | null,
  ) => Promise<TargetState>;
  uninstall: (target: McpTarget) => Promise<TargetState>;
  status: () => Promise<InstallStatus>;
  mcpUrl: () => string;
  remoteMcpUrl: () => string;
}

const BAKED_MCP_URL = import.meta.env.MAIN_VITE_SLASHTALK_MCP_URL as
  | string
  | undefined;
const BAKED_BASE_URL = import.meta.env.MAIN_VITE_SLASHTALK_API_URL as
  | string
  | undefined;
const DEFAULT_BASE_URL = "https://slashtalk.onrender.com";
const MCP_KEY = "slashtalk-mcp";
export const DEFAULT_LOCAL_MCP_PORT = 37613;

function backendBaseUrl(): string {
  return (
    process.env["SLASHTALK_API_URL"] ?? BAKED_BASE_URL ?? DEFAULT_BASE_URL
  );
}

function defaultRemoteMcpUrl(): string {
  return (
    process.env["SLASHTALK_MCP_URL"] ??
    BAKED_MCP_URL ??
    `${backendBaseUrl()}/mcp`
  );
}

export function localMcpPort(): number {
  const raw = process.env["SLASHTALK_LOCAL_MCP_PORT"];
  if (!raw) return DEFAULT_LOCAL_MCP_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid SLASHTALK_LOCAL_MCP_PORT: ${raw}`);
  }
  return port;
}

export function localProxyMcpUrl(): string {
  return `http://127.0.0.1:${localMcpPort()}/mcp`;
}

function normalizeOptions(
  optionsOrToken?: InstallOptions | string | null,
): Required<Pick<InstallOptions, "mode">> & Pick<InstallOptions, "token"> {
  if (
    typeof optionsOrToken === "string" ||
    optionsOrToken === null ||
    optionsOrToken === undefined
  ) {
    return {
      mode: optionsOrToken ? "legacy-bearer" : "local-proxy",
      token: optionsOrToken,
    };
  }
  return {
    mode: optionsOrToken.mode ?? "local-proxy",
    token: optionsOrToken.token,
  };
}

function targetPath(target: McpTarget, homeDir: string): string {
  if (target === "claude-code") return path.join(homeDir, ".claude.json");
  if (target === "codex") return path.join(homeDir, ".codex", "config.toml");
  throw new Error(`unknown target: ${target as string}`);
}

function claudeEntry(
  options: ReturnType<typeof normalizeOptions>,
  localUrl: string,
  remoteUrl: string,
): unknown {
  const e: { type: string; url: string; headers?: Record<string, string> } = {
    type: "http",
    url: options.mode === "legacy-bearer" ? remoteUrl : localUrl,
  };
  if (options.mode === "legacy-bearer") {
    if (!options.token) throw new Error("legacy-bearer MCP install requires token");
    e.headers = { Authorization: `Bearer ${options.token}` };
  }
  return e;
}

async function readJsonConfig(file: string): Promise<ConfigShape> {
  try {
    const raw = await fs.readFile(file, "utf8");
    if (raw.trim() === "") return {};
    return JSON.parse(raw) as ConfigShape;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writeJsonConfig(file: string, config: ConfigShape): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf8");
}

async function readTomlConfig(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

async function writeTomlConfig(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
}

function isSlashtalkCodexSection(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === "[mcp_servers.slashtalk-mcp]" ||
    trimmed === '[mcp_servers."slashtalk-mcp"]'
  );
}

function isTomlSection(line: string): boolean {
  return /^\s*\[[^\]]+\]\s*$/.test(line);
}

function removeSlashtalkCodexSection(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;

  for (const line of lines) {
    if (isTomlSection(line)) {
      skipping = isSlashtalkCodexSection(line);
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }

  return out.join("\n").trimEnd();
}

function codexEntry(localUrl: string): string {
  return [
    "[mcp_servers.slashtalk-mcp]",
    `url = ${JSON.stringify(localUrl)}`,
    "enabled = true",
  ].join("\n");
}

async function installClaudeCode(
  file: string,
  options: ReturnType<typeof normalizeOptions>,
  localUrl: string,
  remoteUrl: string,
): Promise<void> {
  const config = await readJsonConfig(file);
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[MCP_KEY] = claudeEntry(options, localUrl, remoteUrl);
  await writeJsonConfig(file, config);
}

async function installCodex(file: string, localUrl: string): Promise<void> {
  const existing = await readTomlConfig(file);
  const withoutOurs = removeSlashtalkCodexSection(existing);
  const next = [withoutOurs, codexEntry(localUrl)]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
  await writeTomlConfig(file, next + "\n");
}

export function createInstaller(deps: InstallerDeps = {}): Installer {
  const homeDir = deps.homeDir ?? os.homedir();
  const getLocalProxyUrl = deps.localProxyUrl ?? localProxyMcpUrl;
  const getRemoteMcpUrl = deps.remoteMcpUrl ?? defaultRemoteMcpUrl;

  return {
    async install(target, optionsOrToken) {
      const file = targetPath(target, homeDir);
      const options = normalizeOptions(optionsOrToken);
      if (target === "claude-code") {
        await installClaudeCode(
          file,
          options,
          getLocalProxyUrl(),
          getRemoteMcpUrl(),
        );
      } else {
        if (options.mode === "legacy-bearer") {
          throw new Error(
            "Codex legacy-bearer install is intentionally unsupported",
          );
        }
        await installCodex(file, getLocalProxyUrl());
      }
      return { installed: true, path: file };
    },

    async uninstall(target) {
      const file = targetPath(target, homeDir);
      if (target === "claude-code") {
        const config = await readJsonConfig(file);
        if (config.mcpServers && MCP_KEY in config.mcpServers) {
          delete config.mcpServers[MCP_KEY];
          await writeJsonConfig(file, config);
        }
      } else {
        const existing = await readTomlConfig(file);
        await writeTomlConfig(
          file,
          removeSlashtalkCodexSection(existing) + "\n",
        );
      }
      return { installed: false, path: file };
    },

    async status() {
      const checkClaude = async (): Promise<TargetState> => {
        const file = targetPath("claude-code", homeDir);
        try {
          const config = await readJsonConfig(file);
          return {
            installed: Boolean(config.mcpServers && MCP_KEY in config.mcpServers),
            path: file,
          };
        } catch {
          return { installed: false, path: file };
        }
      };
      const checkCodex = async (): Promise<TargetState> => {
        const file = targetPath("codex", homeDir);
        try {
          const text = await readTomlConfig(file);
          return {
            installed: text.split(/\r?\n/).some(isSlashtalkCodexSection),
            path: file,
          };
        } catch {
          return { installed: false, path: file };
        }
      };
      const [claudeCode, codex] = await Promise.all([
        checkClaude(),
        checkCodex(),
      ]);
      return { claudeCode, codex };
    },

    mcpUrl: getLocalProxyUrl,
    remoteMcpUrl: getRemoteMcpUrl,
  };
}

const defaultInstaller = createInstaller();

export const install = defaultInstaller.install;
export const uninstall = defaultInstaller.uninstall;
export const status = defaultInstaller.status;
export const mcpUrl = defaultInstaller.mcpUrl;
export const remoteMcpUrl = defaultInstaller.remoteMcpUrl;
