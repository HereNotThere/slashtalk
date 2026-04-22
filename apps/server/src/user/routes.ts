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
  deviceExcludedRepos,
  deviceRepoPaths,
} from "../db/schema";
import { jwtAuth } from "../auth/middleware";
import { syncUserRepos } from "../social/github-sync";

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
      return await db.select().from(devices).where(eq(devices.userId, user.id));
    })

    // DELETE /api/me/devices/:id — remove a device + its API key
    .delete(
      "/devices/:id",
      async ({ params, user, set }) => {
        const [device] = await db
          .select()
          .from(devices)
          .where(
            and(eq(devices.id, Number(params.id)), eq(devices.userId, user.id)),
          )
          .limit(1);

        if (!device) {
          set.status = 404;
          return { error: "Device not found" };
        }

        await db.delete(apiKeys).where(eq(apiKeys.deviceId, device.id));
        await db.delete(devices).where(eq(devices.id, device.id));

        return { ok: true };
      },
      { params: t.Object({ id: t.String() }) },
    )

    // POST /api/me/sync-repos — trigger GitHub repo sync
    .post("/sync-repos", async ({ user }) => {
      const result = await syncUserRepos(db, user);
      return { ok: true, synced: result.synced, removed: result.removed };
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
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await db.insert(setupTokens).values({
        userId: user.id,
        token,
        expiresAt,
      });

      return { token, expiresAt: expiresAt.toISOString() };
    });

/**
 * Device repos management — reported by install script.
 * Mounted separately at /v1/devices prefix.
 */
export const deviceReposRoutes = (db: Database) =>
  new Elysia({ prefix: "/v1/devices", name: "device-repos" })
    .use(
      // Use API key auth (imported inline to avoid circular dep)
      new Elysia({ name: "device-repos/auth" }).derive(
        { as: "scoped" },
        async ({ headers, set }) => {
          const { apiKeyAuth } = await import("../auth/middleware");
          // Reuse the apiKeyAuth derive logic inline
          const authHeader = headers.authorization;
          if (!authHeader?.startsWith("Bearer ")) {
            set.status = 401;
            throw new Error("Missing API key");
          }
          const { hashToken } = await import("../auth/tokens");
          const key = authHeader.slice(7);
          const keyHash = await hashToken(key);
          const [apiKey] = await db
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.keyHash, keyHash))
            .limit(1);
          if (!apiKey) {
            set.status = 401;
            throw new Error("Invalid API key");
          }
          const [user] = await db
            .select()
            .from(users)
            .where(eq(users.id, apiKey.userId))
            .limit(1);
          if (!user) {
            set.status = 401;
            throw new Error("User not found");
          }
          const [device] = await db
            .select()
            .from(devices)
            .where(eq(devices.id, apiKey.deviceId))
            .limit(1);
          return { user, device: device ?? null };
        },
      ),
    )

    // POST /v1/devices/:id/repos — set repo paths and exclusions for a device
    .post(
      "/:id/repos",
      async ({ params, body, user, set }) => {
        const deviceId = Number(params.id);

        // Verify device belongs to user
        const [dev] = await db
          .select()
          .from(devices)
          .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
          .limit(1);

        if (!dev) {
          set.status = 404;
          return { error: "Device not found" };
        }

        const visibleRepos = await db
          .select({ repoId: repos.id, fullName: repos.fullName })
          .from(userRepos)
          .innerJoin(repos, eq(repos.id, userRepos.repoId))
          .where(eq(userRepos.userId, user.id));

        const repoIdByFullName = new Map(
          visibleRepos.map((repo) => [repo.fullName, repo.repoId]),
        );
        const visibleRepoIds = new Set(visibleRepos.map((repo) => repo.repoId));
        const skippedRepos: string[] = [];

        const resolveRepoId = (input: {
          repoId?: number;
          fullName?: string;
        }): number | null => {
          if (
            typeof input.repoId === "number" &&
            visibleRepoIds.has(input.repoId)
          ) {
            return input.repoId;
          }
          if (input.fullName) {
            return repoIdByFullName.get(input.fullName) ?? null;
          }
          return null;
        };

        // Store local path → repo mappings (from install-time discovery)
        let repoPathsStored = 0;
        if (body.repoPaths !== undefined) {
          await db
            .delete(deviceRepoPaths)
            .where(eq(deviceRepoPaths.deviceId, deviceId));

          const repoPathsByRepoId = new Map<number, string>();
          for (const repoPath of body.repoPaths) {
            const repoId = resolveRepoId(repoPath);
            if (!repoId) {
              skippedRepos.push(
                repoPath.fullName ?? `repoId:${repoPath.repoId ?? "unknown"}`,
              );
              continue;
            }
            repoPathsByRepoId.set(repoId, repoPath.localPath);
          }

          const normalizedRepoPaths = Array.from(
            repoPathsByRepoId.entries(),
          ).map(([repoId, localPath]) => ({
            deviceId,
            repoId,
            localPath,
          }));

          repoPathsStored = normalizedRepoPaths.length;
          if (normalizedRepoPaths.length > 0) {
            await db.insert(deviceRepoPaths).values(normalizedRepoPaths);
          }
        }

        // Store exclusions
        await db
          .delete(deviceExcludedRepos)
          .where(eq(deviceExcludedRepos.deviceId, deviceId));

        const excludedRepoIds = new Set<number>();
        for (const repoId of body.excludedRepoIds ?? []) {
          if (visibleRepoIds.has(repoId)) {
            excludedRepoIds.add(repoId);
          } else {
            skippedRepos.push(`repoId:${repoId}`);
          }
        }
        for (const fullName of body.excludedRepos ?? []) {
          const repoId = repoIdByFullName.get(fullName);
          if (repoId) {
            excludedRepoIds.add(repoId);
          } else {
            skippedRepos.push(fullName);
          }
        }

        const excludedReposStored = excludedRepoIds.size;
        if (excludedReposStored > 0) {
          await db.insert(deviceExcludedRepos).values(
            Array.from(excludedRepoIds).map((repoId) => ({
              deviceId,
              repoId,
            })),
          );
        }

        return {
          ok: true,
          repoPathsStored,
          excludedReposStored,
          skippedRepos,
        };
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({
          repoPaths: t.Optional(
            t.Array(
              t.Object({
                repoId: t.Optional(t.Number()),
                fullName: t.Optional(t.String()),
                localPath: t.String(),
              }),
            ),
          ),
          excludedRepoIds: t.Optional(t.Array(t.Number())),
          excludedRepos: t.Optional(t.Array(t.String())),
        }),
      },
    );
