import { describe, expect, it } from "bun:test";
import { relativeAppPath } from "../src/web/routes";

describe("web app route path mapping", () => {
  it("serves the SPA shell for root app routes", () => {
    expect(relativeAppPath("/app")).toBe("index.html");
    expect(relativeAppPath("/app/")).toBe("index.html");
  });

  it("allows trailing slashes on deep SPA routes", () => {
    expect(relativeAppPath("/app/sessions/")).toBe("sessions");
    expect(relativeAppPath("/app/sessions/example/")).toBe("sessions/example");
    expect(relativeAppPath("/app/settings///")).toBe("settings");
  });

  it("rejects unsafe or malformed paths", () => {
    expect(relativeAppPath("/api/feed")).toBeNull();
    expect(relativeAppPath("/app/sessions//example")).toBeNull();
    expect(relativeAppPath("/app/../secret")).toBeNull();
    expect(relativeAppPath("/app/%00")).toBeNull();
  });
});
