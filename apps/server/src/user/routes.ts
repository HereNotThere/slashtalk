import { Elysia, t } from "elysia";
import { eq, and } from "drizzle-orm";
import type { Database } from "../db";
import {
  users,
  devices,
  repos,
  userRepos,
  setupTokens,
  apiKeys,
} from "../db/schema";
import { jwtAuth } from "../auth/middleware";

export const userRoutes = (db: Database) =>
  new Elysia({ prefix: "/api/me", name: "user" })
    .use(jwtAuth)

    // GET /api/me — current user profile
    .get("/", ({ user }) => ({
      id: user.id,
      githubLogin: user.githubLogin,
      avatarUrl: user.avatarUrl,
      displayName: user.displayName,
      createdAt: user.createdAt,
    }))

    // GET /api/me/devices — list user's devices
    .get("/devices", async ({ user }) => {
      return await db
        .select()
        .from(devices)
        .where(eq(devices.userId, user.id));
    })

    // DELETE /api/me/devices/:id — remove a device + its API key
    .delete(
      "/devices/:id",
      async ({ params, user, set }) => {
        const [device] = await db
          .select()
          .from(devices)
          .where(
            and(eq(devices.id, Number(params.id)), eq(devices.userId, user.id))
          )
          .limit(1);

        if (!device) {
          set.status = 404;
          return { error: "Device not found" };
        }

        // Delete API keys for this device, then the device itself
        await db.delete(apiKeys).where(eq(apiKeys.deviceId, device.id));
        await db.delete(devices).where(eq(devices.id, device.id));

        return { ok: true };
      },
      { params: t.Object({ id: t.String() }) }
    )

    // POST /api/me/sync-repos — trigger GitHub repo sync
    .post("/sync-repos", async ({ user }) => {
      // TODO: Fetch repos from GitHub API, upsert repos + user_repos
      // This is a stub that returns success
      return { ok: true, message: "Repo sync not yet implemented" };
    })

    // GET /api/me/repos — list user's repos
    .get("/repos", async ({ user }) => {
      return await db
        .select({
          repoId: repos.id,
          fullName: repos.fullName,
          owner: repos.owner,
          name: repos.name,
          private: repos.private,
          permission: userRepos.permission,
          syncedAt: userRepos.syncedAt,
        })
        .from(userRepos)
        .innerJoin(repos, eq(repos.id, userRepos.repoId))
        .where(eq(userRepos.userId, user.id));
    })

    // POST /api/me/setup-token — generate a new setup token
    .post("/setup-token", async ({ user }) => {
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

      await db.insert(setupTokens).values({
        userId: user.id,
        token,
        expiresAt,
      });

      return { token, expiresAt: expiresAt.toISOString() };
    });
