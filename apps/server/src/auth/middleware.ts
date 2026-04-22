import { Elysia } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { users, apiKeys, devices } from "../db/schema";
import { hashToken } from "./tokens";

/** JWT auth plugin — validates cookie-based JWT, derives `user` into context */
export const jwtAuth = new Elysia({ name: "auth/jwt" })
  .use(
    jwt({
      name: "jwt",
      secret: config.jwtSecret,
    })
  )
  .derive({ as: "scoped" }, async ({ jwt, cookie: { session }, set }) => {
    const token = session?.value;
    if (!token) {
      set.status = 401;
      throw new Error("Unauthorized");
    }

    const payload = await jwt.verify(token as string);
    if (!payload || !payload.sub) {
      set.status = 401;
      throw new Error("Invalid token");
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, Number(payload.sub)))
      .limit(1);

    if (!user) {
      set.status = 401;
      throw new Error("User not found");
    }

    return { user };
  });

/** API key auth plugin — validates Bearer header, derives `user` and `device` */
export const apiKeyAuth = new Elysia({ name: "auth/apiKey" }).derive(
  { as: "scoped" },
  async ({ headers, set }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      set.status = 401;
      throw new Error("Missing API key");
    }

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

    // Update last_used_at
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKey.id));

    return { user, device: device ?? null };
  }
);
