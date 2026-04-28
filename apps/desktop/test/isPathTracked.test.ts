import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPathTrackedAgainst } from "../src/main/pathTracking";

let tmpRoot: string;
let trackedRepo: string;
let outsideDir: string;

beforeAll(() => {
  // Canonicalize tmpRoot once so prefix comparisons work on macOS where
  // /var is a symlink to /private/var.
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "slashtalk-tracked-")));
  trackedRepo = path.join(tmpRoot, "tracked-repo");
  fs.mkdirSync(path.join(trackedRepo, "src"), { recursive: true });
  outsideDir = path.join(tmpRoot, "outside");
  fs.mkdirSync(outsideDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("isPathTrackedAgainst", () => {
  it("accepts a real path inside a tracked repo", () => {
    expect(isPathTrackedAgainst(path.join(trackedRepo, "src"), [trackedRepo])).toBe(true);
  });

  it("rejects a real path outside every tracked repo", () => {
    expect(isPathTrackedAgainst(outsideDir, [trackedRepo])).toBe(false);
  });

  it("rejects null/undefined/empty cwd", () => {
    expect(isPathTrackedAgainst(null, [trackedRepo])).toBe(false);
    expect(isPathTrackedAgainst(undefined, [trackedRepo])).toBe(false);
    expect(isPathTrackedAgainst("", [trackedRepo])).toBe(false);
  });

  it("rejects a cwd whose path lies under a tracked dir but realpaths outside it", () => {
    // A symlink planted inside the tracked repo points at a directory outside
    // it. A session whose cwd traverses the symlink looks textually inside
    // the tracked tree but resolves elsewhere — must not be admitted.
    const escape = path.join(trackedRepo, "escape");
    fs.symlinkSync(outsideDir, escape);
    expect(isPathTrackedAgainst(escape, [trackedRepo])).toBe(false);
  });

  it("accepts a symlinked cwd whose real target lives inside a tracked repo", () => {
    const link = path.join(tmpRoot, "link-in");
    fs.symlinkSync(path.join(trackedRepo, "src"), link);
    expect(isPathTrackedAgainst(link, [trackedRepo])).toBe(true);
  });

  it("rejects when the tracked-root path no longer exists", () => {
    const ghost = path.join(tmpRoot, "deleted-root");
    expect(isPathTrackedAgainst(path.join(trackedRepo, "src"), [ghost])).toBe(false);
  });

  it("rejects when the cwd path no longer exists", () => {
    expect(isPathTrackedAgainst(path.join(trackedRepo, "missing-subdir"), [trackedRepo])).toBe(
      false,
    );
  });

  it("rejects a sibling directory whose name shares a prefix with the tracked root", () => {
    // tracked-repo vs tracked-repo-evil: textual startsWith would match
    // without the trailing-separator guard already in place.
    const sibling = path.join(tmpRoot, "tracked-repo-evil");
    fs.mkdirSync(sibling, { recursive: true });
    expect(isPathTrackedAgainst(sibling, [trackedRepo])).toBe(false);
  });
});
