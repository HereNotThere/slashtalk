import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config";
import * as schema from "./schema";

const client = postgres(config.databaseUrl, {
  max: config.dbPoolMax,
  idle_timeout: config.dbIdleTimeoutSec,
  connect_timeout: config.dbConnectTimeoutSec,
  max_lifetime: config.dbMaxLifetimeSec,
  // Sets PostgreSQL's `statement_timeout` GUC on every new connection so a
  // runaway query is killed at the database before it monopolizes a pool slot.
  connection: { statement_timeout: config.dbStatementTimeoutMs },
});

export const db = drizzle(client, { schema });

export type Database = typeof db;

/** Liveness ping for `/ready` — short-bounded so a hung database can't pin
 *  the readiness probe. Returns true on a 1-row select; false on any error
 *  (timeout, connection refusal, etc.). */
export async function pingDatabase(timeoutMs = 2_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("db ping timeout")), timeoutMs);
    });
    await Promise.race([client`SELECT 1`, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
