// Auto-install the Slashtalk MCP server into local AI-client configs.
//
// Claude Code and Codex are local config-file integrations. The default mode
// points both clients at the desktop-local proxy so the Slashtalk device API
// key stays in Electron safeStorage instead of being written into client config.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { mcpUrl as configMcpUrl } from "./config";

export type McpTarget = "claude-code" | "codex";
export type McpInstallMode = "local-proxy" | "legacy-bearer";
export type McpInstalledMode = McpInstallMode | "unknown";

export interface TargetState {
  installed: boolean;
  path: string;
  mode?: McpInstalledMode;
  url?: string | null;
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
  localProxySecret?: () => string;
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
  reconcileLocalProxyConfigs: () => Promise<InstallStatus>;
  mcpUrl: () => string;
  remoteMcpUrl: () => string;
}

const MCP_KEY = "slashtalk-mcp";
export const LOCAL_PROXY_SECRET_HEADER = "X-Slashtalk-Proxy-Token";
let fallbackLocalProxySecret: string | null = null;

function missingLocalProxyUrl(): string {
  throw new Error("local MCP proxy URL is not configured");
}

function defaultLocalProxySecret(): string {
  fallbackLocalProxySecret ??= randomBytes(32).toString("base64url");
  return fallbackLocalProxySecret;
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

function objectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function headerValue(headers: Record<string, unknown>, name: string): unknown {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) return value;
  }
  return undefined;
}

function claudeEntry(
  options: ReturnType<typeof normalizeOptions>,
  localUrl: string,
  remoteUrl: string,
  proxySecret: string,
): unknown {
  const e: { type: string; url: string; headers?: Record<string, string> } = {
    type: "http",
    url: options.mode === "legacy-bearer" ? remoteUrl : localUrl,
  };
  if (options.mode === "legacy-bearer") {
    if (!options.token) throw new Error("legacy-bearer MCP install requires token");
    e.headers = { Authorization: `Bearer ${options.token}` };
  } else {
    e.headers = { [LOCAL_PROXY_SECRET_HEADER]: proxySecret };
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
  return trimmed === "[mcp_servers.slashtalk-mcp]" || trimmed === '[mcp_servers."slashtalk-mcp"]';
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

function slashtalkCodexSection(text: string): string[] | null {
  const lines = text.split(/\r?\n/);
  const section: string[] = [];
  let collecting = false;

  for (const line of lines) {
    if (isTomlSection(line)) {
      if (collecting) break;
      collecting = isSlashtalkCodexSection(line);
    }
    if (collecting) section.push(line);
  }

  return section.length > 0 ? section : null;
}

function tomlStringValue(lines: string[], key: string): string | null {
  for (const line of lines) {
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`));
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function codexEntry(localUrl: string, proxySecret: string): string {
  return [
    "[mcp_servers.slashtalk-mcp]",
    `url = ${JSON.stringify(localUrl)}`,
    "enabled = true",
    `http_headers = { ${JSON.stringify(LOCAL_PROXY_SECRET_HEADER)} = ${JSON.stringify(proxySecret)} }`,
  ].join("\n");
}

async function installClaudeCode(
  file: string,
  options: ReturnType<typeof normalizeOptions>,
  localUrl: string,
  remoteUrl: string,
  proxySecret: string,
): Promise<void> {
  const config = await readJsonConfig(file);
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[MCP_KEY] = claudeEntry(options, localUrl, remoteUrl, proxySecret);
  await writeJsonConfig(file, config);
}

async function installCodex(file: string, localUrl: string, proxySecret: string): Promise<void> {
  const existing = await readTomlConfig(file);
  const withoutOurs = removeSlashtalkCodexSection(existing);
  const next = [withoutOurs, codexEntry(localUrl, proxySecret)]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
  await writeTomlConfig(file, next + "\n");
}

export function createInstaller(deps: InstallerDeps = {}): Installer {
  const homeDir = deps.homeDir ?? os.homedir();
  const getLocalProxyUrl = deps.localProxyUrl ?? missingLocalProxyUrl;
  const getLocalProxySecret = deps.localProxySecret ?? defaultLocalProxySecret;
  const getRemoteMcpUrl = deps.remoteMcpUrl ?? configMcpUrl;

  const inspectClaude = async (): Promise<TargetState> => {
    const file = targetPath("claude-code", homeDir);
    try {
      const config = await readJsonConfig(file);
      const entry = config.mcpServers?.[MCP_KEY];
      if (!objectRecord(entry)) return { installed: false, path: file };

      const headers = objectRecord(entry.headers) ? entry.headers : {};
      const url = typeof entry.url === "string" ? entry.url : null;
      const mode =
        typeof headerValue(headers, LOCAL_PROXY_SECRET_HEADER) === "string"
          ? "local-proxy"
          : typeof headerValue(headers, "Authorization") === "string" || url === getRemoteMcpUrl()
            ? "legacy-bearer"
            : "unknown";
      return { installed: true, path: file, mode, url };
    } catch {
      return { installed: false, path: file };
    }
  };

  const inspectCodex = async (): Promise<TargetState> => {
    const file = targetPath("codex", homeDir);
    try {
      const text = await readTomlConfig(file);
      const section = slashtalkCodexSection(text);
      if (!section) return { installed: false, path: file };
      return {
        installed: true,
        path: file,
        mode: "local-proxy",
        url: tomlStringValue(section, "url"),
      };
    } catch {
      return { installed: false, path: file };
    }
  };

  return {
    async install(target, optionsOrToken) {
      const file = targetPath(target, homeDir);
      const options = normalizeOptions(optionsOrToken);
      if (target === "claude-code") {
        const localUrl = options.mode === "local-proxy" ? getLocalProxyUrl() : "";
        const proxySecret = options.mode === "local-proxy" ? getLocalProxySecret() : "";
        await installClaudeCode(file, options, localUrl, getRemoteMcpUrl(), proxySecret);
      } else {
        if (options.mode === "legacy-bearer") {
          throw new Error("Codex legacy-bearer install is intentionally unsupported");
        }
        await installCodex(file, getLocalProxyUrl(), getLocalProxySecret());
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
        await writeTomlConfig(file, removeSlashtalkCodexSection(existing) + "\n");
      }
      return { installed: false, path: file };
    },

    async status() {
      const [claudeCode, codex] = await Promise.all([inspectClaude(), inspectCodex()]);
      return { claudeCode, codex };
    },

    async reconcileLocalProxyConfigs() {
      const status = await this.status();
      const liveUrl = getLocalProxyUrl();
      const targets: Array<[McpTarget, TargetState]> = [
        ["claude-code", status.claudeCode],
        ["codex", status.codex],
      ];
      for (const [target, state] of targets) {
        if (state.installed && state.mode === "local-proxy" && state.url !== liveUrl) {
          await this.install(target, { mode: "local-proxy" });
        }
      }
      return this.status();
    },

    mcpUrl: getLocalProxyUrl,
    remoteMcpUrl: getRemoteMcpUrl,
  };
}

let defaultInstaller = createInstaller();

export function configureInstaller(deps: InstallerDeps): void {
  defaultInstaller = createInstaller(deps);
}

export const install: Installer["install"] = (...args) => defaultInstaller.install(...args);
export const uninstall: Installer["uninstall"] = (...args) => defaultInstaller.uninstall(...args);
export const status: Installer["status"] = () => defaultInstaller.status();
export const reconcileLocalProxyConfigs: Installer["reconcileLocalProxyConfigs"] = () =>
  defaultInstaller.reconcileLocalProxyConfigs();
export const mcpUrl: Installer["mcpUrl"] = () => defaultInstaller.mcpUrl();
export const remoteMcpUrl: Installer["remoteMcpUrl"] = () => defaultInstaller.remoteMcpUrl();
