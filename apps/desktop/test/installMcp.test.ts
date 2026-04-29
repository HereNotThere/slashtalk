import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInstaller } from "../src/main/installMcp";

const tmpRoots: string[] = [];

async function tmpHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slashtalk-mcp-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("installMcp", () => {
  it("installs Claude Code through the local proxy without a static bearer", async () => {
    const home = await tmpHome();
    const claudeConfig = path.join(home, ".claude.json");
    await fs.writeFile(
      claudeConfig,
      JSON.stringify(
        {
          mcpServers: {
            unrelated: { type: "http", url: "https://example.com/mcp" },
          },
          theme: "dark",
        },
        null,
        2,
      ),
    );

    const installer = createInstaller({
      homeDir: home,
      localProxyUrl: () => "http://127.0.0.1:37613/mcp",
      localProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => "https://api.example.com/mcp",
    });

    await installer.install("claude-code");

    const config = JSON.parse(await fs.readFile(claudeConfig, "utf8"));
    expect(config.theme).toBe("dark");
    expect(config.mcpServers.unrelated.url).toBe("https://example.com/mcp");
    expect(config.mcpServers["slashtalk-mcp"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:37613/mcp",
      headers: { "X-Slashtalk-Proxy-Token": "local-proxy-secret" },
    });
    expect(JSON.stringify(config)).not.toContain("device-api-key");
  });

  it("keeps Claude Code legacy bearer install available explicitly", async () => {
    const home = await tmpHome();
    const installer = createInstaller({
      homeDir: home,
      localProxyUrl: () => "http://127.0.0.1:37613/mcp",
      localProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => "https://api.example.com/mcp",
    });

    await installer.install("claude-code", {
      mode: "legacy-bearer",
      token: "device-api-key",
    });

    const config = JSON.parse(await fs.readFile(path.join(home, ".claude.json"), "utf8"));
    expect(config.mcpServers["slashtalk-mcp"]).toEqual({
      type: "http",
      url: "https://api.example.com/mcp",
      headers: { Authorization: "Bearer device-api-key" },
    });
  });

  it("installs Codex through the local proxy without token material", async () => {
    const home = await tmpHome();
    const codexDir = path.join(home, ".codex");
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(
      path.join(codexDir, "config.toml"),
      'model = "gpt-5.5"\n\n[mcp_servers.other]\nurl = "https://example.com/mcp"\n',
    );
    const installer = createInstaller({
      homeDir: home,
      localProxyUrl: () => "http://127.0.0.1:37613/mcp",
      localProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => "https://api.example.com/mcp",
    });

    await installer.install("codex");

    const text = await fs.readFile(path.join(codexDir, "config.toml"), "utf8");
    expect(text).toContain('model = "gpt-5.5"');
    expect(text).toContain("[mcp_servers.other]");
    expect(text).toContain("[mcp_servers.slashtalk-mcp]");
    expect(text).toContain('url = "http://127.0.0.1:37613/mcp"');
    expect(text).toContain("enabled = true");
    expect(text).toContain('http_headers = { "X-Slashtalk-Proxy-Token" = "local-proxy-secret" }');
    expect(text).not.toContain("device-api-key");
    expect(text).not.toContain("Authorization");
    expect(text).not.toContain("bearer_token");
  });

  it("uninstalls only the Slashtalk Codex section", async () => {
    const home = await tmpHome();
    const codexDir = path.join(home, ".codex");
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(
      path.join(codexDir, "config.toml"),
      [
        'model = "gpt-5.5"',
        "",
        "[mcp_servers.slashtalk-mcp]",
        'url = "http://127.0.0.1:37613/mcp"',
        "enabled = true",
        'http_headers = { "X-Slashtalk-Proxy-Token" = "old-secret" }',
        "",
        "[mcp_servers.other]",
        'url = "https://example.com/mcp"',
        "",
      ].join("\n"),
    );
    const installer = createInstaller({
      homeDir: home,
      localProxyUrl: () => "http://127.0.0.1:37613/mcp",
      localProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => "https://api.example.com/mcp",
    });

    await installer.uninstall("codex");

    const text = await fs.readFile(path.join(codexDir, "config.toml"), "utf8");
    expect(text).toContain('model = "gpt-5.5"');
    expect(text).not.toContain("[mcp_servers.slashtalk-mcp]");
    expect(text).toContain("[mcp_servers.other]");
  });

  it("throws for local-proxy install when the proxy URL was not injected", async () => {
    const home = await tmpHome();
    const installer = createInstaller({
      homeDir: home,
      localProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => "https://api.example.com/mcp",
    });

    await expect(installer.install("claude-code")).rejects.toThrow(
      "local MCP proxy URL is not configured",
    );
  });

  it("uses a 32-byte base64url fallback local proxy secret", async () => {
    const home = await tmpHome();
    const installer = createInstaller({
      homeDir: home,
      localProxyUrl: () => "http://127.0.0.1:45678/mcp",
      remoteMcpUrl: () => "https://api.example.com/mcp",
    });

    await installer.install("claude-code");

    const config = JSON.parse(await fs.readFile(path.join(home, ".claude.json"), "utf8"));
    const secret = config.mcpServers["slashtalk-mcp"].headers["X-Slashtalk-Proxy-Token"];
    expect(secret).toHaveLength(43);
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
  });

  it("reports install mode and URL for Claude Code and Codex", async () => {
    const home = await tmpHome();
    const installer = createInstaller({
      homeDir: home,
      localProxyUrl: () => "http://127.0.0.1:45678/mcp",
      localProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => "https://api.example.com/mcp",
    });

    await installer.install("claude-code");
    await installer.install("codex");
    const status = await installer.status();

    expect(status.claudeCode).toMatchObject({
      installed: true,
      mode: "local-proxy",
      url: "http://127.0.0.1:45678/mcp",
    });
    expect(status.codex).toMatchObject({
      installed: true,
      mode: "local-proxy",
      url: "http://127.0.0.1:45678/mcp",
    });
  });

  it("reconciles stale local-proxy configs without converting legacy bearer installs", async () => {
    const home = await tmpHome();
    const installer = createInstaller({
      homeDir: home,
      localProxyUrl: () => "http://127.0.0.1:45678/mcp",
      localProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => "https://api.example.com/mcp",
    });

    await installer.install("claude-code", {
      mode: "legacy-bearer",
      token: "device-api-key",
    });
    const codexDir = path.join(home, ".codex");
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(
      path.join(codexDir, "config.toml"),
      [
        "[mcp_servers.slashtalk-mcp]",
        'url = "http://127.0.0.1:37613/mcp"',
        "enabled = true",
        'http_headers = { "X-Slashtalk-Proxy-Token" = "old-secret" }',
        "",
      ].join("\n"),
    );

    await installer.reconcileLocalProxyConfigs();

    const claudeConfig = JSON.parse(await fs.readFile(path.join(home, ".claude.json"), "utf8"));
    expect(claudeConfig.mcpServers["slashtalk-mcp"]).toEqual({
      type: "http",
      url: "https://api.example.com/mcp",
      headers: { Authorization: "Bearer device-api-key" },
    });
    const codexText = await fs.readFile(path.join(codexDir, "config.toml"), "utf8");
    expect(codexText).toContain('url = "http://127.0.0.1:45678/mcp"');
    expect(codexText).toContain(
      'http_headers = { "X-Slashtalk-Proxy-Token" = "local-proxy-secret" }',
    );
  });

  it("reconciles stale Claude Code local-proxy configs", async () => {
    const home = await tmpHome();
    await fs.writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify(
        {
          mcpServers: {
            "slashtalk-mcp": {
              type: "http",
              url: "http://127.0.0.1:37613/mcp",
              headers: { "X-Slashtalk-Proxy-Token": "old-secret" },
            },
          },
        },
        null,
        2,
      ),
    );
    const installer = createInstaller({
      homeDir: home,
      localProxyUrl: () => "http://127.0.0.1:45678/mcp",
      localProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => "https://api.example.com/mcp",
    });

    await installer.reconcileLocalProxyConfigs();

    const config = JSON.parse(await fs.readFile(path.join(home, ".claude.json"), "utf8"));
    expect(config.mcpServers["slashtalk-mcp"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:45678/mcp",
      headers: { "X-Slashtalk-Proxy-Token": "local-proxy-secret" },
    });
    expect(JSON.stringify(config)).not.toContain("description");
    expect(JSON.stringify(config)).not.toContain("displayName");
  });

  it("reconciles Claude Code local-proxy configs with differently cased headers", async () => {
    const home = await tmpHome();
    await fs.writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify(
        {
          mcpServers: {
            "slashtalk-mcp": {
              type: "http",
              url: "http://127.0.0.1:37613/mcp",
              headers: { "x-slashtalk-proxy-token": "old-secret" },
            },
          },
        },
        null,
        2,
      ),
    );
    const installer = createInstaller({
      homeDir: home,
      localProxyUrl: () => "http://127.0.0.1:45678/mcp",
      localProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => "https://api.example.com/mcp",
    });

    await installer.reconcileLocalProxyConfigs();

    const config = JSON.parse(await fs.readFile(path.join(home, ".claude.json"), "utf8"));
    expect(config.mcpServers["slashtalk-mcp"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:45678/mcp",
      headers: { "X-Slashtalk-Proxy-Token": "local-proxy-secret" },
    });
  });

  it("does not convert Claude Code legacy bearer configs with differently cased auth headers", async () => {
    const home = await tmpHome();
    await fs.writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify(
        {
          mcpServers: {
            "slashtalk-mcp": {
              type: "http",
              url: "https://api.example.com/mcp",
              headers: { authorization: "Bearer device-api-key" },
            },
          },
        },
        null,
        2,
      ),
    );
    const installer = createInstaller({
      homeDir: home,
      localProxyUrl: () => "http://127.0.0.1:45678/mcp",
      localProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => "https://api.example.com/mcp",
    });

    await installer.reconcileLocalProxyConfigs();

    const config = JSON.parse(await fs.readFile(path.join(home, ".claude.json"), "utf8"));
    expect(config.mcpServers["slashtalk-mcp"]).toEqual({
      type: "http",
      url: "https://api.example.com/mcp",
      headers: { authorization: "Bearer device-api-key" },
    });
  });
});
