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
