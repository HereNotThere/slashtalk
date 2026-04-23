// HTTP client + credential management for the slashtalk backend.
// Lives in the main process so tokens never reach a renderer.
//
// Two credentials are managed in parallel:
//   - JWT + refresh token:   /api/me/* requests (browser-style auth)
//   - device API key:        /v1/devices/* writes (CLI-style auth)
//
// The desktop acquires the first via a GitHub OAuth loop (with a 127.0.0.1
// redirect) and the second by calling /api/me/setup-token -> /v1/auth/exchange
// on top of that session.

import { app, shell } from "electron";
import http from "node:http";
import os from "node:os";
import type { AddressInfo } from "node:net";
import type {
  ChatAskRequest,
  ChatAskResponse,
  ChatMessage,
  FeedSessionSnapshot,
  FeedUser,
  IngestResponse,
  SessionSnapshot,
  SyncStateEntry,
} from "@slashtalk/shared";
import type {
  BackendAuthState,
  BackendUser,
  RepoSummary,
  TeammateSummary,
} from "../shared/types";
import { createEmitter } from "./emitter";
import { saveEncrypted, loadEncrypted, clearEncrypted } from "./safeStore";

// `MAIN_VITE_SLASHTALK_API_URL` in apps/desktop/.env is baked in at build time
// by electron-vite (the MAIN_VITE_ prefix is what makes it visible to the main
// process). Runtime `SLASHTALK_API_URL` still works as an override for ad-hoc
// local testing. Unset → hosted default.
const BAKED_BASE_URL = import.meta.env.MAIN_VITE_SLASHTALK_API_URL as
  | string
  | undefined;
const DEFAULT_BASE_URL = "https://slashtalk.onrender.com";
const CREDS_KEY = "backendCredsEnc";

interface StoredCreds {
  jwt: string;
  refreshToken: string;
  apiKey: string;
  deviceId: number;
  user: BackendUser;
}

let creds: StoredCreds | null = null;
let pendingSignIn: { cancel: (reason: string) => void } | null = null;
const authChanges = createEmitter<BackendAuthState>();

function baseUrl(): string {
  return (
    process.env["SLASHTALK_API_URL"] ?? BAKED_BASE_URL ?? DEFAULT_BASE_URL
  );
}

export const onChange = authChanges.on;

export function getAuthState(): BackendAuthState {
  if (!creds) return { signedIn: false };
  return { signedIn: true, user: creds.user };
}

/** Current JWT — used by the WS client to authenticate the upgrade. May rotate
 *  on refresh, so callers should re-read on reconnect rather than caching. */
export function getJwt(): string | null {
  return creds?.jwt ?? null;
}

export function getBaseUrl(): string {
  return baseUrl();
}

function persistCreds(): void {
  if (creds) saveEncrypted(CREDS_KEY, creds);
  else clearEncrypted(CREDS_KEY);
}

export function restore(): void {
  creds = loadEncrypted<StoredCreds>(CREDS_KEY);
}

// ---------- Sign in ----------

interface CallbackParams {
  jwt: string;
  refreshToken: string;
  login: string;
}

function awaitLoopbackCallback(): Promise<CallbackParams> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end();
        return;
      }
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const jwt = url.searchParams.get("jwt");
      const refreshToken = url.searchParams.get("refreshToken");
      const login = url.searchParams.get("login");
      if (!jwt || !refreshToken || !login) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing parameters");
        return;
      }
      // Connection: close so HTTP keep-alive doesn't hold the socket open
      // after server.close(); we want the server fully gone.
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        Connection: "close",
      });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Signed in</title>` +
          `<style>body{font:-apple-system,BlinkMacSystemFont,sans-serif;padding:40px;text-align:center;color:#333}</style>` +
          `<h2>Signed in to slashtalk</h2><p>You can close this tab and return to the app.</p>` +
          `<script>setTimeout(()=>window.close(),500)</script>`,
      );
      finish();
      resolve({ jwt, refreshToken, login });
    });

    const timer = setTimeout(() => {
      finish();
      reject(new Error("Sign-in timed out"));
    }, 5 * 60 * 1000);

    const finish = (): void => {
      clearTimeout(timer);
      server.closeAllConnections?.();
      server.close();
      pendingSignIn = null;
    };

    pendingSignIn = {
      cancel: (reason) => {
        finish();
        reject(new Error(reason));
      },
    };

    server.on("error", (err) => {
      finish();
      reject(err);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr?.port) {
        finish();
        reject(new Error("Failed to bind loopback port"));
        return;
      }
      void shell.openExternal(
        `${baseUrl()}/auth/github?desktop_port=${addr.port}`,
      );
    });
  });
}

export async function signIn(): Promise<void> {
  if (pendingSignIn) throw new Error("Sign-in already in progress");

  const params = await awaitLoopbackCallback();

  // /api/me/ is independent of the device exchange — fetch it in parallel.
  const [exchange, me] = await Promise.all([
    (async () => {
      const setup = await jsonFetch<{ token: string }>("/api/me/setup-token", {
        method: "POST",
        auth: { jwt: params.jwt },
      });
      return jsonFetch<{ apiKey: string; deviceId: number }>("/v1/auth/exchange", {
        method: "POST",
        body: {
          token: setup.token,
          deviceName: os.hostname(),
          os: process.platform,
        },
      });
    })(),
    jsonFetch<{
      id: number;
      githubLogin: string;
      avatarUrl: string;
      displayName: string | null;
    }>("/api/me/", { method: "GET", auth: { jwt: params.jwt } }),
  ]);

  creds = {
    jwt: params.jwt,
    refreshToken: params.refreshToken,
    apiKey: exchange.apiKey,
    deviceId: exchange.deviceId,
    user: {
      githubLogin: me.githubLogin,
      avatarUrl: me.avatarUrl,
      displayName: me.displayName,
    },
  };
  persistCreds();
  authChanges.emit(getAuthState());
}

export function cancelSignIn(reason = "Cancelled"): void {
  pendingSignIn?.cancel(reason);
}

function clearLocalSession(): void {
  creds = null;
  persistCreds();
  authChanges.emit(getAuthState());
}

export async function signOut(): Promise<void> {
  const current = creds;
  clearLocalSession();
  if (current) {
    try {
      await jsonFetch("/auth/logout", {
        method: "POST",
        body: { refreshToken: current.refreshToken },
        auth: "none",
      });
    } catch {
      // best-effort; client-side state is already cleared
    }
  }
}

// ---------- HTTP ----------

type Auth =
  | "session" // default — use stored JWT, refresh on 401
  | "apiKey" // use stored device API key
  | "none" // no auth header
  | { jwt: string }; // explicit JWT override (used during sign-in)

interface FetchOpts {
  method: "GET" | "POST" | "DELETE";
  body?: unknown;
  auth?: Auth;
}

function logHttp(
  level: "log" | "warn" | "error",
  method: string,
  path: string,
  status: string,
  ms: number,
  detail?: string | unknown,
): void {
  // Stay quiet in packaged builds to avoid shipping request bodies to the
  // system logger; dev/unpackaged gets full visibility.
  if (app.isPackaged) return;
  const prefix = `[http] ${method} ${path} ${status} in ${ms}ms`;
  if (detail !== undefined) console[level](prefix, detail);
  else console[level](prefix);
}

function jsonFetch<T>(path: string, opts: FetchOpts): Promise<T> {
  return doJsonFetch<T>(path, opts, false);
}

async function doJsonFetch<T>(
  path: string,
  opts: FetchOpts,
  retried: boolean,
): Promise<T> {
  const auth: Auth = opts.auth ?? "session";
  const url = `${baseUrl()}${path}`;
  const headers: Record<string, string> = { Accept: "application/json" };

  if (auth === "apiKey") {
    if (!creds) throw new Error("Not signed in");
    headers["Authorization"] = `Bearer ${creds.apiKey}`;
  } else if (auth === "session") {
    if (creds) headers["Cookie"] = `session=${creds.jwt}`;
  } else if (typeof auth === "object") {
    headers["Cookie"] = `session=${auth.jwt}`;
  }

  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method, headers, body });
  } catch (err) {
    logHttp("error", opts.method, path, "network-error", Date.now() - started, err);
    throw err;
  }
  const ms = Date.now() - started;

  if (res.status === 401 && auth === "session" && creds && !retried) {
    logHttp("warn", opts.method, path, "401", ms, "— refreshing");
    const refreshed = await tryRefresh();
    if (refreshed) return doJsonFetch<T>(path, opts, true);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logHttp("error", opts.method, path, String(res.status), ms, text.slice(0, 500));
    throw new Error(`${opts.method} ${path} failed (${res.status}): ${text}`);
  }

  if (res.status === 204) {
    logHttp("log", opts.method, path, "204", ms);
    return undefined as T;
  }
  const text = await res.text();
  logHttp("log", opts.method, path, String(res.status), ms, `${text.length}B ${text.slice(0, 200)}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

// Single-flight guard: concurrent 401s (rail poll + repo list + heartbeat
// firing together at the ~1h expiry mark) must share one refresh attempt.
// Since each refresh rotates the stored token, parallel calls with the
// stale token would race and all-but-one would permanently fail.
let refreshInFlight: Promise<boolean> | null = null;

function tryRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const p = doRefresh().finally(() => {
    if (refreshInFlight === p) refreshInFlight = null;
  });
  refreshInFlight = p;
  return p;
}

async function doRefresh(): Promise<boolean> {
  const current = creds;
  if (!current) return false;
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ refreshToken: current.refreshToken }),
    });
  } catch (err) {
    logHttp("warn", "POST", "/auth/refresh", "network-error", Date.now() - started, err);
    return false; // transient — keep creds, retry on next 401
  }
  const ms = Date.now() - started;

  if (res.status === 401 || res.status === 403) {
    // Refresh token is gone for good (expired, revoked, or already rotated).
    // Clear creds so the UI flips to signed-out instead of looping forever.
    logHttp("warn", "POST", "/auth/refresh", String(res.status), ms, "— signing out");
    clearLocalSession();
    return false;
  }

  if (!res.ok) {
    logHttp("warn", "POST", "/auth/refresh", String(res.status), ms, "— transient");
    return false;
  }

  const data = (await res.json().catch(() => null)) as
    | { jwt?: string; refreshToken?: string }
    | null;
  if (!data?.jwt || !data.refreshToken) {
    logHttp("error", "POST", "/auth/refresh", "200", ms, "— malformed response");
    return false;
  }

  // Re-read creds: signOut() may have run while we were awaiting.
  if (!creds) return false;
  creds = { ...creds, jwt: data.jwt, refreshToken: data.refreshToken };
  persistCreds();
  return true;
}

// ---------- Public API ----------

export function listRepos(): Promise<RepoSummary[]> {
  return jsonFetch<RepoSummary[]>("/api/me/repos", { method: "GET" });
}

export function claimRepo(fullName: string): Promise<RepoSummary> {
  return jsonFetch<RepoSummary>("/api/me/repos", {
    method: "POST",
    body: { fullName },
  });
}

export async function listTeammates(): Promise<TeammateSummary[]> {
  console.log("[rail] GET /api/feed/users …");
  const raw = await jsonFetch<FeedUser[]>("/api/feed/users", { method: "GET" });
  console.log(`[rail] /api/feed/users → ${JSON.stringify(raw)}`);
  return raw.map((r) => ({
    githubLogin: r.github_login,
    avatarUrl: r.avatar_url ?? "",
    totalSessions: r.total_sessions,
    activeSessions: r.active_sessions,
    repos: r.repos,
  }));
}

export function listOwnSessions(): Promise<SessionSnapshot[]> {
  return jsonFetch<SessionSnapshot[]>("/api/sessions", { method: "GET" });
}

export function listFeedSessions(): Promise<FeedSessionSnapshot[]> {
  return jsonFetch<FeedSessionSnapshot[]>("/api/feed", { method: "GET" });
}

export function listFeedSessionsForUser(
  login: string,
): Promise<FeedSessionSnapshot[]> {
  const qs = new URLSearchParams({ user: login });
  return jsonFetch<FeedSessionSnapshot[]>(`/api/feed?${qs}`, { method: "GET" });
}

export function listFeedSessionsForRepo(
  fullName: string,
): Promise<FeedSessionSnapshot[]> {
  const qs = new URLSearchParams({ repo: fullName });
  return jsonFetch<FeedSessionSnapshot[]>(`/api/feed?${qs}`, { method: "GET" });
}

export function listDeviceRepos(): Promise<
  Array<{ repoId: number; fullName: string; localPath: string }>
> {
  if (!creds) throw new Error("Not signed in");
  return jsonFetch(`/v1/devices/${creds.deviceId}/repos`, {
    method: "GET",
    auth: "apiKey",
  });
}

export function postDeviceRepos(payload: {
  repoPaths: { repoId: number; localPath: string }[];
  excludedRepoIds: number[];
}): Promise<{ ok: true }> {
  if (!creds) throw new Error("Not signed in");
  return jsonFetch(`/v1/devices/${creds.deviceId}/repos`, {
    method: "POST",
    body: payload,
    auth: "apiKey",
  });
}

// ---------- Ingest / heartbeat ----------

export async function ingestChunk(args: {
  session: string;
  project: string;
  fromLineSeq: number;
  prefixHash: string;
  source?: "claude" | "codex";
  body: string;
}): Promise<IngestResponse> {
  if (!creds) throw new Error("Not signed in");
  const qs = new URLSearchParams({
    project: args.project,
    session: args.session,
    fromLineSeq: String(args.fromLineSeq),
    prefixHash: args.prefixHash,
    source: args.source ?? "claude",
  });
  const res = await fetch(`${baseUrl()}/v1/ingest?${qs.toString()}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${creds.apiKey}`,
      "Content-Type": "application/x-ndjson",
    },
    body: args.body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST /v1/ingest failed (${res.status}): ${text}`);
  }
  return (await res.json()) as IngestResponse;
}

export function fetchSyncState(): Promise<Record<string, SyncStateEntry>> {
  return jsonFetch<Record<string, SyncStateEntry>>("/v1/sync-state", {
    method: "GET",
    auth: "apiKey",
  });
}

// ---------- Chat ----------

export async function askChat(messages: ChatMessage[]): Promise<ChatAskResponse> {
  const body: ChatAskRequest = { messages };
  return jsonFetch<ChatAskResponse>("/api/chat/ask", {
    method: "POST",
    body,
  });
}

export function sendHeartbeat(body: {
  sessionId: string;
  pid?: number;
  kind?: string;
  cwd?: string;
  version?: string;
  startedAt?: string;
}): Promise<{ ok: true }> {
  return jsonFetch("/v1/heartbeat", {
    method: "POST",
    body,
    auth: "apiKey",
  });
}
