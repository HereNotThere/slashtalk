import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "../src/db";
import { repos, sessions, userRepos, users } from "../src/db/schema";
import {
  canReadRepo,
  loadAccessibleSession,
  sharedRepoIdsForUsers,
  visiblePeerIdsForUser,
  visibleRepoIdsForUser,
  visibleReposForUser,
  visibleUserIdsForRepoIds,
} from "../src/repo/visibility";
import { resetDatabase } from "./helpers";

let aliceId: number;
let bobId: number;
let outsiderId: number;
let aliceRepoId: number;
let sharedRepoId: number;
let outsiderRepoId: number;

const ALICE_SESSION = "10000000-0000-0000-0000-000000000001";
const SHARED_SESSION = "10000000-0000-0000-0000-000000000002";
const OUTSIDER_SESSION = "10000000-0000-0000-0000-000000000003";

beforeAll(async () => {
  await resetDatabase();

  const [alice, bob, outsider] = await db
    .insert(users)
    .values([
      {
        githubId: 50_001,
        githubLogin: "alice",
        avatarUrl: "https://avatars.test/alice",
        displayName: "Alice",
        githubToken: "encrypted-alice-token",
      },
      {
        githubId: 50_002,
        githubLogin: "bob",
        avatarUrl: "https://avatars.test/bob",
        displayName: "Bob",
        githubToken: "encrypted-bob-token",
      },
      {
        githubId: 50_003,
        githubLogin: "outsider",
        avatarUrl: "https://avatars.test/outsider",
        displayName: "Outsider",
        githubToken: "encrypted-outsider-token",
      },
    ])
    .returning();
  aliceId = alice.id;
  bobId = bob.id;
  outsiderId = outsider.id;

  const [aliceRepo, sharedRepo, outsiderRepo] = await db
    .insert(repos)
    .values([
      { githubId: 60_001, fullName: "alice/private", owner: "alice", name: "private" },
      { githubId: 60_002, fullName: "team/shared", owner: "team", name: "shared" },
      {
        githubId: 60_003,
        fullName: "outsider/secret",
        owner: "outsider",
        name: "secret",
      },
    ])
    .returning();
  aliceRepoId = aliceRepo.id;
  sharedRepoId = sharedRepo.id;
  outsiderRepoId = outsiderRepo.id;

  await db.insert(userRepos).values([
    { userId: aliceId, repoId: aliceRepoId, permission: "push" },
    { userId: aliceId, repoId: sharedRepoId, permission: "push" },
    { userId: bobId, repoId: sharedRepoId, permission: "push" },
    { userId: outsiderId, repoId: outsiderRepoId, permission: "push" },
  ]);

  await db.insert(sessions).values([
    {
      sessionId: ALICE_SESSION,
      userId: aliceId,
      source: "claude",
      project: "private",
      repoId: aliceRepoId,
    },
    {
      sessionId: SHARED_SESSION,
      userId: aliceId,
      source: "claude",
      project: "shared",
      repoId: sharedRepoId,
    },
    {
      sessionId: OUTSIDER_SESSION,
      userId: outsiderId,
      source: "claude",
      project: "secret",
      repoId: outsiderRepoId,
    },
  ]);
});

describe("repo visibility owner", () => {
  it("loads visible repos and repo ids for a user", async () => {
    expect(await visibleRepoIdsForUser(db, bobId)).toEqual([sharedRepoId]);
    expect(await visibleReposForUser(db, aliceId)).toEqual([
      { id: aliceRepoId, fullName: "alice/private" },
      { id: sharedRepoId, fullName: "team/shared" },
    ]);
  });

  it("computes shared repos and visible peers from user_repos", async () => {
    expect(await sharedRepoIdsForUsers(db, aliceId, bobId)).toEqual([sharedRepoId]);
    expect(await sharedRepoIdsForUsers(db, bobId, outsiderId)).toEqual([]);
    expect((await visibleUserIdsForRepoIds(db, [sharedRepoId])).sort()).toEqual([aliceId, bobId]);
    expect(await visiblePeerIdsForUser(db, aliceId)).toEqual([bobId]);
    expect(await visiblePeerIdsForUser(db, aliceId, { includeSelf: true })).toEqual([
      aliceId,
      bobId,
    ]);
  });

  it("checks repo and session access without leaking invisible sessions", async () => {
    expect(await canReadRepo(db, bobId, sharedRepoId)).toBe(true);
    expect(await canReadRepo(db, bobId, aliceRepoId)).toBe(false);

    expect((await loadAccessibleSession(db, SHARED_SESSION, bobId))?.sessionId).toBe(
      SHARED_SESSION,
    );
    expect(await loadAccessibleSession(db, ALICE_SESSION, bobId)).toBeNull();
    expect(await loadAccessibleSession(db, OUTSIDER_SESSION, bobId)).toBeNull();
    expect((await loadAccessibleSession(db, ALICE_SESSION, aliceId))?.sessionId).toBe(
      ALICE_SESSION,
    );
  });
});
