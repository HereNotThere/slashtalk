// Provision + agent-turn execution for a room. Both run async after the HTTP
// request returns; clients learn about progress via the room:<id> WS channel.

import { eq } from "drizzle-orm";
import type { Database } from "../db";
import { rooms, roomMessages } from "../db/schema";
import type { RedisBridge } from "../ws/redis-bridge";
import { e2bAdapter, type ProvisionOpts } from "./sandbox";

export async function postMessage(
  db: Database,
  redis: RedisBridge,
  roomId: string,
  authorUserId: number | null,
  kind: string,
  body: unknown,
): Promise<{ seq: number }> {
  const [row] = await db
    .insert(roomMessages)
    .values({ roomId, authorUserId, kind, body: body as object })
    .returning({ seq: roomMessages.seq, createdAt: roomMessages.createdAt });
  void redis.publish(`room:${roomId}`, {
    type: "room_message_created",
    roomId,
    message: {
      seq: row!.seq,
      authorUserId,
      kind,
      body,
      createdAt: row!.createdAt,
    },
  });
  return { seq: row!.seq };
}

export async function provisionRoomAsync(
  db: Database,
  redis: RedisBridge,
  roomId: string,
  opts: ProvisionOpts,
): Promise<void> {
  try {
    const { sandboxId } = await e2bAdapter.provision(opts);
    await db
      .update(rooms)
      .set({ sandboxId, status: "ready", lastActivityAt: new Date() })
      .where(eq(rooms.id, roomId));
    await postMessage(db, redis, roomId, null, "system", { kind: "ready" });
    void redis.publish(`room:${roomId}`, {
      type: "room_status_changed",
      roomId,
      status: "ready",
    });
  } catch (err) {
    console.error("[rooms] provision failed:", err);
    await db
      .update(rooms)
      .set({ status: "failed", destroyedAt: new Date() })
      .where(eq(rooms.id, roomId));
    await postMessage(db, redis, roomId, null, "system", {
      kind: "failed",
      error: (err as Error).message,
    });
    void redis.publish(`room:${roomId}`, {
      type: "room_status_changed",
      roomId,
      status: "failed",
    });
  }
}

type RoomRow = typeof rooms.$inferSelect;

export async function runAgentTurnAsync(
  db: Database,
  redis: RedisBridge,
  room: RoomRow,
  prompt: string,
): Promise<void> {
  if (!room.sandboxId) {
    await postMessage(db, redis, room.id, null, "system", { kind: "error", error: "no sandbox" });
    return;
  }
  await postMessage(db, redis, room.id, null, "agent_typing", {});

  try {
    // Auto-resume in case the idle reaper paused the sandbox between turns.
    await e2bAdapter.resume(room.sandboxId);

    const result = await e2bAdapter.runAgentTurn(room.sandboxId, {
      prompt,
      onEvent: (event) => {
        // Forward each Claude stream-json event verbatim. The room window
        // discriminates on event.type (assistant / tool_use / result / etc.)
        // and renders the live agent activity.
        void redis.publish(`room:${room.id}`, {
          type: "room_agent_delta",
          roomId: room.id,
          event,
        });
      },
      onStderr: (chunk) => {
        void redis.publish(`room:${room.id}`, {
          type: "room_agent_delta",
          roomId: room.id,
          stream: "stderr",
          chunk,
        });
      },
    });

    await postMessage(db, redis, room.id, null, "agent_message", {
      text: result.text,
      exitCode: result.exitCode,
      diffStat: result.diffStat,
    });
    await db.update(rooms).set({ lastActivityAt: new Date() }).where(eq(rooms.id, room.id));
  } catch (err) {
    console.error("[rooms] agent turn failed:", err);
    await postMessage(db, redis, room.id, null, "system", {
      kind: "agent_error",
      error: (err as Error).message,
    });
  }
}
