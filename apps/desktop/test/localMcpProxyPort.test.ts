import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const userData = await fs.mkdtemp(path.join(os.tmpdir(), "slashtalk-port-store-"));

mock.module("electron", () => ({
  app: {
    getPath(name: string) {
      if (name !== "userData") throw new Error(`unexpected app path: ${name}`);
      return userData;
    },
  },
}));

const {
  clearSavedLocalMcpPortForTests,
  getSavedLocalMcpPort,
  resetLocalMcpProxyPortCacheForTests,
  saveSavedLocalMcpPort,
} = await import("../src/main/localMcpProxyPort");
const { resetStoreForTests } = await import("../src/main/store");

beforeEach(() => {
  clearSavedLocalMcpPortForTests();
});

afterAll(async () => {
  await fs.rm(userData, { recursive: true, force: true });
});

describe("localMcpProxyPort", () => {
  it("returns null when no port is saved", () => {
    expect(getSavedLocalMcpPort()).toBeNull();
  });

  it("saves and reads the persisted port", () => {
    saveSavedLocalMcpPort(54321);
    resetLocalMcpProxyPortCacheForTests();

    expect(getSavedLocalMcpPort()).toBe(54321);
  });

  it("clears corrupted stored values", async () => {
    saveSavedLocalMcpPort(54321);
    const storeFile = path.join(userData, "chatheads.json");
    const raw = JSON.parse(await fs.readFile(storeFile, "utf8")) as Record<string, unknown>;
    raw.localMcpProxyPort = { port: "not-a-port" };
    await fs.writeFile(storeFile, JSON.stringify(raw), "utf8");
    resetStoreForTests();
    resetLocalMcpProxyPortCacheForTests();

    expect(getSavedLocalMcpPort()).toBeNull();
    resetLocalMcpProxyPortCacheForTests();
    expect(getSavedLocalMcpPort()).toBeNull();
  });

  it("rejects invalid ports on save", () => {
    expect(() => saveSavedLocalMcpPort(0)).toThrow("Invalid local MCP proxy port");
    expect(() => saveSavedLocalMcpPort(70_000)).toThrow("Invalid local MCP proxy port");
  });
});
