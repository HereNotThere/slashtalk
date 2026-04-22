// GitHub device flow + minimal API. Mirrors GitHub.swift.
// Runs in the main process so the token never crosses into the renderer.

import { shell, safeStorage } from "electron";
import type {
  GitHubOrg,
  GitHubPayload,
  GitHubState,
  GitHubUser,
  Unsubscribe,
} from "../shared/types";
import * as store from "./store";

const CLIENT_ID = "Ov23liVtEbpeLywfLTNo";
const SCOPE = "read:org";

// Stored as base64 of safeStorage-encrypted ciphertext, so it's Keychain-
// protected on macOS / DPAPI on Windows / kwallet etc on Linux.
const TOKEN_KEY = "githubTokenEnc";

type ChangeListener = (payload: GitHubPayload) => void;

let state: GitHubState = { kind: "signedOut" };
let errorMessage: string | null = null;
let token: string | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<ChangeListener>();

export function onChange(cb: ChangeListener): Unsubscribe {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(): void {
  const payload: GitHubPayload = { state, errorMessage };
  for (const cb of listeners) cb(payload);
}

function setState(next: GitHubState): void {
  state = next;
  notify();
}

function setError(msg: string | null): void {
  errorMessage = msg;
  notify();
}

export function restore(): void {
  const enc = store.get<string>(TOKEN_KEY);
  if (!enc) return;
  if (!safeStorage.isEncryptionAvailable()) return;
  try {
    token = safeStorage.decryptString(Buffer.from(enc, "base64"));
    state = { kind: "signedIn" };
  } catch {
    token = null;
    store.del(TOKEN_KEY);
  }
}

export function getState(): GitHubPayload {
  return { state, errorMessage };
}

export async function startDeviceFlow(): Promise<void> {
  errorMessage = null;
  try {
    const code = await requestDeviceCode();
    setState({
      kind: "awaitingUserCode",
      userCode: code.user_code,
      verificationURL: code.verification_uri,
    });
    void shell.openExternal(code.verification_uri);
    startPolling(code.device_code, code.interval);
  } catch (err) {
    setError(`Sign-in failed: ${(err as Error).message}`);
    setState({ kind: "signedOut" });
  }
}

export function cancelDeviceFlow(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  setState({ kind: "signedOut" });
}

export function signOut(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  token = null;
  store.del(TOKEN_KEY);
  setState({ kind: "signedOut" });
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const r = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<DeviceCodeResponse>;
}

type PollResult =
  | { kind: "token"; token: string }
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "failed"; message: string };

function startPolling(deviceCode: string, initialIntervalSec: number): void {
  let intervalMs = Math.max(initialIntervalSec, 5) * 1000;

  const tick = async (): Promise<void> => {
    try {
      const result = await pollForToken(deviceCode);
      if (result.kind === "token") {
        completeSignIn(result.token);
        return;
      }
      if (result.kind === "pending") {
        pollTimer = setTimeout(tick, intervalMs);
        return;
      }
      if (result.kind === "slow_down") {
        intervalMs += 5000;
        pollTimer = setTimeout(tick, intervalMs);
        return;
      }
      setError(result.message);
      setState({ kind: "signedOut" });
    } catch (err) {
      setError((err as Error).message);
      pollTimer = setTimeout(tick, intervalMs);
    }
  };

  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(tick, intervalMs);
}

async function pollForToken(deviceCode: string): Promise<PollResult> {
  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const data = (await r.json()) as { access_token?: string; error?: string };
  if (data.access_token) return { kind: "token", token: data.access_token };
  switch (data.error) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down" };
    case "expired_token":
      return { kind: "failed", message: "Code expired — try again" };
    case "access_denied":
      return { kind: "failed", message: "Access denied" };
    default:
      return {
        kind: "failed",
        message: data.error ?? "Unexpected response from GitHub",
      };
  }
}

function completeSignIn(accessToken: string): void {
  token = accessToken;
  if (safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(accessToken);
    store.set(TOKEN_KEY, enc.toString("base64"));
  }
  errorMessage = null;
  setState({ kind: "signedIn" });
}

async function apiGet<T>(url: string): Promise<T> {
  if (!token) throw new Error("Not signed in");
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!r.ok) throw new Error(`GitHub API error (${r.status})`);
  return r.json() as Promise<T>;
}

interface RawGitHubUser {
  id: number;
  login: string;
  avatar_url: string;
}

export async function listOrgs(): Promise<GitHubOrg[]> {
  const orgs = await apiGet<RawGitHubUser[]>(
    "https://api.github.com/user/orgs?per_page=100",
  );
  return orgs.map((o) => ({
    id: o.id,
    login: o.login,
    avatarURL: o.avatar_url,
  }));
}

export async function listMembers(org: string): Promise<GitHubUser[]> {
  const users = await apiGet<RawGitHubUser[]>(
    `https://api.github.com/orgs/${encodeURIComponent(org)}/members?per_page=100`,
  );
  return users.map((u) => ({
    id: u.id,
    login: u.login,
    avatarURL: u.avatar_url,
  }));
}
