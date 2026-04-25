import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db } from "../src/db";
import { users } from "../src/db/schema";
import { RedisBridge } from "../src/ws/redis-bridge";
import { getCookie, resetDatabase } from "./helpers";

let redis: RedisBridge;
let app: ReturnType<typeof createApp>;
let baseUrl: string;
let originalFetch: typeof globalThis.fetch;

const ALICE = {
  id: 9101,
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
      const body = JSON.parse(init?.body as string);
      if (body.code === "alice_code") {
        return new Response(JSON.stringify({ access_token: "ghtoken_alice" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (body.code === "github_app_code") {
        return new Response(
          JSON.stringify({
            access_token: "ghu_app_alice",
            expires_in: 28_800,
            refresh_token: "ghr_app_alice",
            refresh_token_expires_in: 15_768_000,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "bad_verification_code" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify(ALICE), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return originalFetch(input, init);
  };

  await resetDatabase();
  redis = new RedisBridge();
  await redis.connect();
  app = createApp(db, redis);
  app.listen(0);
  baseUrl = `http://localhost:${app.server!.port}`;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  app.stop();
  await redis.disconnect();
});

describe("GitHub App authorization", () => {
  it("routes unauthenticated users through Slashtalk sign-in first", async () => {
    const res = await fetch(`${baseUrl}/auth/github-app`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/auth/github?return_to=%2Fauth%2Fgithub-app",
    );
  });

  it("stores encrypted GitHub App user tokens for the signed-in user", async () => {
    const signIn = await fetch(`${baseUrl}/auth/github/callback?code=alice_code`);
    const sessionCookie = getCookie(signIn, "session")!;
    expect(sessionCookie).toBeTruthy();

    const start = await fetch(`${baseUrl}/auth/github-app`, {
      headers: { Cookie: sessionCookie },
      redirect: "manual",
    });
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location")!);
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(
      config.githubAppClientId,
    );
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost:10000/auth/github-app/callback",
    );
    const state = location.searchParams.get("state");
    expect(state).toBeTruthy();
    const stateCookie = getCookie(start, "github_app_state")!;

    const callback = await fetch(
      `${baseUrl}/auth/github-app/callback?code=github_app_code&state=${state}`,
      { headers: { Cookie: `${sessionCookie}; ${stateCookie}` } },
    );
    expect(callback.status).toBe(200);

    const [alice] = await db
      .select()
      .from(users)
      .where(eq(users.githubLogin, "alice"));
    expect(alice.githubAppUserToken).toBeTruthy();
    expect(alice.githubAppRefreshToken).toBeTruthy();
    expect(alice.githubAppTokenExpiresAt).toBeTruthy();
    expect(alice.githubAppConnectedAt).toBeTruthy();

    const status = await fetch(`${baseUrl}/api/me/github-app/status`, {
      headers: { Cookie: sessionCookie },
    });
    expect(status.status).toBe(200);
    const body = (await status.json()) as {
      configured: boolean;
      connected: boolean;
      installUrl: string;
      connectUrl: string;
    };
    expect(body.configured).toBe(true);
    expect(body.connected).toBe(true);
    expect(body.installUrl).toBe(
      `https://github.com/apps/${config.githubAppSlug}/installations/new`,
    );
    expect(body.connectUrl).toBe("http://localhost:10000/auth/github-app");
  });

  it("can still start the installation flow explicitly", async () => {
    const signIn = await fetch(`${baseUrl}/auth/github/callback?code=alice_code`);
    const sessionCookie = getCookie(signIn, "session")!;

    const start = await fetch(`${baseUrl}/auth/github-app?install=1`, {
      headers: { Cookie: sessionCookie },
      redirect: "manual",
    });

    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location")!);
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe(
      `/apps/${config.githubAppSlug}/installations/new`,
    );
    expect(location.searchParams.get("state")).toBeTruthy();
  });
});
