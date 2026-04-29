import type { users } from "../db/schema";

export type SessionJwtPayload = {
  sub?: string | number;
  iat?: number | boolean;
  sessionIssuedAt?: number;
};

type SessionUser = Pick<typeof users.$inferSelect, "credentialsRevokedAt">;

export type SessionJwtVerifier = {
  verify: (token: string) => Promise<false | SessionJwtPayload>;
};

export async function verifySessionJwt(
  jwtVerifier: SessionJwtVerifier | undefined,
  token: string,
): Promise<SessionJwtPayload | null> {
  if (!jwtVerifier) return null;

  try {
    const payload = await jwtVerifier.verify(token);
    if (payload === false || !payload.sub) return null;
    return payload;
  } catch {
    return null;
  }
}

export function isSessionCredentialFresh(user: SessionUser, payload: SessionJwtPayload): boolean {
  if (!user.credentialsRevokedAt) return true;

  const issuedAtMs = sessionIssuedAtMs(payload);
  return issuedAtMs !== null && issuedAtMs >= user.credentialsRevokedAt.getTime();
}

function sessionIssuedAtMs(payload: SessionJwtPayload): number | null {
  if (typeof payload.sessionIssuedAt === "number") return payload.sessionIssuedAt;
  if (typeof payload.iat === "number") return payload.iat * 1000;
  return null;
}
