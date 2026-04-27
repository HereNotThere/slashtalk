import { describe, it, expect, beforeEach } from "bun:test";
import { detectCollisions, __resetForTests } from "../src/correlate/file-index";

const REPO = 42;
const ALICE = { id: 1001, login: "alice" };
const BOB = { id: 1002, login: "bob" };
const SID_ALICE = "sess-alice-1";
const SID_ALICE_2 = "sess-alice-2";
const SID_BOB = "sess-bob-1";

const T0 = 1_700_000_000_000; // fixed epoch ms for deterministic throttle tests

beforeEach(() => {
  __resetForTests();
});

describe("file-index detectCollisions", () => {
  it("two users in same repo, same file → one collision listing the other session", () => {
    const aliceFirst = detectCollisions({
      repoId: REPO,
      sessionId: SID_ALICE,
      userId: ALICE.id,
      githubLogin: ALICE.login,
      currentFiles: ["src/auth.ts"],
      priorFiles: [],
      now: T0,
    });
    expect(aliceFirst).toEqual([]);

    const bobArrives = detectCollisions({
      repoId: REPO,
      sessionId: SID_BOB,
      userId: BOB.id,
      githubLogin: BOB.login,
      currentFiles: ["src/auth.ts"],
      priorFiles: [],
      now: T0 + 1_000,
    });
    expect(bobArrives).toHaveLength(1);
    expect(bobArrives[0]?.filePath).toBe("src/auth.ts");
    expect(bobArrives[0]?.others).toEqual([
      { sessionId: SID_ALICE, userId: ALICE.id, githubLogin: ALICE.login },
    ]);
  });

  it("same user, two sessions on the same file → no collision", () => {
    detectCollisions({
      repoId: REPO,
      sessionId: SID_ALICE,
      userId: ALICE.id,
      githubLogin: ALICE.login,
      currentFiles: ["src/auth.ts"],
      priorFiles: [],
      now: T0,
    });

    const second = detectCollisions({
      repoId: REPO,
      sessionId: SID_ALICE_2,
      userId: ALICE.id,
      githubLogin: ALICE.login,
      currentFiles: ["src/auth.ts"],
      priorFiles: [],
      now: T0 + 1_000,
    });
    expect(second).toEqual([]);
  });

  it("ignored basenames (e.g. package.json) never trigger a collision", () => {
    detectCollisions({
      repoId: REPO,
      sessionId: SID_ALICE,
      userId: ALICE.id,
      githubLogin: ALICE.login,
      currentFiles: ["package.json"],
      priorFiles: [],
      now: T0,
    });

    const bob = detectCollisions({
      repoId: REPO,
      sessionId: SID_BOB,
      userId: BOB.id,
      githubLogin: BOB.login,
      currentFiles: ["package.json", "bun.lock"],
      priorFiles: [],
      now: T0 + 1_000,
    });
    expect(bob).toEqual([]);
  });

  it("repeated ingests on the same (file, pair) within 5 min → throttled to one collision", () => {
    detectCollisions({
      repoId: REPO,
      sessionId: SID_ALICE,
      userId: ALICE.id,
      githubLogin: ALICE.login,
      currentFiles: ["src/auth.ts"],
      priorFiles: [],
      now: T0,
    });

    // Bob first detection — fires
    const first = detectCollisions({
      repoId: REPO,
      sessionId: SID_BOB,
      userId: BOB.id,
      githubLogin: BOB.login,
      currentFiles: ["src/auth.ts"],
      priorFiles: [],
      now: T0 + 1_000,
    });
    expect(first).toHaveLength(1);

    // Bob then re-adds the file (after it dropped out of his top-5 and came
    // back, say). priorFiles excludes auth.ts so it's "newly added" again.
    // Within the throttle window → no collision.
    const within = detectCollisions({
      repoId: REPO,
      sessionId: SID_BOB,
      userId: BOB.id,
      githubLogin: BOB.login,
      currentFiles: ["src/auth.ts"],
      priorFiles: [],
      now: T0 + 60_000,
    });
    expect(within).toEqual([]);

    // After the 5-min throttle window → fires again.
    const after = detectCollisions({
      repoId: REPO,
      sessionId: SID_BOB,
      userId: BOB.id,
      githubLogin: BOB.login,
      currentFiles: ["src/auth.ts"],
      priorFiles: [],
      now: T0 + 6 * 60_000,
    });
    expect(after).toHaveLength(1);
  });

  it("different repos with the same file path do not collide", () => {
    detectCollisions({
      repoId: REPO,
      sessionId: SID_ALICE,
      userId: ALICE.id,
      githubLogin: ALICE.login,
      currentFiles: ["src/index.ts"],
      priorFiles: [],
      now: T0,
    });

    const bobDifferentRepo = detectCollisions({
      repoId: REPO + 1,
      sessionId: SID_BOB,
      userId: BOB.id,
      githubLogin: BOB.login,
      currentFiles: ["src/index.ts"],
      priorFiles: [],
      now: T0 + 1_000,
    });
    expect(bobDifferentRepo).toEqual([]);
  });

  it("session expiring (>30 min stale) drops out of the index", () => {
    detectCollisions({
      repoId: REPO,
      sessionId: SID_ALICE,
      userId: ALICE.id,
      githubLogin: ALICE.login,
      currentFiles: ["src/auth.ts"],
      priorFiles: [],
      now: T0,
    });

    // Bob arrives 31 min later — Alice's entry should have been pruned.
    const bobLater = detectCollisions({
      repoId: REPO,
      sessionId: SID_BOB,
      userId: BOB.id,
      githubLogin: BOB.login,
      currentFiles: ["src/auth.ts"],
      priorFiles: [],
      now: T0 + 31 * 60_000,
    });
    expect(bobLater).toEqual([]);
  });

  it("a file that was already in priorFiles does not retrigger on the same ingest", () => {
    // Alice has been editing auth.ts for a while. New ingest doesn't add new
    // files, just bumps counts. Should NOT trigger collision detection even
    // if Bob is also touching it.
    detectCollisions({
      repoId: REPO,
      sessionId: SID_BOB,
      userId: BOB.id,
      githubLogin: BOB.login,
      currentFiles: ["src/auth.ts"],
      priorFiles: [],
      now: T0,
    });

    const aliceContinues = detectCollisions({
      repoId: REPO,
      sessionId: SID_ALICE,
      userId: ALICE.id,
      githubLogin: ALICE.login,
      currentFiles: ["src/auth.ts"],
      priorFiles: ["src/auth.ts"], // already in her top-edited from prior ingest
      now: T0 + 1_000,
    });
    expect(aliceContinues).toEqual([]);
  });
});
