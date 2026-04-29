import { describe, expect, it } from "bun:test";
import { isAllowedCookieWebSocketOrigin } from "../src/ws/handler";

describe("WebSocket cookie auth origin guard", () => {
  it("allows the configured app origin", () => {
    expect(isAllowedCookieWebSocketOrigin("http://localhost:10000")).toBe(true);
  });

  it("rejects missing, invalid, and cross-site origins", () => {
    expect(isAllowedCookieWebSocketOrigin(undefined)).toBe(false);
    expect(isAllowedCookieWebSocketOrigin("not a url")).toBe(false);
    expect(isAllowedCookieWebSocketOrigin("https://evil.example")).toBe(false);
  });

  it("allows loopback Vite origins when the API is running on loopback", () => {
    expect(isAllowedCookieWebSocketOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedCookieWebSocketOrigin("http://127.0.0.1:5173")).toBe(true);
  });
});
