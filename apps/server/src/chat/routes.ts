import { Elysia, t } from "elysia";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Database } from "../db";
import { jwtAuth } from "../auth/middleware";
import { runChatAgent } from "./runner";
import { generateGerunds } from "./gerund";
import { loadChatHistory } from "./history";
import { chatMessages } from "../db/schema";
import { LlmBudgetExceededError } from "../analyzers/llm-budget";
import type { RedisBridge } from "../ws/redis-bridge";

const MAX_MESSAGES = 20;
const MAX_CONTENT_CHARS = 8000;
const MAX_GERUND_PROMPT_CHARS = 2000;
// Same upper bound the model uses; the local agent's final answer is plain
// markdown and rarely exceeds a few KB.
const MAX_FINALIZE_ANSWER_CHARS = 32_000;
// chat_messages.thread_id is a Postgres uuid; sending a non-UUID here would
// otherwise pass body validation and then fail the soft-fail DB insert
// silently, dropping the turn from history.
const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

export const chatRoutes = (db: Database, redis: RedisBridge) =>
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
          const result = await runChatAgent({
            db,
            redis,
            user: {
              id: user.id,
              githubLogin: user.githubLogin,
              displayName: user.displayName,
            },
            messages,
            threadId: body.threadId,
          });
          return { message: result.message, threadId: result.threadId };
        } catch (err) {
          if (err instanceof LlmBudgetExceededError) {
            set.status = 429;
            return {
              error: err.code,
              message: `You've used your daily LLM allowance ($${err.spentUsd.toFixed(2)} of $${err.capUsd.toFixed(2)}). It resets at the next UTC day.`,
              spentUsd: err.spentUsd,
              capUsd: err.capUsd,
            };
          }
          console.error("[chat] /api/chat/ask failed:", err);
          set.status = 500;
          return { error: "chat request failed" };
        }
      },
      {
        body: t.Object({
          threadId: t.Optional(t.String({ pattern: UUID_PATTERN })),
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
    .get("/history", async ({ user, set }) => {
      try {
        const threads = await loadChatHistory(db, {
          viewerId: user.id,
          authorId: user.id,
          asker: {
            login: user.githubLogin,
            displayName: user.displayName,
            avatarUrl: user.avatarUrl ?? null,
          },
        });
        return { threads };
      } catch (err) {
        console.error("[chat] /api/chat/history failed:", err);
        set.status = 500;
        return { error: "history request failed" };
      }
    })
    .post(
      "/threads/:threadId/finalize",
      async ({ user, params, body, set }) => {
        const trimmed = body.answer.slice(0, MAX_FINALIZE_ANSWER_CHARS);
        try {
          const updated = await db
            .update(chatMessages)
            .set({ answer: trimmed })
            .where(
              and(
                eq(chatMessages.id, body.messageId),
                eq(chatMessages.threadId, params.threadId),
                eq(chatMessages.userId, user.id),
                // Only finalize delegation placeholders. Defense against a
                // bug or crafted request from overwriting a non-delegated
                // chat turn's answer.
                isNotNull(chatMessages.delegation),
              ),
            )
            .returning({ id: chatMessages.id });
          if (updated.length === 0) {
            // Either the placeholder doesn't exist, the threadId doesn't
            // match, or the row belongs to another user. All three look the
            // same to the caller — don't disclose which.
            set.status = 404;
            return { error: "delegation placeholder not found" };
          }
          return { ok: true };
        } catch (err) {
          console.error("[chat] /finalize failed:", err);
          set.status = 500;
          return { error: "finalize request failed" };
        }
      },
      {
        params: t.Object({
          threadId: t.String({ pattern: UUID_PATTERN }),
        }),
        body: t.Object({
          messageId: t.String({ pattern: UUID_PATTERN }),
          answer: t.String(),
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
