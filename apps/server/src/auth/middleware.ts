import { Elysia } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { config } from "../config";
import { authInstance } from "./instance";

/** JWT auth plugin — validates cookie-based JWT, derives `user` into context */
export const jwtAuth = new Elysia({ name: "auth/jwt" })
  .use(
    jwt({
      name: "jwt",
      secret: config.jwtSecret,
    }),
  )
  .derive({ as: "scoped" }, async ({ jwt, cookie: { session }, set }) => {
    const user = await authInstance.resolveSessionJwt(
      jwt,
      typeof session?.value === "string" ? session.value : undefined,
    );
    if (!user) {
      set.status = 401;
      throw new Error("Invalid token");
    }

    return { user };
  });

/** API key auth plugin — validates Bearer header, derives `user` and `device` */
export const apiKeyAuth = new Elysia({ name: "auth/apiKey" }).derive(
  { as: "scoped" },
  async ({ headers, set }) => {
    const token = authInstance.bearerToken(headers.authorization);
    if (!token) {
      set.status = 401;
      throw new Error("Missing API key");
    }

    const resolved = await authInstance.resolveApiKey(token, { touchLastUsedAt: true });
    if (!resolved.ok) {
      set.status = 401;
      throw new Error(resolved.reason === "unknown_user" ? "User not found" : "Invalid API key");
    }

    return { user: resolved.value.user, device: resolved.value.device };
  },
);
