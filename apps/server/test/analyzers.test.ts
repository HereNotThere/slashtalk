import { describe, expect, it } from "bun:test";
import { buildPrompt as buildSummaryPrompt } from "../src/analyzers/summary";
import { buildPrompt as buildRollingPrompt } from "../src/analyzers/rolling-summary";
import { compactEvent } from "../src/analyzers/event-compact";
import { processEvents } from "../src/ingest/aggregator";

function analyzerCtx(session: Record<string, unknown>) {
  return {
    db: null,
    existingInsight: null,
    recentEvents: async () => [],
    session: {
      project: "slashtalk",
      cwd: "/repo/slashtalk",
      branch: "ae/memory-0427",
      title: "Fix server OOM crashes on Render",
      lastUserPrompt: "fix batch flush atomicity in ingest handler",
      recentPrompts: [
        { ts: "2026-04-27T20:00:00.000Z", text: "Fix server OOM crashes on Render" },
        {
          ts: "2026-04-27T20:45:00.000Z",
          text: "fix batch flush atomicity in ingest handler",
        },
      ],
      topFilesEdited: {
        "apps/server/src/ingest/routes.ts": 4,
        "apps/server/src/ingest/aggregator.ts": 2,
      },
      topFilesWritten: {
        "apps/server/test/upload.test.ts": 1,
      },
      toolUseNames: { Read: 3, Edit: 2 },
      ...session,
    },
  } as never;
}

function baseSession(overrides: Record<string, unknown> = {}) {
  return {
    provider: null,
    userMsgs: 0,
    assistantMsgs: 0,
    toolCalls: 0,
    toolErrors: 0,
    events: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    tokensReasoning: 0,
    model: null,
    version: null,
    branch: null,
    cwd: null,
    firstTs: null,
    lastTs: null,
    title: null,
    inTurn: false,
    currentTurnId: null,
    lastBoundaryTs: null,
    outstandingTools: {},
    lastUserPrompt: null,
    topFilesRead: {},
    topFilesEdited: {},
    topFilesWritten: {},
    toolUseNames: {},
    queued: [],
    recentEvents: [],
    recentPrompts: [],
    ...overrides,
  } as never;
}

describe("analyzer prompt context", () => {
  it("anchors summary labels on the original task and prompt arc", () => {
    const prompt = buildSummaryPrompt(analyzerCtx({}), [], null);

    expect(prompt).toContain("original task anchor");
    expect(prompt).toContain("Fix server OOM crashes on Render");
    expect(prompt).toContain("recent user prompts");
    expect(prompt).toContain("fix batch flush atomicity in ingest handler");
    expect(prompt).toContain("top files edited (all-time)");
    expect(prompt).toContain("apps/server/src/ingest/routes.ts");
  });

  it("gives rolling summary the same stable task evidence", () => {
    const prompt = buildRollingPrompt(analyzerCtx({}), [], null);

    expect(prompt).toContain("original task anchor");
    expect(prompt).toContain("Fix server OOM crashes on Render");
    expect(prompt).toContain("recent user prompts");
    expect(prompt).toContain("top files written (all-time)");
    expect(prompt).toContain("apps/server/test/upload.test.ts");
  });
});

describe("event compaction", () => {
  it("extracts Codex user, assistant, and tool-call details", () => {
    const user = compactEvent({
      kind: "user_msg",
      ts: new Date("2026-04-27T20:00:00.000Z"),
      payload: {
        type: "event_msg",
        payload: { type: "user_message", message: "Fix server OOM crashes" },
      },
    } as never);
    const assistant = compactEvent({
      kind: "assistant_msg",
      ts: new Date("2026-04-27T20:00:01.000Z"),
      payload: {
        type: "event_msg",
        payload: { type: "agent_message", message: "I will inspect ingest memory use." },
      },
    } as never);
    const tool = compactEvent({
      kind: "tool_call",
      ts: new Date("2026-04-27T20:00:02.000Z"),
      payload: {
        type: "response_item",
        payload: { type: "function_call", name: "apply_patch", arguments: "{}" },
      },
    } as never);

    expect(user).toContain("prompt: Fix server OOM crashes");
    expect(assistant).toContain("reply: I will inspect ingest memory use.");
    expect(tool).toContain("apply_patch");
  });
});

describe("ingest aggregation prompt tracking", () => {
  it("does not treat task notifications as user prompts", () => {
    const updates = processEvents("claude", baseSession(), [
      {
        uuid: "task-note",
        type: "user",
        timestamp: "2026-04-27T20:00:00.000Z",
        message: {
          content:
            "<task-notification>\n<task-id>abc</task-id>\n<output-file>/tmp/task.output</output-file>",
        },
      },
    ]);

    expect(updates.title).toBeNull();
    expect(updates.lastUserPrompt).toBeNull();
    expect(updates.recentPrompts).toEqual([]);
    expect(updates.recentEvents).toEqual([]);
  });
});
