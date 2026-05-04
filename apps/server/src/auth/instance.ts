import { db } from "../db";
import type { Database } from "../db";
import type { SessionJwtVerifier } from "./session";
import {
  bearerToken,
  resolveApiKey,
  resolveMcpAccessToken,
  resolveSessionJwt,
  type AuthResolverDeps,
} from "./resolvers";

export function createAuthInstance(deps: AuthResolverDeps) {
  return {
    bearerToken,
    resolveSessionJwt: (jwtVerifier: SessionJwtVerifier | undefined, token: string | undefined) =>
      resolveSessionJwt(deps, jwtVerifier, token),
    resolveApiKey: (token: string, options: { touchLastUsedAt: boolean }) =>
      resolveApiKey(deps, token, options),
    resolveMcpAccessToken: (token: string, expectedResource: string) =>
      resolveMcpAccessToken(deps, token, expectedResource),
  };
}

export function createAuthInstanceForDb(database: Database) {
  return createAuthInstance({ db: database });
}

export const authInstance = createAuthInstance({ db });
