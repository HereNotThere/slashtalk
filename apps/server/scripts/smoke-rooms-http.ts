#!/usr/bin/env bun
// End-to-end HTTP smoke test for /api/rooms. Boots the app in-process pointed
// at the rooms-prototype DB on :5452 / Redis on :6399, seeds a synthetic user
// + repo + user_orgs row (so refreshUserOrgs short-circuits and doesn't hit
// GitHub), mints a JWT, and walks the create→provision→agent-turn→patch path.
//
// Run from apps/server/:
//   ANTHROPIC_API_KEY=sk-ant-... SMOKE_GITHUB_TOKEN=$(gh auth token) \
//     bun run scripts/smoke-rooms-http.ts
//
// E2B_API_KEY is loaded from .env. SMOKE_GITHUB_TOKEN is required for cloning
// inside the sandbox; any token your gh CLI is signed in with will work.
//
// Cost: ~$0.05 of E2B + Anthropic spend per run.

console.log("starting smoke-rooms-http...");

// ── Env setup MUST happen before any source imports ──────────
// Source modules (config.ts especially) read process.env at module-load time.
// ESM `import` statements are hoisted, so use dynamic `await import(...)` for
// anything under src/ to guarantee env is set first.

const STABLE_JWT_SECRET = "smoke-rooms-jwt-secret-do-not-use-in-prod-".padEnd(64, "x");
const STABLE_ENC_KEY = "0".repeat(64);

// Force-override (not `??=`) so a stale .env DATABASE_URL/REDIS_URL pointing at
// the dev stack can't sneak in.
process.env.DATABASE_URL = "postgres://slashtalk:slashtalk@localhost:5452/slashtalk_rooms_dev";
process.env.REDIS_URL = "redis://localhost:6399";
process.env.JWT_SECRET = STABLE_JWT_SECRET;
process.env.ENCRYPTION_KEY = STABLE_ENC_KEY;
process.env.ROOMS_ENABLED = "true";
process.env.GITHUB_CLIENT_ID ??= "stub";
process.env.GITHUB_CLIENT_SECRET ??= "stub";
process.env.BASE_URL ??= "http://localhost:10000";

if (!process.env.SMOKE_GITHUB_TOKEN) {
  console.error("SMOKE_GITHUB_TOKEN is required (used for git clone inside the sandbox).");
  console.error("  → SMOKE_GITHUB_TOKEN=$(gh auth token) bun run scripts/smoke-rooms-http.ts");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required (the agent inside the sandbox needs it).");
  process.exit(1);
}
if (!process.env.E2B_API_KEY) {
  console.error("E2B_API_KEY is required (should be in apps/server/.env).");
  process.exit(1);
}

// ── Dynamic imports — env is set, safe to load source modules now ──

const { eq } = await import("drizzle-orm");
const { SignJWT } = await import("jose");
const { db } = await import("../src/db");
const schema = await import("../src/db/schema");
const { encryptGithubToken } = await import("../src/auth/tokens");
const { createApp } = await import("../src/app");
const { RedisBridge } = await import("../src/ws/redis-bridge");
const { config } = await import("../src/config");

const { users, repos, userRepos, userOrgs, rooms, roomMembers, roomMessages } = schema;

const TEST_LOGIN = "smoke-rooms-tester";
const TEST_GITHUB_ID = 999_999_001;
const TEST_REPO_FULL_NAME = "octocat/Hello-World";
const TEST_REPO_OWNER = "octocat";
const TEST_REPO_NAME = "Hello-World";
const PROMPT = "Create a file called smoke.txt with the contents 'http rooms work'.";

async function mintJwt(userId: number): Promise<string> {
  const key = new TextEncoder().encode(config.jwtSecret);
  return await new SignJWT({ sub: String(userId), sessionIssuedAt: Date.now() })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

async function seedUserAndRepo(): Promise<{ userId: number; repoId: number }> {
  const encryptedToken = await encryptGithubToken(
    process.env.SMOKE_GITHUB_TOKEN!,
    config.encryptionKey,
  );

  let [user] = await db.select().from(users).where(eq(users.githubLogin, TEST_LOGIN)).limit(1);
  if (!user) {
    [user] = await db
      .insert(users)
      .values({
        githubId: TEST_GITHUB_ID,
        githubLogin: TEST_LOGIN,
        displayName: "Smoke Tester",
        githubToken: encryptedToken,
      })
      .returning();
  } else {
    await db.update(users).set({ githubToken: encryptedToken }).where(eq(users.id, user.id));
  }

  let [repo] = await db
    .select()
    .from(repos)
    .where(eq(repos.fullName, TEST_REPO_FULL_NAME))
    .limit(1);
  if (!repo) {
    [repo] = await db
      .insert(repos)
      .values({
        fullName: TEST_REPO_FULL_NAME,
        owner: TEST_REPO_OWNER,
        name: TEST_REPO_NAME,
      })
      .returning();
  }

  await db
    .insert(userRepos)
    .values({ userId: user!.id, repoId: repo!.id, permission: "push" })
    .onConflictDoNothing();

  await db
    .insert(userOrgs)
    .values({
      userId: user!.id,
      orgLogin: TEST_REPO_OWNER,
      role: "member",
      refreshedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [userOrgs.userId, userOrgs.orgLogin],
      set: { refreshedAt: new Date() },
    });

  return { userId: user!.id, repoId: repo!.id };
}

async function callJson(
  baseUrl: string,
  cookie: string,
  method: string,
  path: string,
  body?: object,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      cookie: `session=${cookie}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function pollUntil<T>(
  fetcher: () => Promise<T>,
  predicate: (v: T) => boolean,
  opts: { intervalMs: number; timeoutMs: number; label: string },
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    const v = await fetcher();
    if (predicate(v)) return v;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  throw new Error(`timed out waiting for ${opts.label}`);
}

async function main(): Promise<void> {
  console.log("→ Seeding user + repo + user_orgs (rooms DB on :5452)...");
  const { userId } = await seedUserAndRepo();
  const jwt = await mintJwt(userId);
  console.log(`  userId=${userId}`);

  console.log("→ Booting app in-process...");
  const redis = new RedisBridge();
  await redis.connect();
  const app = createApp(db, redis);
  app.listen(0);
  const port = (app as unknown as { server?: { port: number } }).server!.port;
  const baseUrl = `http://localhost:${port}`;
  console.log(`  server on :${port}`);

  let createdRoomId: string | null = null;

  try {
    console.log(`→ POST /api/rooms (repo=${TEST_REPO_FULL_NAME})`);
    const create = await callJson(baseUrl, jwt, "POST", "/api/rooms", {
      repoFullName: TEST_REPO_FULL_NAME,
      name: "smoke",
      systemPrompt: "You are a coding agent. Make small, precise changes.",
      model: "claude-haiku-4-5-20251001",
    });
    if (create.status !== 200) {
      throw new Error(`create failed: ${create.status} ${JSON.stringify(create.body)}`);
    }
    const room = (create.body as { room: { id: string; status: string } }).room;
    createdRoomId = room.id;
    console.log(`  room=${room.id} status=${room.status}`);

    console.log("→ Waiting for status=ready (provision, ~30s)...");
    const t0 = Date.now();
    const ready = await pollUntil(
      async () => {
        const r = await callJson(baseUrl, jwt, "GET", `/api/rooms/${createdRoomId}`);
        return r.body as { room: { status: string } };
      },
      (v) => v.room.status === "ready" || v.room.status === "failed",
      { intervalMs: 2_000, timeoutMs: 90_000, label: "provision" },
    );
    if (ready.room.status !== "ready") {
      throw new Error(`room ended in status=${ready.room.status}`);
    }
    console.log(`  ready (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

    console.log(`→ POST /api/rooms/:id/agent (prompt=${PROMPT})`);
    const agent = await callJson(baseUrl, jwt, "POST", `/api/rooms/${createdRoomId}/agent`, {
      prompt: PROMPT,
    });
    if (agent.status !== 200) {
      throw new Error(`agent failed: ${agent.status} ${JSON.stringify(agent.body)}`);
    }

    console.log("→ Polling /messages for agent_message...");
    const t1 = Date.now();
    const final = await pollUntil(
      async () => {
        const r = await callJson(baseUrl, jwt, "GET", `/api/rooms/${createdRoomId}/messages`);
        return (r.body as { messages: Array<{ kind: string; body: unknown }> }).messages;
      },
      (msgs) => msgs.some((m) => m.kind === "agent_message"),
      { intervalMs: 2_000, timeoutMs: 120_000, label: "agent_message" },
    );
    const agentMsg = final.find((m) => m.kind === "agent_message")!;
    console.log(`  done (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
    console.log(`  body: ${JSON.stringify(agentMsg.body, null, 2)}`);

    console.log(`→ GET /api/rooms/${createdRoomId}/patch`);
    const patchRes = await fetch(`${baseUrl}/api/rooms/${createdRoomId}/patch`, {
      headers: { cookie: `session=${jwt}` },
    });
    const patch = await patchRes.text();
    console.log(patch || "(empty patch)");
  } finally {
    if (createdRoomId) {
      console.log("→ DELETE /api/rooms/:id");
      const del = await callJson(baseUrl, jwt, "DELETE", `/api/rooms/${createdRoomId}`);
      console.log(`  ${del.status}`);
      await db.delete(roomMessages).where(eq(roomMessages.roomId, createdRoomId));
      await db.delete(roomMembers).where(eq(roomMembers.roomId, createdRoomId));
      await db.delete(rooms).where(eq(rooms.id, createdRoomId));
    }
    app.stop();
    await redis.disconnect();
  }
}

main().catch((err) => {
  console.error("smoke test failed:", err);
  process.exit(1);
});
