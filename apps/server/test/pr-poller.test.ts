import { describe, it, expect } from "bun:test";
import { toPrMessage, type GithubEvent } from "../src/social/pr-poller";

function ev(overrides: {
  type?: string;
  action?: string;
  merged?: boolean;
  title?: string;
  html_url?: string;
  prNumber?: number;
  payloadNumber?: number;
}): GithubEvent {
  return {
    id: "1",
    type: overrides.type ?? "PullRequestEvent",
    actor: { login: "alice" },
    repo: { name: "acme/widgets" },
    created_at: "2026-04-22T10:00:00Z",
    payload: {
      action: overrides.action,
      ...(overrides.payloadNumber != null && { number: overrides.payloadNumber }),
      pull_request: {
        ...(overrides.merged != null && { merged: overrides.merged }),
        ...(overrides.title != null && { title: overrides.title }),
        ...(overrides.html_url != null && { html_url: overrides.html_url }),
        ...(overrides.prNumber != null && { number: overrides.prNumber }),
      },
    },
  };
}

describe("pr-poller: toPrMessage", () => {
  it("maps action=opened to 'opened'", () => {
    const msg = toPrMessage(ev({ action: "opened", title: "Add login", prNumber: 42 }));
    expect(msg).not.toBeNull();
    expect(msg!.action).toBe("opened");
    expect(msg!.login).toBe("alice");
    expect(msg!.repoFullName).toBe("acme/widgets");
    expect(msg!.number).toBe(42);
    expect(msg!.title).toBe("Add login");
    expect(msg!.ts).toBe("2026-04-22T10:00:00Z");
  });

  it("maps action=reopened to 'opened' (single visual treatment)", () => {
    const msg = toPrMessage(ev({ action: "reopened", prNumber: 7 }));
    expect(msg?.action).toBe("opened");
  });

  it("maps closed + merged=true to 'merged'", () => {
    const msg = toPrMessage(ev({ action: "closed", merged: true, prNumber: 9 }));
    expect(msg?.action).toBe("merged");
  });

  it("returns null for closed + merged=false (just closed, no celebration)", () => {
    const msg = toPrMessage(ev({ action: "closed", merged: false }));
    expect(msg).toBeNull();
  });

  it("returns null for closed when 'merged' is missing", () => {
    const msg = toPrMessage(ev({ action: "closed" }));
    expect(msg).toBeNull();
  });

  it("returns null for non-PR event types", () => {
    const msg = toPrMessage(ev({ type: "PushEvent", action: "opened" }));
    expect(msg).toBeNull();
  });

  it("returns null for unhandled PR actions (e.g. edited, labeled)", () => {
    expect(toPrMessage(ev({ action: "edited" }))).toBeNull();
    expect(toPrMessage(ev({ action: "labeled" }))).toBeNull();
    expect(toPrMessage(ev({ action: "synchronize" }))).toBeNull();
  });

  it("returns null when payload.pull_request is missing entirely", () => {
    const e: GithubEvent = {
      id: "x",
      type: "PullRequestEvent",
      actor: { login: "alice" },
      repo: { name: "acme/widgets" },
      created_at: "2026-04-22T10:00:00Z",
      payload: { action: "opened" },
    };
    expect(toPrMessage(e)).toBeNull();
  });

  it("falls back to payload.number when pull_request.number is missing", () => {
    const msg = toPrMessage(ev({ action: "opened", payloadNumber: 13 }));
    expect(msg?.number).toBe(13);
  });

  it("synthesizes a repo URL when html_url is missing", () => {
    const msg = toPrMessage(ev({ action: "opened" }));
    expect(msg?.url).toBe("https://github.com/acme/widgets");
  });

  it("uses html_url verbatim when present", () => {
    const msg = toPrMessage(
      ev({ action: "opened", html_url: "https://github.com/acme/widgets/pull/5" }),
    );
    expect(msg?.url).toBe("https://github.com/acme/widgets/pull/5");
  });
});
