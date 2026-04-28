// Idle reaper for room sandboxes. Runs every 60s and:
//   - pauses ready rooms idle past roomsIdlePauseMs (default 10min)
//   - destroys paused rooms idle past roomsHardReapMs (default 24h)
// Pause-on-idle is what makes a sleeping room cost ~zero. E2B resume from a
// memory snapshot is ~1s (validated 2026-04-26 in scripts/smoke-rooms.ts).

import { and, eq, lt, inArray } from "drizzle-orm";
import type { Database } from "../db";
import { rooms } from "../db/schema";
import { config } from "../config";
import type { RedisBridge } from "../ws/redis-bridge";
import { e2bAdapter } from "./sandbox";

const TICK_MS = 60_000;

async function tick(db: Database, redis: RedisBridge): Promise<void> {
  const now = Date.now();
  const pauseCutoff = new Date(now - config.roomsIdlePauseMs);
  const reapCutoff = new Date(now - config.roomsHardReapMs);

  // Pause idle ready rooms.
  const toPause = await db
    .select({ id: rooms.id, sandboxId: rooms.sandboxId })
    .from(rooms)
    .where(and(eq(rooms.status, "ready"), lt(rooms.lastActivityAt, pauseCutoff)));
  for (const r of toPause) {
    if (!r.sandboxId) continue;
    try {
      await e2bAdapter.pause(r.sandboxId);
      await db.update(rooms).set({ status: "paused" }).where(eq(rooms.id, r.id));
      void redis.publish(`room:${r.id}`, {
        type: "room_status_changed",
        roomId: r.id,
        status: "paused",
      });
    } catch (err) {
      console.warn(`[rooms/reaper] pause failed for ${r.id}:`, (err as Error).message);
    }
  }

  // Destroy long-paused rooms.
  const toDestroy = await db
    .select({ id: rooms.id, sandboxId: rooms.sandboxId })
    .from(rooms)
    .where(and(inArray(rooms.status, ["paused", "failed"]), lt(rooms.lastActivityAt, reapCutoff)));
  for (const r of toDestroy) {
    if (r.sandboxId) {
      try {
        await e2bAdapter.destroy(r.sandboxId);
      } catch (err) {
        console.warn(`[rooms/reaper] destroy failed for ${r.id}:`, (err as Error).message);
      }
    }
    await db
      .update(rooms)
      .set({ status: "destroyed", destroyedAt: new Date() })
      .where(eq(rooms.id, r.id));
    void redis.publish(`room:${r.id}`, {
      type: "room_status_changed",
      roomId: r.id,
      status: "destroyed",
    });
  }
}

export function startIdleReaper(db: Database, redis: RedisBridge): () => void {
  if (!config.roomsEnabled) return () => {};
  const handle = setInterval(() => {
    void tick(db, redis).catch((err) => {
      console.error("[rooms/reaper] tick failed:", err);
    });
  }, TICK_MS);
  return () => clearInterval(handle);
}
