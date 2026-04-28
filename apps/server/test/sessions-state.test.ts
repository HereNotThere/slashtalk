import { describe, it, expect } from "bun:test";
import { SessionState } from "@slashtalk/shared";
import { classifySessionState } from "../src/sessions/state";

const NOW = new Date("2026-04-28T12:00:00Z");
const sec = (s: number): Date => new Date(NOW.getTime() - s * 1000);

describe("classifySessionState", () => {
  it("BUSY when heartbeat fresh, in_turn, and last event recent", () => {
    expect(
      classifySessionState({
        heartbeatUpdatedAt: sec(5),
        inTurn: true,
        lastTs: sec(5),
        now: NOW,
      }),
    ).toBe(SessionState.BUSY);
  });

  it("ACTIVE when heartbeat fresh, not in_turn, last event <30s", () => {
    expect(
      classifySessionState({
        heartbeatUpdatedAt: sec(5),
        inTurn: false,
        lastTs: sec(10),
        now: NOW,
      }),
    ).toBe(SessionState.ACTIVE);
  });

  it("IDLE when heartbeat fresh but no recent event", () => {
    expect(
      classifySessionState({
        heartbeatUpdatedAt: sec(5),
        inTurn: false,
        lastTs: sec(120),
        now: NOW,
      }),
    ).toBe(SessionState.IDLE);
  });

  it("RECENT when heartbeat stale but last event <1h", () => {
    expect(
      classifySessionState({
        heartbeatUpdatedAt: sec(120),
        inTurn: false,
        lastTs: sec(600),
        now: NOW,
      }),
    ).toBe(SessionState.RECENT);
  });

  it("ENDED when heartbeat stale and last event >1h", () => {
    expect(
      classifySessionState({
        heartbeatUpdatedAt: sec(7200),
        inTurn: false,
        lastTs: sec(7200),
        now: NOW,
      }),
    ).toBe(SessionState.ENDED);
  });

  it("ENDED when no heartbeat and no events", () => {
    expect(
      classifySessionState({
        heartbeatUpdatedAt: null,
        inTurn: false,
        lastTs: null,
        now: NOW,
      }),
    ).toBe(SessionState.ENDED);
  });

  // Regression: a session whose in_turn flag was never cleared (process killed
  // mid-turn, stop_reason other than end_turn, queued_command never started)
  // must not stay BUSY forever just because the desktop heartbeat keeps firing.
  it("does not stick BUSY when in_turn is true but events are stale (>10min)", () => {
    expect(
      classifySessionState({
        heartbeatUpdatedAt: sec(5),
        inTurn: true,
        lastTs: sec(86400), // 1 day ago
        now: NOW,
      }),
    ).toBe(SessionState.IDLE);
  });

  it("BUSY at the edge: in_turn with last event just under 10min", () => {
    expect(
      classifySessionState({
        heartbeatUpdatedAt: sec(5),
        inTurn: true,
        lastTs: sec(599),
        now: NOW,
      }),
    ).toBe(SessionState.BUSY);
  });

  it("falls out of BUSY at the 10min boundary even with in_turn=true", () => {
    expect(
      classifySessionState({
        heartbeatUpdatedAt: sec(5),
        inTurn: true,
        lastTs: sec(601),
        now: NOW,
      }),
    ).toBe(SessionState.IDLE);
  });

  it("IDLE when heartbeat fresh, in_turn, but lastTs is null", () => {
    expect(
      classifySessionState({
        heartbeatUpdatedAt: sec(5),
        inTurn: true,
        lastTs: null,
        now: NOW,
      }),
    ).toBe(SessionState.IDLE);
  });
});
