import { Elysia, t } from "elysia";
import type { Database } from "../db";
import { jwtAuth } from "../auth/middleware";
import { runChatAgent } from "./runner";
import { generateGerunds } from "./gerund";

const MAX_MESSAGES = 20;
const MAX_CONTENT_CHARS = 8000;
const MAX_GERUND_PROMPT_CHARS = 2000;

export const chatRoutes = (db: Database) =>
  new Elysia({ name: "chat", prefix: "/api/chat" })
    .use(jwtAuth)
    .post(
      "/ask",
      async ({ user, body, set }) => {
        const messages = body.messages;
        if (messages.length === 0) {
          set.status = 400;
          return { error: "messages must be non-empty" };
        }
        if (messages.length > MAX_MESSAGES) {
          set.status = 400;
          return { error: `messages exceeds ${MAX_MESSAGES}` };
        }
        if (messages[messages.length - 1].role !== "user") {
          set.status = 400;
          return { error: "last message must be role=user" };
        }
        for (const m of messages) {
          if (m.content.length > MAX_CONTENT_CHARS) {
            set.status = 400;
            return {
              error: `message content exceeds ${MAX_CONTENT_CHARS} chars`,
            };
          }
        }

        try {
          const message = await runChatAgent({
            db,
            user: {
              id: user.id,
              githubLogin: user.githubLogin,
              displayName: user.displayName,
            },
            messages,
          });
          return { message };
        } catch (err) {
          console.error("[chat] /api/chat/ask failed:", err);
          set.status = 500;
          return { error: "chat request failed" };
        }
      },
      {
        body: t.Object({
          messages: t.Array(
            t.Union([
              t.Object({
                role: t.Literal("user"),
                content: t.String(),
              }),
              t.Object({
                role: t.Literal("assistant"),
                content: t.String(),
                citations: t.Optional(
                  t.Array(
                    t.Object({
                      sessionId: t.String(),
                      reason: t.String(),
                    }),
                  ),
                ),
              }),
            ]),
          ),
        }),
      },
    )
    .post(
      "/gerund",
      async ({ body, set }) => {
        const prompt = body.prompt.slice(0, MAX_GERUND_PROMPT_CHARS);
        try {
          const words = await generateGerunds(prompt);
          return { words };
        } catch (err) {
          console.error("[chat] /api/chat/gerund failed:", err);
          set.status = 500;
          return { error: "gerund request failed" };
        }
      },
      {
        body: t.Object({
          prompt: t.String(),
        }),
      },
    );
