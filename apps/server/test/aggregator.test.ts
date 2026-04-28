import { describe, it, expect } from "bun:test";
import { processEvents } from "../src/ingest/aggregator";

const EMPTY_SESSION = {
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
};

describe("processEvents — pr-link summary", () => {
  it("includes repo and PR number in the recent-events summary", () => {
    const updates = processEvents("claude", EMPTY_SESSION, [
      {
        type: "pr-link",
        uuid: "00000000-0000-0000-0000-000000000001",
        timestamp: "2026-04-27T19:00:20.673Z",
        prNumber: 142,
        prUrl: "https://github.com/HereNotThere/slashtalk/pull/142",
        prRepository: "HereNotThere/slashtalk",
      },
    ]);
    expect(updates.recentEvents).toEqual([
      {
        ts: "2026-04-27T19:00:20.673Z",
        type: "pr-link",
        summary: "PR HereNotThere/slashtalk#142",
      },
    ]);
  });

  it("falls back to URL when prRepository or prNumber are missing", () => {
    const updates = processEvents("claude", EMPTY_SESSION, [
      {
        type: "pr-link",
        uuid: "00000000-0000-0000-0000-000000000002",
        timestamp: "2026-04-27T19:00:20.673Z",
        prUrl: "https://github.com/HereNotThere/slashtalk/pull/142",
      },
    ]);
    expect(updates.recentEvents[0]?.summary).toBe(
      "PR https://github.com/HereNotThere/slashtalk/pull/142",
    );
  });
});

describe("processEvents — queued_command attachment shapes", () => {
  // Real Claude Code stores `attachment.prompt` as either a string OR an
  // Anthropic-shape array of content blocks (when the user pastes an image).
  // Earlier code did `truthy && prompt.startsWith(...)`, which threw on the
  // array case and surfaced as a 500 from /v1/ingest, wedging the session.

  it("queues a plain string prompt", () => {
    const updates = processEvents("claude", EMPTY_SESSION, [
      {
        type: "attachment",
        uuid: "00000000-0000-0000-0000-000000000010",
        timestamp: "2026-04-27T19:00:20.673Z",
        attachment: {
          type: "queued_command",
          prompt: "ship it",
          commandMode: "default",
        },
      },
    ]);
    expect(updates.queued).toEqual([
      { prompt: "ship it", ts: "2026-04-27T19:00:20.673Z", mode: "default" },
    ]);
    expect(updates.inTurn).toBe(true);
  });

  it("flattens a content-block array prompt (image-paste case) instead of dropping it", () => {
    const updates = processEvents("claude", EMPTY_SESSION, [
      {
        type: "attachment",
        uuid: "00000000-0000-0000-0000-000000000011",
        timestamp: "2026-04-27T19:00:20.673Z",
        attachment: {
          type: "queued_command",
          // Real-world payload from a Claude Code JSONL
          prompt: [
            { type: "text", text: "[Image #4] fix this please" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
          ] as unknown as string,
          commandMode: "prompt",
        },
      },
    ]);
    expect(updates.queued).toEqual([
      {
        prompt: "[Image #4] fix this please [image]",
        ts: "2026-04-27T19:00:20.673Z",
        mode: "prompt",
      },
    ]);
    expect(updates.inTurn).toBe(true);
  });

  it("ignores queued_command whose prompt has no usable text", () => {
    const updates = processEvents("claude", EMPTY_SESSION, [
      {
        type: "attachment",
        uuid: "00000000-0000-0000-0000-000000000012",
        timestamp: "2026-04-27T19:00:20.673Z",
        attachment: {
          type: "queued_command",
          prompt: 42 as unknown as string,
        },
      },
    ]);
    expect(updates.queued).toEqual([]);
    expect(updates.inTurn).toBe(false);
  });

  it("does not throw on a malformed object prompt", () => {
    expect(() =>
      processEvents("claude", EMPTY_SESSION, [
        {
          type: "attachment",
          uuid: "00000000-0000-0000-0000-000000000013",
          timestamp: "2026-04-27T19:00:20.673Z",
          attachment: {
            type: "queued_command",
            prompt: { text: "what now" } as unknown as string,
          },
        },
      ]),
    ).not.toThrow();
  });

  it("ignores empty or whitespace-only string prompts (was queueing prompt='')", () => {
    const updates = processEvents("claude", EMPTY_SESSION, [
      {
        type: "attachment",
        uuid: "00000000-0000-0000-0000-000000000015",
        timestamp: "2026-04-27T19:00:20.673Z",
        attachment: { type: "queued_command", prompt: "" },
      },
      {
        type: "attachment",
        uuid: "00000000-0000-0000-0000-000000000016",
        timestamp: "2026-04-27T19:00:20.674Z",
        attachment: { type: "queued_command", prompt: "   \n\t  " },
      },
    ]);
    expect(updates.queued).toEqual([]);
  });

  it("skips a task-notification prompt (system event, not user-queued)", () => {
    const updates = processEvents("claude", EMPTY_SESSION, [
      {
        type: "attachment",
        uuid: "00000000-0000-0000-0000-000000000014",
        timestamp: "2026-04-27T19:00:20.673Z",
        attachment: {
          type: "queued_command",
          prompt: "<task-notification>something</task-notification>",
        },
      },
    ]);
    expect(updates.queued).toEqual([]);
  });
});
