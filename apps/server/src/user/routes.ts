import { Elysia, t } from "elysia";
import { eq, and, inArray, isNull } from "drizzle-orm";
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
  sessions,
} from "../db/schema";
import { jwtAuth } from "../auth/middleware";
import { authAudit } from "../auth/audit";
import { matchSessionRepo, normalizeFullName } from "../social/github-sync";
import { __clearClaimCaches } from "./claim";
import { __clearOrgsCaches } from "./orgs";

/** Test-only: reset the GitHub-proxy caches + claim-gate state so assertions
 *  don't bleed across cases. No production path calls this. */
export function __clearOrgCaches(): void {
  __clearOrgsCaches();
  __clearClaimCaches();
}

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
          .where(and(eq(devices.id, Number(params.id)), eq(devices.userId, user.id)))
          .limit(1);

        if (!device) {
          set.status = 404;
          return { error: "Device not found" };
        }

        await db.delete(apiKeys).where(eq(apiKeys.deviceId, device.id));
        await db.delete(devices).where(eq(devices.id, device.id));
        authAudit("device_credentials_revoked", {
          userId: user.id,
          deviceId: device.id,
          scope: "device",
        });

        return { ok: true };
      },
      { params: t.Object({ id: t.String() }) },
    )

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
          const [user] = await db.select().from(users).where(eq(users.id, apiKey.userId)).limit(1);
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

    // GET /v1/devices/:id/repos — the paths this device has registered.
    // Used by the desktop on sign-in to rehydrate its tracked-repo list.
    .get(
      "/:id/repos",
      async ({ params, user, set }) => {
        const deviceId = Number(params.id);
        const [dev] = await db
          .select({ id: devices.id })
          .from(devices)
          .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
          .limit(1);
        if (!dev) {
          set.status = 404;
          return { error: "Device not found" };
        }
        const rows = await db
          .select({
            repoId: repos.id,
            fullName: repos.fullName,
            localPath: deviceRepoPaths.localPath,
          })
          .from(deviceRepoPaths)
          .innerJoin(repos, eq(repos.id, deviceRepoPaths.repoId))
          .where(eq(deviceRepoPaths.deviceId, deviceId));
        return rows;
      },
      { params: t.Object({ id: t.String() }) },
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

        const repoIdByFullName = new Map(visibleRepos.map((repo) => [repo.fullName, repo.repoId]));
        const visibleRepoIds = new Set(visibleRepos.map((repo) => repo.repoId));
        const skippedRepos: string[] = [];

        const resolveRepoId = (input: {
          repoId?: number;
          fullName?: string;
          repoFullName?: string;
        }): number | null => {
          if (typeof input.repoId === "number" && visibleRepoIds.has(input.repoId)) {
            return input.repoId;
          }

          const fullName = input.fullName ?? input.repoFullName;
          if (fullName) {
            return repoIdByFullName.get(normalizeFullName(fullName)) ?? null;
          }

          return null;
        };

        // Store local path → repo mappings (from install-time discovery)
        let repoPathsStored = 0;
        await db.delete(deviceRepoPaths).where(eq(deviceRepoPaths.deviceId, deviceId));

        if (body.repoPaths !== undefined) {
          const repoPathsByRepoId = new Map<number, string>();
          for (const repoPath of body.repoPaths) {
            const repoId = resolveRepoId(repoPath);
            if (!repoId) {
              skippedRepos.push(
                repoPath.fullName ??
                  repoPath.repoFullName ??
                  `repoId:${repoPath.repoId ?? "unknown"}`,
              );
              continue;
            }
            repoPathsByRepoId.set(repoId, repoPath.localPath);
          }

          const normalizedRepoPaths = Array.from(repoPathsByRepoId.entries()).map(
            ([repoId, localPath]) => ({
              deviceId,
              repoId,
              localPath,
            }),
          );

          repoPathsStored = normalizedRepoPaths.length;
          if (normalizedRepoPaths.length > 0) {
            await db.insert(deviceRepoPaths).values(normalizedRepoPaths);
          }
        }

        // Store exclusions
        await db.delete(deviceExcludedRepos).where(eq(deviceExcludedRepos.deviceId, deviceId));

        const excludedRepoIds = new Set<number>();
        for (const repoId of body.excludedRepoIds ?? []) {
          if (visibleRepoIds.has(repoId)) {
            excludedRepoIds.add(repoId);
          } else {
            skippedRepos.push(`repoId:${repoId}`);
          }
        }
        for (const fullName of body.excludedRepos ?? []) {
          const repoId = repoIdByFullName.get(normalizeFullName(fullName));
          if (repoId) {
            excludedRepoIds.add(repoId);
          } else {
            skippedRepos.push(fullName);
          }
        }
        for (const fullName of body.excludedRepoFullNames ?? []) {
          const repoId = repoIdByFullName.get(normalizeFullName(fullName));
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

        if (excludedRepoIds.size > 0) {
          const excludedSessions = await db
            .select({ sessionId: sessions.sessionId })
            .from(sessions)
            .where(
              and(
                eq(sessions.userId, user.id),
                eq(sessions.deviceId, deviceId),
                inArray(sessions.repoId, Array.from(excludedRepoIds)),
              ),
            );

          for (const session of excludedSessions) {
            await db
              .update(sessions)
              .set({ repoId: null })
              .where(eq(sessions.sessionId, session.sessionId));
          }
        }

        const unmatchedSessions = await db
          .select({
            sessionId: sessions.sessionId,
            cwd: sessions.cwd,
            project: sessions.project,
          })
          .from(sessions)
          .where(
            and(
              eq(sessions.userId, user.id),
              eq(sessions.deviceId, deviceId),
              isNull(sessions.repoId),
            ),
          );

        for (const session of unmatchedSessions) {
          const repoId = await matchSessionRepo(
            db,
            user.id,
            session.cwd,
            session.project,
            deviceId,
          );
          if (!repoId) continue;

          await db
            .update(sessions)
            .set({ repoId })
            .where(and(eq(sessions.sessionId, session.sessionId), isNull(sessions.repoId)));
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
                repoFullName: t.Optional(t.String()),
                localPath: t.String(),
              }),
            ),
          ),
          excludedRepoIds: t.Optional(t.Array(t.Number())),
          excludedRepos: t.Optional(t.Array(t.String())),
          excludedRepoFullNames: t.Optional(t.Array(t.String())),
        }),
      },
    );
