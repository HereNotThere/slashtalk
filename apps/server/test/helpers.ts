import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../src/db";

// ── Mock GitHub OAuth ────────────────────────────────────────

interface MockUser {
  id: number;
  login: string;
  avatar_url: string;
  name: string;
}

const MOCK_USERS: Record<string, MockUser> = {
  alice_code: {
    id: 1001,
    login: "alice",
    avatar_url: "https://avatars.test/alice",
    name: "Alice",
  },
  bob_code: {
    id: 1002,
    login: "bob",
    avatar_url: "https://avatars.test/bob",
    name: "Bob",
  },
};

let originalFetch: typeof globalThis.fetch;

export function mockGitHubAuth(): () => void {
  originalFetch = globalThis.fetch;

  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // Mock GitHub OAuth token exchange
    if (url === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(init?.body as string);
      if (MOCK_USERS[body.code]) {
        return new Response(JSON.stringify({ access_token: `ghtoken_${body.code}` }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "bad_verification_code" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Mock GitHub user API
    if (url === "https://api.github.com/user") {
      const headers = init?.headers as Record<string, string> | undefined;
      const auth = headers?.Authorization || headers?.authorization || "";
      const match = auth.match(/Bearer ghtoken_(.+)/);
      if (match && MOCK_USERS[match[1]]) {
        return new Response(JSON.stringify(MOCK_USERS[match[1]]), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Unauthorized", { status: 401 });
    }

    // Pass through everything else (local server requests, etc.)
    return originalFetch(input, init);
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

// ── Database Schema ──────────────────────────────────────────

const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

export async function resetDatabase() {
  await db.execute(sql`SET client_min_messages = WARNING`);
  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

// ── Test Helpers ─────────────────────────────────────────────

export function getCookie(res: Response, name: string): string | null {
  const header = res.headers.get("set-cookie") || "";
  // May have multiple cookies separated by comma in some runtimes
  const cookies = header.split(",").map((s) => s.trim());
  for (const c of cookies) {
    if (c.startsWith(`${name}=`)) {
      return c.split(";")[0]; // "name=value"
    }
  }
  return null;
}

export function makeEvent(
  overrides: Partial<{
    uuid: string;
    type: string;
    timestamp: string;
    sessionId: string;
    parentUuid: string | null;
  }> = {},
) {
  return {
    uuid: overrides.uuid ?? crypto.randomUUID(),
    type: overrides.type ?? "user",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    sessionId: overrides.sessionId ?? crypto.randomUUID(),
    parentUuid: overrides.parentUuid ?? null,
    message: { content: "test message" },
  };
}

export function makeNdjson(events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
