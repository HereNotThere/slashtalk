// Bearer-token auth against slashtalk's api_keys table. Mirrors
// @slashtalk/server's apiKeyAuth middleware (apps/server/src/auth/middleware.ts)
// so the desktop's existing apiKey works unchanged against this service.
// Read-only on api_keys / users / devices — we never mint tokens here.

import * as db from "./db.ts";

export interface ApiKeyIdentity {
  userLogin: string; // users.github_login — stable across devices
  userId: number; // users.id
  deviceId: number; // api_keys.device_id
  profile?: {
    name?: string;
    avatar?: string;
  };
}

/** SHA-256 hash matching @slashtalk/server's hashToken. */
export async function hashToken(token: string): Promise<string> {
  const encoded = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface KeyRow {
  api_key_id: number;
  device_id: number;
  user_id: number;
  github_login: string;
  display_name: string | null;
  avatar_url: string | null;
}

/** Validate a Bearer token and return the identity it's bound to, or null
 *  if the key is unknown / revoked. Also bumps last_used_at as a side effect
 *  so slashtalk's UI can show "last seen" on devices. */
export async function verifyApiKey(token: string): Promise<ApiKeyIdentity | null> {
  if (!token) return null;
  const sql = db.sql();
  const hash = await hashToken(token);
  const rows = await sql<KeyRow[]>`
    select
      ak.id           as api_key_id,
      ak.device_id    as device_id,
      u.id            as user_id,
      u.github_login  as github_login,
      u.display_name  as display_name,
      u.avatar_url    as avatar_url
    from api_keys ak
    join users u on u.id = ak.user_id
    where ak.key_hash = ${hash}
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  // Fire-and-forget — we don't block the request on this bookkeeping.
  void sql`
    update api_keys set last_used_at = now() where id = ${row.api_key_id}
  `;
  return {
    userLogin: row.github_login,
    userId: row.user_id,
    deviceId: row.device_id,
    profile: {
      ...(row.display_name ? { name: row.display_name } : {}),
      ...(row.avatar_url ? { avatar: row.avatar_url } : {}),
    },
  };
}

/** Pull the Bearer token out of the Authorization header. */
export function extractBearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}
