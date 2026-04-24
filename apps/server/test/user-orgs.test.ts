import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { db } from "../src/db";
import { createApp } from "../src/app";
import { RedisBridge } from "../src/ws/redis-bridge";
import { __clearOrgCaches } from "../src/user/routes";
import { resetDatabase, getCookie } from "./helpers";

let redis: RedisBridge;
let app: ReturnType<typeof createApp>;
let baseUrl: string;
let originalFetch: typeof globalThis.fetch;
let aliceCookie: string;

// Mock state (reset per-test)
let orgsFetchCount = 0;
let orgReposFetchCount = 0;
let orgsResponse: { status: number; body: unknown } = { status: 200, body: [] };
let orgReposPages: Array<{ status?: number; body: unknown; linkNext?: string }> = [];

const ALICE = {
  id: 9001,
  login: "alice",
  avatar_url: "https://avatars.test/alice",
  name: "Alice",
};

beforeAll(async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (url === "https://github.com/login/oauth/access_token") {
      return new Response(
        JSON.stringify({ access_token: "ghtoken_alice_code" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify(ALICE), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "https://api.github.com/user/orgs?per_page=100") {
      orgsFetchCount += 1;
      return new Response(JSON.stringify(orgsResponse.body ?? []), {
        status: orgsResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.startsWith("https://api.github.com/orgs/")) {
      orgReposFetchCount += 1;
      const page = orgReposPages.shift();
      if (!page) {
        return new Response("[]", {
          headers: { "Content-Type": "application/json" },
        });
      }
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (page.linkNext) {
        headers["Link"] = `<${page.linkNext}>; rel="next"`;
      }
      return new Response(JSON.stringify(page.body), {
        status: page.status ?? 200,
        headers,
      });
    }

    // Pass through (local server, etc.)
    return originalFetch(input, init);
  };

  await resetDatabase();
  redis = new RedisBridge();
  await redis.connect();
  app = createApp(db, redis);
  app.listen(0);
  const port = app.server!.port;
  baseUrl = `http://localhost:${port}`;

  // Sign alice in so she has an encrypted GitHub token in the DB.
  const res = await fetch(`${baseUrl}/auth/github/callback?code=alice_code`);
  expect(res.status).toBe(200);
  aliceCookie = getCookie(res, "session")!;
  expect(aliceCookie).toBeTruthy();
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  app.stop();
  await redis.disconnect();
});

beforeEach(() => {
  __clearOrgCaches();
  orgsFetchCount = 0;
  orgReposFetchCount = 0;
  orgsResponse = { status: 200, body: [] };
  orgReposPages = [];
});

function authed(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: { Cookie: aliceCookie },
  });
}

describe("GET /api/me/orgs", () => {
  it("maps the GitHub response to OrgSummary shape", async () => {
    orgsResponse = {
      status: 200,
      body: [
        { login: "acme", name: "Acme Co", avatar_url: "https://avatars/acme" },
        { login: "widgets", name: null, avatar_url: "https://avatars/widgets" },
      ],
    };

    const res = await authed("/api/me/orgs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      login: string;
      name: string | null;
      avatarUrl: string;
    }>;
    expect(body).toEqual([
      { login: "acme", name: "Acme Co", avatarUrl: "https://avatars/acme" },
      { login: "widgets", name: null, avatarUrl: "https://avatars/widgets" },
    ]);
  });

  it("returns [] when GitHub responds 401", async () => {
    orgsResponse = { status: 401, body: { message: "Bad credentials" } };
    const res = await authed("/api/me/orgs");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("caches the result — second call within TTL doesn't re-fetch", async () => {
    orgsResponse = {
      status: 200,
      body: [{ login: "acme", name: "Acme", avatar_url: "x" }],
    };
    await authed("/api/me/orgs");
    await authed("/api/me/orgs");
    expect(orgsFetchCount).toBe(1);
  });
});

describe("GET /api/me/orgs/:org/repos", () => {
  it("maps the GitHub response and skips archived repos", async () => {
    orgReposPages = [
      {
        body: [
          {
            id: 1,
            name: "alpha",
            full_name: "acme/alpha",
            owner: { login: "acme" },
            private: true,
            archived: false,
            permissions: { push: true, pull: true },
          },
          {
            id: 2,
            name: "beta",
            full_name: "acme/beta",
            owner: { login: "acme" },
            private: false,
            archived: true,
            permissions: { pull: true },
          },
          {
            id: 3,
            name: "gamma",
            full_name: "acme/gamma",
            owner: { login: "acme" },
            private: false,
            archived: false,
            permissions: { admin: true, maintain: true, push: true, pull: true },
          },
        ],
      },
    ];

    const res = await authed("/api/me/orgs/acme/repos");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      repoId: number;
      fullName: string;
      permission: string;
    }>;
    expect(body.length).toBe(2);
    expect(body[0]).toMatchObject({
      repoId: 1,
      fullName: "acme/alpha",
      permission: "push",
    });
    expect(body[1]).toMatchObject({
      repoId: 3,
      fullName: "acme/gamma",
      permission: "admin",
    });
  });

  it("follows the Link header across pages", async () => {
    orgReposPages = [
      {
        body: [
          {
            id: 1,
            name: "a",
            full_name: "acme/a",
            owner: { login: "acme" },
            permissions: { pull: true },
          },
        ],
        linkNext: "https://api.github.com/orgs/acme/repos?page=2&per_page=100",
      },
      {
        body: [
          {
            id: 2,
            name: "b",
            full_name: "acme/b",
            owner: { login: "acme" },
            permissions: { pull: true },
          },
        ],
      },
    ];

    const res = await authed("/api/me/orgs/acme/repos");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ repoId: number }>;
    expect(body.map((r) => r.repoId)).toEqual([1, 2]);
    expect(orgReposFetchCount).toBe(2);
  });

  it("rejects an org login with invalid characters", async () => {
    const res = await authed("/api/me/orgs/..%2Fetc/repos");
    expect(res.status).toBe(400);
    expect(orgReposFetchCount).toBe(0);
  });

  it("rejects an org login with a slash", async () => {
    const res = await authed("/api/me/orgs/foo%2Fbar/repos");
    expect(res.status).toBe(400);
    expect(orgReposFetchCount).toBe(0);
  });

  it("returns [] when GitHub responds 404", async () => {
    orgReposPages = [{ status: 404, body: { message: "Not Found" } }];
    const res = await authed("/api/me/orgs/acme/repos");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("caches the result — second call within TTL doesn't re-fetch", async () => {
    orgReposPages = [
      {
        body: [
          {
            id: 1,
            name: "a",
            full_name: "acme/a",
            owner: { login: "acme" },
            permissions: { pull: true },
          },
        ],
      },
    ];
    await authed("/api/me/orgs/acme/repos");
    // Refill — but cache should short-circuit and this should not be consumed.
    orgReposPages = [
      {
        body: [
          {
            id: 99,
            name: "nope",
            full_name: "acme/nope",
            owner: { login: "acme" },
            permissions: { pull: true },
          },
        ],
      },
    ];
    const res = await authed("/api/me/orgs/acme/repos");
    const body = (await res.json()) as Array<{ repoId: number }>;
    expect(body.map((r) => r.repoId)).toEqual([1]);
    expect(orgReposFetchCount).toBe(1);
  });
});
