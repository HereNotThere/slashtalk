import { describe, it, expect } from "bun:test";
import { parseClaudeQuotaFromConfig, prettifyTier } from "../src/main/claudeQuotaParse";

describe("prettifyTier", () => {
  it("returns null for nullish or empty input", () => {
    expect(prettifyTier(null)).toBeNull();
    expect(prettifyTier(undefined)).toBeNull();
    expect(prettifyTier("")).toBeNull();
    expect(prettifyTier("   ")).toBeNull();
  });

  it("turns default_claude_max_5x into Max 5x (preserves Nx suffix lowercase)", () => {
    expect(prettifyTier("default_claude_max_5x")).toBe("Max 5x");
  });

  it("handles default_claude_max_20x", () => {
    expect(prettifyTier("default_claude_max_20x")).toBe("Max 20x");
  });

  it("handles default_claude_pro", () => {
    expect(prettifyTier("default_claude_pro")).toBe("Pro");
  });

  it("strips a leading claude_ when default_ is absent", () => {
    expect(prettifyTier("claude_team")).toBe("Team");
  });

  it("falls back to title-casing whatever's left when both prefixes are absent", () => {
    expect(prettifyTier("enterprise_v2")).toBe("Enterprise V2");
  });

  it("collapses repeated underscores cleanly", () => {
    expect(prettifyTier("default_claude__pro")).toBe("Pro");
  });
});

describe("parseClaudeQuotaFromConfig", () => {
  it("returns null when oauthAccount is missing", () => {
    expect(parseClaudeQuotaFromConfig({})).toBeNull();
    expect(parseClaudeQuotaFromConfig({ oauthAccount: null })).toBeNull();
  });

  it("returns null for non-object inputs", () => {
    expect(parseClaudeQuotaFromConfig(null)).toBeNull();
    expect(parseClaudeQuotaFromConfig("string")).toBeNull();
    expect(parseClaudeQuotaFromConfig([])).toBeNull();
  });

  it("extracts plan from organizationRateLimitTier on a Max account", () => {
    const out = parseClaudeQuotaFromConfig({
      oauthAccount: {
        organizationRateLimitTier: "default_claude_max_5x",
        userRateLimitTier: null,
        organizationType: "claude_max",
      },
    });
    expect(out).toEqual({ source: "claude", plan: "Max 5x", windows: [] });
  });

  it("falls back to userRateLimitTier when org tier is absent", () => {
    const out = parseClaudeQuotaFromConfig({
      oauthAccount: {
        organizationRateLimitTier: null,
        userRateLimitTier: "default_claude_pro",
      },
    });
    expect(out?.plan).toBe("Pro");
  });

  it("returns null when both tier fields are empty", () => {
    expect(
      parseClaudeQuotaFromConfig({
        oauthAccount: {
          organizationRateLimitTier: null,
          userRateLimitTier: null,
        },
      }),
    ).toBeNull();
  });

  it("ignores irrelevant fields on oauthAccount without breaking", () => {
    const out = parseClaudeQuotaFromConfig({
      oauthAccount: {
        accountUuid: "59d3e93d-6130-4b9d-ad87-d701f9226168",
        emailAddress: "user@example.com",
        organizationRateLimitTier: "default_claude_max_5x",
        billingType: "stripe_subscription",
        hasExtraUsageEnabled: false,
      },
    });
    expect(out?.plan).toBe("Max 5x");
  });
});
