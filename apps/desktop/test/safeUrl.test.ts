import { describe, it, expect } from "bun:test";
import { isSafeExternalUrl } from "../src/main/safeUrl";

describe("isSafeExternalUrl", () => {
  it("accepts https URLs", () => {
    expect(isSafeExternalUrl("https://open.spotify.com/track/abc")).toBe(true);
    expect(isSafeExternalUrl("https://github.com")).toBe(true);
  });

  it("accepts mailto URLs", () => {
    expect(isSafeExternalUrl("mailto:info@hntlabs.com")).toBe(true);
    expect(isSafeExternalUrl("mailto:info@hntlabs.com?subject=Feedback")).toBe(true);
  });

  it.each([
    ["http downgrade", "http://example.com"],
    ["file:// local read", "file:///etc/passwd"],
    ["javascript: scheme", "javascript:alert(1)"],
    ["data: scheme", "data:text/html,<script>alert(1)</script>"],
    ["custom OS handler", "smb://attacker.example/share"],
    ["empty string", ""],
    ["plain text", "not a url at all"],
    ["scheme-relative", "//example.com"],
    ["ftp", "ftp://example.com"],
  ])("rejects %s", (_label, raw) => {
    expect(isSafeExternalUrl(raw)).toBe(false);
  });

  it("rejects non-string inputs", () => {
    expect(isSafeExternalUrl(undefined)).toBe(false);
    expect(isSafeExternalUrl(null)).toBe(false);
    expect(isSafeExternalUrl(42)).toBe(false);
    expect(isSafeExternalUrl({ url: "https://x" })).toBe(false);
  });
});
