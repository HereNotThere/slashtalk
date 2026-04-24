import { describe, it, expect } from "bun:test";
import { classifyEvent } from "../src/ingest/classifier";

describe("classifier: claude", () => {
  it("classifies a plain user message", () => {
    const n = classifyEvent("claude", {
      type: "user",
      timestamp: "2026-04-22T10:00:00Z",
      uuid: "11111111-1111-1111-1111-111111111111",
      parentUuid: null,
      message: { role: "user", content: "hello" },
    });
    expect(n.kind).toBe("user_msg");
    expect(n.rawType).toBe("user");
    expect(n.eventId).toBe("11111111-1111-1111-1111-111111111111");
    expect(n.parentId).toBeNull();
  });

  it("classifies a user tool_result as tool_result", () => {
    const n = classifyEvent("claude", {
      type: "user",
      timestamp: "2026-04-22T10:00:00Z",
      uuid: "22222222-2222-2222-2222-222222222222",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_x" }],
      },
    });
    expect(n.kind).toBe("tool_result");
  });

  it("classifies a local-command user string as meta", () => {
    const n = classifyEvent("claude", {
      type: "user",
      timestamp: "2026-04-22T10:00:00Z",
      uuid: "33333333-3333-3333-3333-333333333333",
      message: { role: "user", content: "<local-command-name>/clear" },
    });
    expect(n.kind).toBe("meta");
  });

  it("classifies isMeta as meta regardless of type", () => {
    const n = classifyEvent("claude", {
      type: "user",
      timestamp: "2026-04-22T10:00:00Z",
      uuid: "44444444-4444-4444-4444-444444444444",
      isMeta: true,
      message: { role: "user", content: "x" },
    });
    expect(n.kind).toBe("meta");
  });

  it("classifies an assistant message", () => {
    const n = classifyEvent("claude", {
      type: "assistant",
      timestamp: "2026-04-22T10:00:00Z",
      uuid: "55555555-5555-5555-5555-555555555555",
      parentUuid: "44444444-4444-4444-4444-444444444444",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    expect(n.kind).toBe("assistant_msg");
    expect(n.parentId).toBe("44444444-4444-4444-4444-444444444444");
  });
});

describe("classifier: codex", () => {
  it("classifies session_meta as meta", () => {
    const n = classifyEvent("codex", {
      timestamp: "2026-04-20T09:13:20.812Z",
      type: "session_meta",
      payload: {
        id: "019daa29-60e5-7381-beb5-bcdea3a7dced",
        cwd: "/tmp",
      },
    });
    expect(n.kind).toBe("meta");
    expect(n.rawType).toBe("session_meta");
  });

  it("classifies task_started as turn_start and extracts turn_id", () => {
    const n = classifyEvent("codex", {
      timestamp: "2026-04-20T09:13:20.814Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "019daa2a-6e8e-70b3-a742-40e26c7183ee",
      },
    });
    expect(n.kind).toBe("turn_start");
    expect(n.turnId).toBe("019daa2a-6e8e-70b3-a742-40e26c7183ee");
  });

  it("classifies task_complete and turn_aborted as turn_end", () => {
    const done = classifyEvent("codex", {
      timestamp: "2026-04-20T09:14:00Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "t-1" },
    });
    const aborted = classifyEvent("codex", {
      timestamp: "2026-04-20T09:14:00Z",
      type: "event_msg",
      payload: { type: "turn_aborted", turn_id: "t-1" },
    });
    expect(done.kind).toBe("turn_end");
    expect(aborted.kind).toBe("turn_end");
  });

  it("classifies function_call as tool_call with call_id", () => {
    const n = classifyEvent("codex", {
      timestamp: "2026-04-20T09:13:25.490Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: "{}",
        call_id: "call_oVPbbNvq2SOgxHd8YN7WVADR",
      },
    });
    expect(n.kind).toBe("tool_call");
    expect(n.callId).toBe("call_oVPbbNvq2SOgxHd8YN7WVADR");
  });

  it("classifies function_call_output and exec_command_end as tool_result", () => {
    const out = classifyEvent("codex", {
      timestamp: "2026-04-20T09:13:25.616Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "c-1", output: "ok" },
    });
    const end = classifyEvent("codex", {
      timestamp: "2026-04-20T09:13:25.616Z",
      type: "event_msg",
      payload: {
        type: "exec_command_end",
        call_id: "c-1",
        turn_id: "t-1",
        exit_code: 0,
      },
    });
    expect(out.kind).toBe("tool_result");
    expect(end.kind).toBe("tool_result");
    expect(end.turnId).toBe("t-1");
  });

  it("classifies response_item message by role", () => {
    const user = classifyEvent("codex", {
      timestamp: "2026-04-20T09:13:20.815Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [] },
    });
    const assistant = classifyEvent("codex", {
      timestamp: "2026-04-20T09:13:25.489Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [] },
    });
    const developer = classifyEvent("codex", {
      timestamp: "2026-04-20T09:13:20.814Z",
      type: "response_item",
      payload: { type: "message", role: "developer", content: [] },
    });
    expect(user.kind).toBe("user_msg");
    expect(assistant.kind).toBe("assistant_msg");
    expect(developer.kind).toBe("system");
  });

  it("classifies reasoning", () => {
    const n = classifyEvent("codex", {
      timestamp: "2026-04-20T09:13:23.045Z",
      type: "response_item",
      payload: { type: "reasoning", summary: [], encrypted_content: "..." },
    });
    expect(n.kind).toBe("reasoning");
    expect(n.eventId).toBeNull();
  });

  it("classifies token_count as token_usage", () => {
    const n = classifyEvent("codex", {
      timestamp: "2026-04-20T09:13:25.616Z",
      type: "event_msg",
      payload: { type: "token_count", info: null, rate_limits: {} },
    });
    expect(n.kind).toBe("token_usage");
  });
});

describe("classifier: cursor", () => {
  it("classifies user and assistant transcript lines by role", () => {
    const user = classifyEvent("cursor", {
      timestamp: "2026-04-24T06:20:00Z",
      role: "user",
      message: { content: [{ type: "text", text: "hello" }] },
    });
    const assistant = classifyEvent("cursor", {
      timestamp: "2026-04-24T06:20:03Z",
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "Checking the uploader." },
          { type: "tool_use", name: "Read", input: { path: "/tmp/x.ts" } },
        ],
      },
    });
    expect(user.kind).toBe("user_msg");
    expect(user.rawType).toBe("user");
    expect(assistant.kind).toBe("assistant_msg");
    expect(assistant.rawType).toBe("assistant");
    expect(assistant.callId).toBeNull();
  });
});
