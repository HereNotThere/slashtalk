import { Elysia, t } from "elysia";
import { and, eq, isNotNull } from "drizzle-orm";
import type { ChatDelegatedWorkRequest } from "@slashtalk/shared";
import type { Database } from "../db";
import { jwtAuth } from "../auth/middleware";
import { runChatAgent } from "./runner";
import { generateGerunds } from "./gerund";
import { loadChatHistory } from "./history";
import { answerDelegatedWork } from "./delegated-work";
import { chatMessages, repos, userRepos } from "../db/schema";
import { LlmBudgetExceededError } from "../analyzers/llm-budget";
import type { RedisBridge } from "../ws/redis-bridge";

const MAX_MESSAGES = 20;
const MAX_CONTENT_CHARS = 8000;
const MAX_GERUND_PROMPT_CHARS = 2000;
const MAX_DELEGATED_TASK_CHARS = 4000;
const MAX_REPO_FULL_NAME_CHARS = 256;
const MAX_SNAPSHOT_LINE_CHARS = 1000;
const MAX_SNAPSHOT_DIFF_CHARS = 12_000;
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
      "/threads/:threadId/delegated-work",
      async ({ user, params, body, set }) => {
        const request = body as ChatDelegatedWorkRequest;
        const repoFullName = request.repoFullName.trim();
        if (
          !repoFullName ||
          request.snapshot.repo.fullName.toLowerCase() !== repoFullName.toLowerCase()
        ) {
          set.status = 400;
          return { error: "repo mismatch" };
        }

        const [placeholder] = await db
          .select({ delegation: chatMessages.delegation })
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.id, request.messageId),
              eq(chatMessages.threadId, params.threadId),
              eq(chatMessages.userId, user.id),
              isNotNull(chatMessages.delegation),
            ),
          )
          .limit(1);
        const delegation = placeholder?.delegation;
        if (!delegation) {
          set.status = 404;
          return { error: "delegation placeholder not found" };
        }
        if (delegation.task !== request.task) {
          set.status = 409;
          return { error: "delegation task mismatch" };
        }
        if (
          delegation.repoFullName &&
          delegation.repoFullName.toLowerCase() !== repoFullName.toLowerCase()
        ) {
          set.status = 409;
          return { error: "delegation repo mismatch" };
        }

        const [visibleRepo] = await db
          .select({ id: repos.id })
          .from(userRepos)
          .innerJoin(repos, eq(repos.id, userRepos.repoId))
          .where(and(eq(userRepos.userId, user.id), eq(repos.fullName, repoFullName)))
          .limit(1);
        if (!visibleRepo || visibleRepo.id !== request.snapshot.repo.repoId) {
          set.status = 403;
          return { error: "repo not visible" };
        }

        try {
          const result = await answerDelegatedWork({
            redis,
            userId: user.id,
            request: { ...request, repoFullName },
          });
          await db
            .update(chatMessages)
            .set({ answer: result.text, delegation: null })
            .where(
              and(
                eq(chatMessages.id, request.messageId),
                eq(chatMessages.threadId, params.threadId),
                eq(chatMessages.userId, user.id),
                isNotNull(chatMessages.delegation),
              ),
            );
          return result;
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
          console.error("[chat] /delegated-work failed:", err);
          set.status = 500;
          return { error: "delegated work request failed" };
        }
      },
      {
        params: t.Object({
          threadId: t.String({ pattern: UUID_PATTERN }),
        }),
        body: t.Object({
          messageId: t.String({ pattern: UUID_PATTERN }),
          task: t.String({ maxLength: MAX_DELEGATED_TASK_CHARS }),
          repoFullName: t.String({ maxLength: MAX_REPO_FULL_NAME_CHARS }),
          snapshot: t.Object({
            repo: t.Object({
              repoId: t.Number(),
              fullName: t.String({ maxLength: MAX_REPO_FULL_NAME_CHARS }),
            }),
            collectedAt: t.String({ maxLength: 64 }),
            branch: t.Union([t.String({ maxLength: 256 }), t.Null()]),
            headSha: t.Union([t.String({ maxLength: 64 }), t.Null()]),
            statusShort: t.Array(t.String({ maxLength: MAX_SNAPSHOT_LINE_CHARS }), {
              maxItems: 80,
            }),
            changedFiles: t.Array(t.String({ maxLength: MAX_SNAPSHOT_LINE_CHARS }), {
              maxItems: 200,
            }),
            diffStat: t.Union([t.String({ maxLength: MAX_SNAPSHOT_DIFF_CHARS }), t.Null()]),
            recentCommits: t.Array(t.String({ maxLength: MAX_SNAPSHOT_LINE_CHARS }), {
              maxItems: 30,
            }),
            relatedPrs: t.Array(
              t.Object({
                number: t.Number(),
                title: t.String({ maxLength: 500 }),
                url: t.String({ maxLength: 1000 }),
                state: t.Union([t.Literal("open"), t.Literal("closed"), t.Literal("merged")]),
                headRef: t.Union([t.String({ maxLength: 256 }), t.Null()]),
                baseRef: t.Union([t.String({ maxLength: 256 }), t.Null()]),
                authorLogin: t.Union([t.String({ maxLength: 256 }), t.Null()]),
                updatedAt: t.Union([t.String({ maxLength: 64 }), t.Null()]),
              }),
              { maxItems: 20 },
            ),
            ghStatus: t.Union([t.Literal("ready"), t.Literal("missing"), t.Literal("unauthed")]),
            collectionErrors: t.Optional(
              t.Array(t.String({ maxLength: MAX_SNAPSHOT_LINE_CHARS }), { maxItems: 20 }),
            ),
          }),
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
