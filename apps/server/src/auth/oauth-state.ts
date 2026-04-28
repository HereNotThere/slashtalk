import { randomBytes } from "node:crypto";
import type { RedisBridge } from "../ws/redis-bridge";

// Carry the post-callback intent across GitHub's OAuth round-trip: where to
// redirect the issued credentials (a desktop loopback port) or the user
// (a same-origin web path). Server-side only — the client only ever sees
// the nonce that points to one of these.
export type OAuthStatePayload =
  | { kind: "desktop"; port: number }
  | { kind: "web"; returnTo?: string };

const TTL_SECONDS = 600;

const key = (nonce: string): string => `oauth:state:${nonce}`;

/**
 * Issue a single-use, server-stored CSRF state nonce for the GitHub OAuth
 * round-trip. The nonce is what we hand to GitHub via `?state=`; the payload
 * stays on the server. Without this, the callback would have no proof that
 * the inbound `code` belongs to a flow we initiated, letting an attacker
 * replay a stolen code or steer the desktop loopback redirect at any port.
 */
export async function issueOAuthState(
  redis: RedisBridge,
  payload: OAuthStatePayload,
): Promise<string> {
  const nonce = randomBytes(32).toString("base64url");
  await redis.setex(key(nonce), TTL_SECONDS, payload);
  return nonce;
}

/**
 * Look up and atomically consume the payload for a state nonce. Returns
 * null if missing/expired/already-consumed — callers must treat that as
 * an unauthenticated callback and refuse to issue tokens.
 */
export async function consumeOAuthState(
  redis: RedisBridge,
  nonce: string,
): Promise<OAuthStatePayload | null> {
  const payload = await redis.getJson<OAuthStatePayload>(key(nonce));
  if (!payload) return null;
  await redis.del(key(nonce));
  return payload;
}
