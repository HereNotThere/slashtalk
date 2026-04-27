// GitHub OAuth Device Flow for end-user GitHub MCP access.
//
// RFC 8628 "Device Authorization Grant" — designed for installed apps. No
// client secret needed; we ship only the GITHUB_CLIENT_ID (public identifier).
//
// Flow:
//   1. POST /login/device/code  → { user_code, device_code, verification_uri }
//   2. Show user_code to the user + open verification_uri in the browser.
//   3. Poll /login/oauth/access_token every `interval` seconds until the user
//      approves (or the code expires).
//   4. Persist { access_token, refresh_token } in safeStore. Anthropic's vault
//      will refresh the access_token on our behalf via client_id alone
//      (token_endpoint_auth: "none") — device-flow OAuth Apps are public.
//
// User-visible state is broadcast via `onChange` so the renderer can show
// the user_code modal while waiting.

import { shell } from "electron";
import { createEmitter } from "./emitter";
import { saveEncrypted, loadEncrypted, clearEncrypted } from "./safeStore";
import { githubClientId, githubScope } from "./config";

export interface GithubCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  scope: string;
  login?: string;
}

export interface GithubPendingConnect {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
}

export type GithubConnectState =
  | { kind: "disconnected" }
  | { kind: "connecting"; pending: GithubPendingConnect }
  | { kind: "connected"; login?: string; scope: string }
  | { kind: "error"; message: string };

const CREDS_KEY = "githubCredsEnc";

let creds: GithubCreds | null = null;
let pendingPoll: { abort: () => void } | null = null;
let currentState: GithubConnectState = { kind: "disconnected" };
const changes = createEmitter<GithubConnectState>();

export const onChange = changes.on;

export function getClientId(): string {
  return githubClientId();
}

export function isConfigured(): boolean {
  return getClientId() !== "";
}

export function getCreds(): GithubCreds | null {
  return creds;
}

export function getState(): GithubConnectState {
  return currentState;
}

export function restore(): void {
  creds = loadEncrypted<GithubCreds>(CREDS_KEY);
  currentState = creds
    ? { kind: "connected", login: creds.login, scope: creds.scope }
    : { kind: "disconnected" };
}

function setState(next: GithubConnectState): void {
  currentState = next;
  changes.emit(next);
}

function persist(): void {
  if (creds) saveEncrypted(CREDS_KEY, creds);
  else clearEncrypted(CREDS_KEY);
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export async function startConnect(): Promise<GithubPendingConnect> {
  if (!isConfigured()) {
    throw new Error(
      "MAIN_VITE_GITHUB_CLIENT_ID is not set in desktop .env. Enable Device Flow on your GitHub OAuth App and copy its Client ID.",
    );
  }
  if (pendingPoll) pendingPoll.abort();

  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ client_id: getClientId(), scope: githubScope() }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub /device/code failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as DeviceCodeResponse & { error?: string };
  if (body.error) {
    throw new Error(
      `GitHub /device/code error: ${body.error}. Is Device Flow enabled on the OAuth App?`,
    );
  }

  const pending: GithubPendingConnect = {
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete: body.verification_uri_complete,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  setState({ kind: "connecting", pending });

  // Auto-open the prefilled URL if provided (saves the user typing the code).
  const url = body.verification_uri_complete ?? body.verification_uri;
  void shell.openExternal(url);

  startPolling(body.device_code, body.interval);
  return pending;
}

function startPolling(deviceCode: string, interval: number): void {
  let aborted = false;
  let currentInterval = interval;
  pendingPoll = {
    abort: () => {
      aborted = true;
      pendingPoll = null;
    },
  };

  const tick = async (): Promise<void> => {
    if (aborted) return;
    let body: TokenResponse;
    try {
      const res = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          client_id: getClientId(),
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      body = (await res.json()) as TokenResponse;
    } catch (err) {
      // Transient network error — try again on the next tick.
      console.warn("[github device] poll error:", err);
      setTimeout(tick, currentInterval * 1000);
      return;
    }

    if (body.access_token) {
      const login = await fetchLogin(body.access_token);
      creds = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? "",
        expiresAt: Date.now() + (body.expires_in ?? 28800) * 1000,
        scope: body.scope ?? githubScope(),
        login,
      };
      persist();
      setState({ kind: "connected", login, scope: creds.scope });
      pendingPoll = null;
      return;
    }

    switch (body.error) {
      case "authorization_pending":
        setTimeout(tick, currentInterval * 1000);
        return;
      case "slow_down":
        currentInterval += 5;
        setTimeout(tick, currentInterval * 1000);
        return;
      case "expired_token":
        setState({ kind: "error", message: "Sign-in code expired." });
        pendingPoll = null;
        return;
      case "access_denied":
        setState({ kind: "error", message: "Access denied." });
        pendingPoll = null;
        return;
      default:
        setState({
          kind: "error",
          message: body.error_description ?? body.error ?? "Unknown error",
        });
        pendingPoll = null;
    }
  };

  setTimeout(tick, interval * 1000);
}

async function fetchLogin(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "slashtalk-desktop",
      },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { login?: string };
    return body.login;
  } catch {
    return undefined;
  }
}

export function cancelConnect(): void {
  pendingPoll?.abort();
  pendingPoll = null;
  if (currentState.kind === "connecting" || currentState.kind === "error") {
    setState({ kind: "disconnected" });
  }
}

export function disconnect(): void {
  creds = null;
  persist();
  setState({ kind: "disconnected" });
}
