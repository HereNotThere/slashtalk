// Compatibility shim over ./backend during the slashtalk auth unification.
//
// The original chatheadsAuth ran its own GitHub OAuth loopback against the
// chatheads mcp backend and stored its own bearer. That's gone: identity is
// now 100% slashtalk's, minted by @slashtalk/server's /v1/auth/exchange.
// The mcp backend verifies the same apiKey via a direct api_keys lookup.
//
// We keep the chatheadsAuth.* surface as a forwarder so call sites
// (rail.ts, selfSession.ts, agentIngest.ts, anthropic.ts, installMcp.ts, plus
// the IPC handlers in main/index.ts) don't all move in the same commit.
// Rename in a later pass; functionality is already right.

import * as backend from "./backend";
import type { BackendAuthState, ChatHeadsAuthState } from "../shared/types";
import { createEmitter } from "./emitter";

const changes = createEmitter<ChatHeadsAuthState>();

// Re-emit backend auth changes under the chatheads shape so existing
// subscribers in main/index.ts keep working without touching the IPC layer.
backend.onChange((state) => changes.emit(translate(state)));

export const onChange = changes.on;

export function getAuthState(): ChatHeadsAuthState {
  return translate(backend.getAuthState());
}

/** Returns the slashtalk device apiKey (post-signIn) — the bearer the mcp
 *  backend accepts. Name preserved from the old chatheads JWT-based API for
 *  call-site compatibility; the actual token shape is now a UUIDv4 api key. */
export function getToken(): string | null {
  return backend.getApiKey();
}

export function restore(): void {
  // backend.restore() is already called during boot; nothing to do here.
}

export async function signIn(): Promise<void> {
  return backend.signIn();
}

export function cancelSignIn(_reason?: string): void {
  void _reason;
  backend.cancelSignIn();
}

export async function signOut(): Promise<void> {
  await backend.signOut();
}

function translate(state: BackendAuthState): ChatHeadsAuthState {
  if (!state.signedIn) return { signedIn: false };
  return {
    signedIn: true,
    user: {
      login: state.user.githubLogin,
      name: state.user.displayName ?? state.user.githubLogin,
      avatar: state.user.avatarUrl,
    },
  };
}
