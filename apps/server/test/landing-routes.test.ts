import { describe, expect, it } from "bun:test";
import { relativeLandingPath } from "../src/landing/routes";

describe("landing route path mapping", () => {
  it("serves the index for the root", () => {
    expect(relativeLandingPath("/")).toBe("index.html");
    expect(relativeLandingPath("")).toBe("index.html");
  });

  it("maps known root files and astro assets", () => {
    expect(relativeLandingPath("/favicon.svg")).toBe("favicon.svg");
    expect(relativeLandingPath("/screenshot-dock.png")).toBe("screenshot-dock.png");
    expect(relativeLandingPath("/_astro/index.Bh7GsEwp.css")).toBe("_astro/index.Bh7GsEwp.css");
  });

  it("rejects unsafe or malformed paths", () => {
    expect(relativeLandingPath("/../secret")).toBeNull();
    expect(relativeLandingPath("/_astro/../../package.json")).toBeNull();
    expect(relativeLandingPath("/%252e%252e/secret")).toBeNull();
    expect(relativeLandingPath("/file:/etc/passwd")).toBeNull();
    expect(relativeLandingPath("/assets\\evil.js")).toBeNull();
    expect(relativeLandingPath("/%00")).toBeNull();
    expect(relativeLandingPath("/_astro//index.css")).toBeNull();
    expect(relativeLandingPath("no-leading-slash")).toBeNull();
  });
});
