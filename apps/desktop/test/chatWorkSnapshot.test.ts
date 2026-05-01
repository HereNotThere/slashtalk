import { describe, expect, it } from "bun:test";
import { collectChatWorkSnapshot, type ExecFileRunner } from "../src/main/chatWorkSnapshot";
import type { TrackedRepo } from "../src/shared/types";

const REPO: TrackedRepo = {
  repoId: 42,
  fullName: "team/slashtalk",
  localPath: "/Users/alice/src/slashtalk",
};

describe("collectChatWorkSnapshot", () => {
  it("collects only fixed repo metadata and related PRs", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const execFile: ExecFileRunner = async (file, args) => {
      calls.push({ file, args });
      if (file === "git") {
        const command = args.slice(2).join(" ");
        if (command === "rev-parse --abbrev-ref HEAD") return out("feature/snapshot");
        if (command === "rev-parse --verify HEAD") {
          return out("0123456789abcdef0123456789abcdef01234567");
        }
        if (command === "status --short --branch --untracked-files=normal") {
          return out("## feature/snapshot\n M apps/server/src/chat/routes.ts\n?? scratch.md\n");
        }
        if (command === "diff --stat --compact-summary HEAD --") {
          return out(" apps/server/src/chat/routes.ts | 12 ++++++++++++\n scratch.md | 2 ++");
        }
        if (command === "log --oneline --decorate=short -n 30 --") {
          return out("cfc18d7 (HEAD -> feature/snapshot) feat: snapshot chat work");
        }
      }
      if (file === "gh") {
        expect(args).toEqual([
          "pr",
          "list",
          "--repo",
          "team/slashtalk",
          "--head",
          "feature/snapshot",
          "--state",
          "all",
          "--json",
          "number,title,url,state,headRefName,baseRefName,updatedAt,author",
          "--limit",
          "20",
        ]);
        return out(
          JSON.stringify([
            {
              number: 212,
              title: "Snapshot work",
              url: "https://github.com/team/slashtalk/pull/212",
              state: "OPEN",
              headRefName: "feature/snapshot",
              baseRefName: "main",
              updatedAt: "2026-04-29T12:00:00Z",
              author: { login: "alice" },
            },
          ]),
        );
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    };

    const snapshot = await collectChatWorkSnapshot(REPO, {
      execFile,
      probeGhStatus: async () => "ready",
      now: () => new Date("2026-04-29T12:00:00Z"),
    });

    expect(snapshot).toMatchObject({
      repo: { repoId: 42, fullName: "team/slashtalk" },
      collectedAt: "2026-04-29T12:00:00.000Z",
      branch: "feature/snapshot",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      statusShort: ["## feature/snapshot", " M apps/server/src/chat/routes.ts", "?? scratch.md"],
      changedFiles: ["apps/server/src/chat/routes.ts", "scratch.md"],
      ghStatus: "ready",
    });
    expect(snapshot.relatedPrs).toEqual([
      {
        number: 212,
        title: "Snapshot work",
        url: "https://github.com/team/slashtalk/pull/212",
        state: "open",
        headRef: "feature/snapshot",
        baseRef: "main",
        authorLogin: "alice",
        updatedAt: "2026-04-29T12:00:00Z",
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(REPO.localPath);
    expect(calls.every((call) => call.file === "git" || call.file === "gh")).toBe(true);
  });

  it("does not query GitHub PRs when gh is unavailable", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const execFile: ExecFileRunner = async (file, args) => {
      calls.push({ file, args });
      const command = args.slice(2).join(" ");
      if (command === "rev-parse --abbrev-ref HEAD") return out("feature/snapshot");
      return out("");
    };

    const snapshot = await collectChatWorkSnapshot(REPO, {
      execFile,
      probeGhStatus: async () => "unauthed",
    });

    expect(snapshot.ghStatus).toBe("unauthed");
    expect(snapshot.relatedPrs).toEqual([]);
    expect(calls.some((call) => call.file === "gh")).toBe(false);
  });
});

function out(stdout: string) {
  return { stdout, stderr: "" };
}
