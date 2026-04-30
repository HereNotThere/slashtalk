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
  ChatDelegatedWorkRequest,
  ChatDelegatedWorkResponse,
  ChatHistoryResponse,
  ChatMessage,
  DashboardScope,
  FeedSessionSnapshot,
  FeedUser,
  IngestResponse,
  IngestSelfPrEntry,
  IngestSelfPrsRequest,
  IngestSelfPrsResponse,
  ProjectOverviewResponse,
  SessionSnapshot,
  SpotifyPresence,
  StandupResponse,
  SyncStateEntry,
  UserPrsResponse,
} from "@slashtalk/shared";
import type {
  BackendAuthState,
  BackendUser,
  RepoSummary,
  TeammateSummary,
  UserLocation,
} from "../shared/types";
import { createEmitter } from "./emitter";
import { saveEncrypted, loadEncrypted, clearEncrypted } from "./safeStore";
import { apiBaseUrl } from "./config";

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

export const onChange = authChanges.on;

export function getAuthState(): BackendAuthState {
  if (!creds) return { signedIn: false };
  return { signedIn: true, user: creds.user };
}

export function isSelf(login: string | null): boolean {
  return !!login && creds?.user.githubLogin === login;
}

/** Current JWT — used by the WS client to authenticate the upgrade. May rotate
 *  on refresh, so callers should re-read on reconnect rather than caching. */
export function getJwt(): string | null {
  return creds?.jwt ?? null;
}

/** Device-scoped API key minted by /v1/auth/exchange during signIn. This is
 *  what the MCP backend expects as Bearer. */
export function getApiKey(): string | null {
  return creds?.apiKey ?? null;
}

function persistCreds(): void {
  if (creds) saveEncrypted(CREDS_KEY, creds);
  else clearEncrypted(CREDS_KEY);
}

export function restore(): void {
  creds = loadEncrypted<StoredCreds>(CREDS_KEY);
}

export async function validateStoredSession(): Promise<void> {
  if (!creds) return;

  try {
    await jsonFetch("/api/me/", { method: "GET" });
  } catch (err) {
    if (!creds) return;
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      clearLocalSession();
      return;
    }
    console.warn("[auth] stored session validation skipped:", err);
    return;
  }

  if (!creds) return;
  try {
    await listDeviceRepos();
  } catch (err) {
    if (!creds) return;
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      clearLocalSession();
      return;
    }
    console.warn("[auth] stored device validation skipped:", err);
  }
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
      res.end(signedInHtml(login));
      finish();
      resolve({ jwt, refreshToken, login });
    });

    const timer = setTimeout(
      () => {
        finish();
        reject(new Error("Sign-in timed out"));
      },
      5 * 60 * 1000,
    );

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
      void shell.openExternal(`${apiBaseUrl()}/auth/github?desktop_port=${addr.port}`);
    });
  });
}

function signedInHtml(login: string): string {
  const escapedLogin = escapeHtml(login);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Signed in · Slashtalk</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #101312;
      --panel: #181d1a;
      --panel-border: rgba(255, 255, 255, 0.10);
      --text: #f2f5f3;
      --muted: #9ba5a0;
      --accent: #2ecf81;
      --accent-ink: #07150d;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f7f8f5;
        --panel: #ffffff;
        --panel-border: rgba(17, 24, 39, 0.10);
        --text: #171a18;
        --muted: #68716b;
        --accent-ink: #ffffff;
      }
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      background:
        radial-gradient(circle at 50% 0%, rgba(46, 207, 129, 0.14), transparent 34%),
        var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    main {
      width: min(420px, 100%);
      padding: 28px;
      border: 1px solid var(--panel-border);
      border-radius: 14px;
      background: var(--panel);
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.22);
      text-align: center;
    }
    .mark {
      width: 48px;
      height: 48px;
      margin: 0 auto 18px;
      display: grid;
      place-items: center;
      border-radius: 14px;
      background: var(--accent);
      color: var(--accent-ink);
      font-size: 27px;
      font-weight: 800;
    }
    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.18;
      letter-spacing: 0;
    }
    p {
      margin: 8px 0 0;
      color: var(--muted);
      line-height: 1.45;
    }
    .account {
      margin-top: 18px;
      padding: 10px 12px;
      border-radius: 8px;
      background: rgba(148, 163, 184, 0.10);
      color: var(--text);
      font-size: 14px;
    }
    .brand {
      margin-top: 22px;
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0;
    }
  </style>
</head>
<body>
  <main>
    <div class="mark">✓</div>
    <h1>Signed in to Slashtalk</h1>
    <p>You can return to the desktop app.</p>
    <div class="account">@${escapedLogin}</div>
    <div class="brand">This tab will close automatically.</div>
  </main>
  <script>setTimeout(() => window.close(), 900);</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
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

export async function signOutEverywhere(): Promise<void> {
  if (!creds) return;
  try {
    await jsonFetch("/auth/logout-everywhere", { method: "POST" });
  } finally {
    clearLocalSession();
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

const HTTP_ERROR_PREVIEW_CHARS = 240;

function responsePreview(body: string): string {
  const text = body
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const preview = text || body.replace(/\s+/g, " ").trim() || "empty response";
  return preview.length > HTTP_ERROR_PREVIEW_CHARS
    ? `${preview.slice(0, HTTP_ERROR_PREVIEW_CHARS)}…`
    : preview;
}

/** Thrown by `jsonFetch` on any non-2xx response after the single-flight
 *  JWT-refresh has been tried. Extends `Error` so older callers that just
 *  read `.message` keep working; new callers can read `status` and `body`
 *  to branch on structured server errors without regexing the message. */
export class HttpError extends Error {
  readonly status: number;
  readonly body!: string;
  constructor(status: number, body: string, method: string, path: string) {
    super(`${method} ${path} failed (${status}): ${responsePreview(body)}`);
    this.name = "HttpError";
    this.status = status;
    // Body can be a multi-KB WAF block page or HTML error doc; mark it
    // non-enumerable so `console.error(err)` / `util.inspect` doesn't dump
    // the whole thing into the terminal each retry. Still accessible via
    // `err.body` for callers that want to parse it (see parseClaimError).
    Object.defineProperty(this, "body", { value: body, enumerable: false });
  }
}

function jsonFetch<T>(path: string, opts: FetchOpts): Promise<T> {
  return doJsonFetch<T>(path, opts, false);
}

async function doJsonFetch<T>(path: string, opts: FetchOpts, retried: boolean): Promise<T> {
  const auth: Auth = opts.auth ?? "session";
  const url = `${apiBaseUrl()}${path}`;
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

  if (res.status === 401 && auth === "apiKey" && creds) {
    logHttp("warn", opts.method, path, "401", ms, "— signing out");
    clearLocalSession();
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logHttp("error", opts.method, path, String(res.status), ms, responsePreview(text));
    throw new HttpError(res.status, text, opts.method, path);
  }

  if (res.status === 204) {
    logHttp("log", opts.method, path, "204", ms);
    return undefined as T;
  }
  const text = await res.text();
  logHttp(
    "log",
    opts.method,
    path,
    String(res.status),
    ms,
    `${text.length}B ${text.slice(0, 200)}`,
  );
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
    res = await fetch(`${apiBaseUrl()}/auth/refresh`, {
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

  const data = (await res.json().catch(() => null)) as {
    jwt?: string;
    refreshToken?: string;
  } | null;
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

/** Thrown by `claimRepo` with the server's structured error kind so callers
 *  (e.g. the tray UI) can branch on `no_access` vs `token_expired` rather
 *  than regexing the message. */
export class ClaimRepoError extends Error {
  constructor(
    public readonly kind:
      | "no_access"
      | "token_expired"
      | "rate_limited"
      | "invalid_full_name"
      | "upstream_unavailable"
      | "unknown",
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ClaimRepoError";
  }
}

type ClaimRepoErrorKind = ClaimRepoError["kind"];

function isClaimRepoErrorKind(value: unknown): value is ClaimRepoErrorKind {
  return (
    value === "no_access" ||
    value === "token_expired" ||
    value === "rate_limited" ||
    value === "invalid_full_name" ||
    value === "upstream_unavailable" ||
    value === "unknown"
  );
}

export async function claimRepo(fullName: string): Promise<RepoSummary> {
  try {
    // Delegates to `jsonFetch` so the JWT single-flight refresh-on-401
    // (doJsonFetch line 318) still runs before we treat a 401 as GitHub-side
    // token_expired. Without this, a slashtalk-JWT expiry during a claim
    // would misfire as "your GitHub token is stale."
    return await jsonFetch<RepoSummary>("/api/me/repos", {
      method: "POST",
      body: { fullName },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      const parsed = parseClaimError(err.body);
      const kind = isClaimRepoErrorKind(parsed?.error) ? parsed.error : "unknown";
      throw new ClaimRepoError(kind, parsed?.message ?? `Claim failed (${err.status})`, err.status);
    }
    throw err;
  }
}

/** Drop the caller's `user_repos` row for this repo. Pairs with `claimRepo`
 *  — without this, "remove from settings" only nukes the local path, leaving
 *  the server-side claim and so feed/dashboard/PR-poller still see the repo
 *  as theirs. */
export async function unclaimRepo(repoId: number): Promise<void> {
  await jsonFetch<{ ok: boolean }>(`/api/me/repos/${encodeURIComponent(String(repoId))}`, {
    method: "DELETE",
  });
}

interface ClaimErrorBody {
  error?: string;
  message?: string;
}

function parseClaimError(body: string): ClaimErrorBody | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as ClaimErrorBody;
  } catch {
    return null;
  }
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

export function listFeedSessionsForUser(login: string): Promise<FeedSessionSnapshot[]> {
  const qs = new URLSearchParams({ user: login });
  return jsonFetch<FeedSessionSnapshot[]>(`/api/feed?${qs}`, { method: "GET" });
}

/** Pushes the caller's own PRs (sourced from local `gh`) to the server so
 *  `pull_requests` is fresh enough for the standup composer. Server filters
 *  to caller-authored / known-repo entries — see pr-ingest-routes.ts. */
export function pushSelfPrs(prs: IngestSelfPrEntry[]): Promise<IngestSelfPrsResponse> {
  const body: IngestSelfPrsRequest = { prs };
  return jsonFetch<IngestSelfPrsResponse>("/v1/me/prs", {
    method: "POST",
    body,
    auth: "apiKey",
  });
}

export function fetchUserStandup(login: string, scope: DashboardScope): Promise<StandupResponse> {
  const qs = new URLSearchParams({ scope });
  return jsonFetch<StandupResponse>(`/api/users/${encodeURIComponent(login)}/standup?${qs}`, {
    method: "GET",
  });
}

/** Server-side PRs for peer user-cards (self uses local `gh`, see ghPrs.ts). */
export function fetchUserPrs(login: string, scope: DashboardScope): Promise<UserPrsResponse> {
  const qs = new URLSearchParams({ scope });
  return jsonFetch<UserPrsResponse>(`/api/users/${encodeURIComponent(login)}/prs?${qs}`, {
    method: "GET",
  });
}

export function fetchProjectOverview(
  repoFullName: string,
  scope: DashboardScope,
): Promise<ProjectOverviewResponse> {
  const qs = new URLSearchParams({ scope });
  // repoFullName splits at the LAST slash — owner can't contain "/", but name
  // can theoretically (GitHub doesn't allow it but be defensive).
  const slash = repoFullName.indexOf("/");
  if (slash < 0) throw new Error(`fetchProjectOverview: bad repoFullName "${repoFullName}"`);
  const owner = repoFullName.slice(0, slash);
  const name = repoFullName.slice(slash + 1);
  return jsonFetch<ProjectOverviewResponse>(
    `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/overview?${qs}`,
    { method: "GET" },
  );
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
  source?: "claude" | "codex" | "cursor";
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
  const res = await fetch(`${apiBaseUrl()}/v1/ingest?${qs.toString()}`, {
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
    throw new HttpError(res.status, text, "POST", "/v1/ingest");
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

export async function askChat(
  messages: ChatMessage[],
  threadId?: string,
): Promise<ChatAskResponse> {
  const body: ChatAskRequest = { messages, threadId };
  return jsonFetch<ChatAskResponse>("/api/chat/ask", {
    method: "POST",
    body,
  });
}

export async function fetchChatHistory(): Promise<ChatHistoryResponse> {
  return jsonFetch<ChatHistoryResponse>("/api/chat/history", { method: "GET" });
}

export async function answerDelegatedWork(input: {
  threadId: string;
  body: ChatDelegatedWorkRequest;
}): Promise<ChatDelegatedWorkResponse> {
  return jsonFetch<ChatDelegatedWorkResponse>(
    `/api/chat/threads/${encodeURIComponent(input.threadId)}/delegated-work`,
    {
      method: "POST",
      body: input.body,
    },
  );
}

export async function fetchChatGerunds(prompt: string): Promise<string[]> {
  const fallback = ["Thinking"];
  try {
    const res = await jsonFetch<{ words?: unknown }>("/api/chat/gerund", {
      method: "POST",
      body: { prompt },
    });
    if (!Array.isArray(res.words)) return fallback;
    const words = res.words.filter((w): w is string => typeof w === "string" && w.length > 0);
    return words.length > 0 ? words : fallback;
  } catch {
    return fallback;
  }
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

// ---------- Spotify presence ----------

export function postSpotifyPresence(
  track: Omit<SpotifyPresence, "updatedAt"> | null,
): Promise<{ ok: true }> {
  return jsonFetch("/v1/presence/spotify", {
    method: "POST",
    body: { track },
    auth: "apiKey",
  });
}

export function listPeerPresence(): Promise<Record<string, SpotifyPresence>> {
  return jsonFetch<Record<string, SpotifyPresence>>("/api/presence/peers", {
    method: "GET",
  });
}

// ---------- User location ----------

export function postUserLocation(body: UserLocation): Promise<{ ok: true }> {
  return jsonFetch("/v1/me/location", {
    method: "POST",
    body,
    auth: "apiKey",
  });
}

export function listPeerLocations(): Promise<Record<string, UserLocation>> {
  return jsonFetch<Record<string, UserLocation>>("/api/presence/locations", {
    method: "GET",
  });
}
