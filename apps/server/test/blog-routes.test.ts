import { describe, expect, it } from "bun:test";
import { relativeBlogPath } from "../src/web/blog-routes";

describe("blog route path mapping", () => {
  it("returns empty string for root blog routes", () => {
    expect(relativeBlogPath("/blog")).toBe("");
    expect(relativeBlogPath("/blog/")).toBe("");
  });

  it("strips trailing slashes from nested paths", () => {
    expect(relativeBlogPath("/blog/posts/")).toBe("posts");
    expect(relativeBlogPath("/blog/posts/hello-world/")).toBe("posts/hello-world");
    expect(relativeBlogPath("/blog/posts///")).toBe("posts");
  });

  it("preserves asset paths with extensions", () => {
    expect(relativeBlogPath("/blog/favicon.svg")).toBe("favicon.svg");
    expect(relativeBlogPath("/blog/_astro/index.abc123.css")).toBe("_astro/index.abc123.css");
  });

  it("rejects unsafe or malformed paths", () => {
    expect(relativeBlogPath("/api/feed")).toBeNull();
    expect(relativeBlogPath("/blog/posts//hello")).toBeNull();
    expect(relativeBlogPath("/blog/../secret")).toBeNull();
    expect(relativeBlogPath("/blog/%252e%252e/%252e%252e/package.json")).toBeNull();
    expect(relativeBlogPath("/blog/file:/etc/passwd")).toBeNull();
    expect(relativeBlogPath("/blog/https://example.com/app.js")).toBeNull();
    expect(relativeBlogPath("/blog/assets\\evil.js")).toBeNull();
    expect(relativeBlogPath("/blog/%00")).toBeNull();
  });
});
