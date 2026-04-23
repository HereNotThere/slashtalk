// Simplified GitHub OAuth shortcut for first-party Electron clients.
// Skips DCR + PKCE (which Claude Code must do as a third-party client) in
// favor of a loopback callback — the client starts a local HTTP server on a
// random port, opens the browser to /auth/electron/start?port=N, and we
// redirect the eventual GitHub-auth'd user to http://127.0.0.1:N/cb with the
// issued app token as a query param.

import { issueToken, randomState, type AuthConfig } from "./auth.ts";
import { exchangeCode, fetchGithubUser } from "./github-oauth.ts";
import { log } from "./server.ts";

const STATE_PREFIX = "el_";
const PENDING_TTL_MS = 10 * 60_000;

interface PendingElectronAuth {
  port: number;
  tz?: string;
  createdAt: number;
}

// Loose IANA timezone validation — just keep it sane, not exhaustive.
function isValidTz(s: string): boolean {
  return s.length > 0 && s.length <= 64 && /^[A-Za-z0-9_+\-/]+$/.test(s);
}

const pending = new Map<string, PendingElectronAuth>();

function sweep(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [k, v] of pending) if (v.createdAt < cutoff) pending.delete(k);
}

export function handleElectronStart(config: AuthConfig, url: URL): Response {
  sweep();
  const portStr = url.searchParams.get("port");
  const port = Number(portStr);
  if (!portStr || !Number.isInteger(port) || port < 1024 || port > 65535) {
    return new Response("invalid port", { status: 400 });
  }

  const tzRaw = url.searchParams.get("tz");
  const tz = tzRaw && isValidTz(tzRaw) ? tzRaw : undefined;

  const state = `${STATE_PREFIX}${randomState()}`;
  pending.set(state, { port, tz, createdAt: Date.now() });

  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.searchParams.set("client_id", config.githubClientId);
  gh.searchParams.set("redirect_uri", `${config.publicUrl}/auth/github/callback`);
  gh.searchParams.set("scope", "read:user");
  gh.searchParams.set("state", state);
  gh.searchParams.set("allow_signup", "true");
  return Response.redirect(gh.toString(), 302);
}

// If the GitHub callback's state belongs to the Electron flow, complete it and
// return a Response. Returns null otherwise, so the caller can fall through
// to the MCP-OAuth callback handler.
export async function tryHandleElectronCallback(
  config: AuthConfig,
  url: URL,
): Promise<Response | null> {
  sweep();
  const state = url.searchParams.get("state");
  if (!state || !state.startsWith(STATE_PREFIX)) return null;

  const entry = pending.get(state);
  pending.delete(state);
  if (!entry) {
    return new Response("invalid or expired state", { status: 400 });
  }

  const ghError = url.searchParams.get("error");
  if (ghError) {
    return redirectToLoopback(entry.port, { error: ghError });
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return redirectToLoopback(entry.port, { error: "missing_code" });
  }

  try {
    const accessToken = await exchangeCode(config, code);
    const ghUser = await fetchGithubUser(accessToken);
    const token = issueToken(config, {
      sub: ghUser.login,
      gid: ghUser.id,
      name: ghUser.name ?? undefined,
      avatar: ghUser.avatar_url,
      tz: entry.tz,
    });
    log("info", "electron_auth_success", {
      login: ghUser.login,
      gid: ghUser.id,
      tz: entry.tz,
    });
    return redirectToLoopback(entry.port, {
      token,
      login: ghUser.login,
      name: ghUser.name ?? "",
      avatar: ghUser.avatar_url,
    });
  } catch (e) {
    log("error", "electron_auth_failed", { err: String(e) });
    return redirectToLoopback(entry.port, { error: "server_error" });
  }
}

function redirectToLoopback(
  port: number,
  params: Record<string, string>,
): Response {
  const url = new URL(`http://127.0.0.1:${port}/cb`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return Response.redirect(url.toString(), 302);
}
