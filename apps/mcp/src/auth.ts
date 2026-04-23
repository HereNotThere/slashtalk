import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export type AppTokenPayload = {
  sub: string;
  gid: number;
  name?: string;
  avatar?: string;
  tz?: string;
  iat: number;
  exp: number;
};

export type AuthConfig = {
  enabled: boolean;
  githubClientId: string;
  githubClientSecret: string;
  tokenSecret: string;
  publicUrl: string;
  tokenTtlSeconds: number;
};

export function loadAuthConfig(port: number): AuthConfig {
  const githubClientId = process.env.GITHUB_CLIENT_ID ?? "";
  const githubClientSecret = process.env.GITHUB_CLIENT_SECRET ?? "";
  const tokenSecret = process.env.TOKEN_SECRET ?? "";
  const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;
  const enabled = Boolean(githubClientId);

  if (enabled) {
    if (!githubClientSecret) throw new Error("GITHUB_CLIENT_SECRET required when GITHUB_CLIENT_ID is set");
    if (!tokenSecret) throw new Error("TOKEN_SECRET required when GITHUB_CLIENT_ID is set");
  }

  return {
    enabled,
    githubClientId,
    githubClientSecret,
    tokenSecret,
    publicUrl: publicUrl.replace(/\/$/, ""),
    tokenTtlSeconds: 30 * 24 * 60 * 60,
  };
}

export function base64urlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return bytes.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function base64urlDecode(input: string): Buffer {
  const pad = 4 - (input.length % 4);
  const padded = pad < 4 ? input + "=".repeat(pad) : input;
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function signToken(payload: AppTokenPayload, secret: string): string {
  const body = base64urlEncode(JSON.stringify(payload));
  const sig = base64urlEncode(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken(token: string, secret: string): AppTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = base64urlEncode(createHmac("sha256", secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(base64urlDecode(body).toString("utf8")) as AppTokenPayload;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function issueToken(config: AuthConfig, fields: Omit<AppTokenPayload, "iat" | "exp">): string {
  const now = Math.floor(Date.now() / 1000);
  return signToken(
    { ...fields, iat: now, exp: now + config.tokenTtlSeconds },
    config.tokenSecret,
  );
}

export function extractBearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]!.trim() : null;
}

export function randomState(): string {
  return base64urlEncode(randomBytes(32));
}
