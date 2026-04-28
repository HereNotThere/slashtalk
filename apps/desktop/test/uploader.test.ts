import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as claudeSessionMeta from "../src/main/claudeSessionMeta";

const { decodeCwdFromProjectDir } = claudeSessionMeta;

const tmpRoots: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return fs.realpathSync(dir);
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe("claudeSessionMeta.findCwdBySessionId", () => {
  it("returns the cwd recorded in the matching per-pid file", async () => {
    const sessionsDir = await tmpDir("slashtalk-meta-");
    const sessionId = "11111111-2222-3333-4444-555555555555";
    await fsp.writeFile(
      path.join(sessionsDir, "12345.json"),
      JSON.stringify({
        pid: 12345,
        sessionId,
        kind: "claude",
        cwd: "/Users/test/repo",
        version: "1.0.0",
        startedAt: 1700000000000,
      }),
    );

    expect(await claudeSessionMeta.findCwdBySessionId(sessionId, sessionsDir)).toBe(
      "/Users/test/repo",
    );
  });

  it("returns null when no file matches the sessionId", async () => {
    const sessionsDir = await tmpDir("slashtalk-meta-");
    await fsp.writeFile(
      path.join(sessionsDir, "12345.json"),
      JSON.stringify({
        pid: 12345,
        sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        cwd: "/Users/test/repo",
      }),
    );

    expect(
      await claudeSessionMeta.findCwdBySessionId(
        "11111111-2222-3333-4444-555555555555",
        sessionsDir,
      ),
    ).toBe(null);
  });

  it("returns null when the sessions dir does not exist", async () => {
    const ghost = path.join(os.tmpdir(), "slashtalk-meta-missing-" + Date.now());
    expect(
      await claudeSessionMeta.findCwdBySessionId("11111111-2222-3333-4444-555555555555", ghost),
    ).toBe(null);
  });

  it("ignores malformed json without throwing", async () => {
    const sessionsDir = await tmpDir("slashtalk-meta-");
    await fsp.writeFile(path.join(sessionsDir, "broken.json"), "not json");
    const sessionId = "11111111-2222-3333-4444-555555555555";
    await fsp.writeFile(
      path.join(sessionsDir, "12345.json"),
      JSON.stringify({ pid: 12345, sessionId, cwd: "/Users/test/repo" }),
    );

    expect(await claudeSessionMeta.findCwdBySessionId(sessionId, sessionsDir)).toBe(
      "/Users/test/repo",
    );
  });
});

describe("decodeCwdFromProjectDir", () => {
  it("reverses slugifyPath for a typical project", () => {
    const filePath =
      "/home/x/.claude/projects/-Users-fei-slashtalk/11111111-2222-3333-4444-555555555555.jsonl";
    expect(decodeCwdFromProjectDir(filePath)).toBe("/Users/fei/slashtalk");
  });

  it("returns null when the project dir slug doesn't start with `-`", () => {
    const filePath =
      "/home/x/.claude/projects/not-a-cwd-slug/11111111-2222-3333-4444-555555555555.jsonl";
    expect(decodeCwdFromProjectDir(filePath)).toBe(null);
  });

  // Caveat documented in the spec: original paths with `-` round-trip wrong.
  // The decode itself can't tell — callers must guard with existsSync +
  // isPathTracked before trusting the result. This test pins the lossy
  // behavior so a future "fix" doesn't silently change the contract.
  it("loses information when the original path contains `-`", () => {
    const filePath =
      "/home/x/.claude/projects/-Users-foo-bar-repo/11111111-2222-3333-4444-555555555555.jsonl";
    expect(decodeCwdFromProjectDir(filePath)).toBe("/Users/foo/bar/repo");
  });
});
