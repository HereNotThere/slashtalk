// Singleton Postgres connection + lightweight migration runner.
//
// Migrations live in packages/backend/migrations/*.sql, sorted lexically.
// Each file runs once inside a transaction; applied filenames are tracked
// in the `_migrations` table. Multi-statement files use `.simple()` — the
// simple query protocol is what lets bun:sql send multiple statements in
// one round-trip (see bun-types/sql.d.ts:428).

import { SQL } from "bun";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./server.ts";

let _sql: SQL | null = null;

/** Throws if called before {@link start}. Consumers: `await sql()`…`. */
export function sql(): SQL {
  if (!_sql) throw new Error("db not initialized — call db.start() first");
  return _sql;
}

export async function start(): Promise<void> {
  if (_sql) return;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");

  const client = new SQL(url);
  await client`select 1`; // fail fast on connect
  await runMigrations(client);
  _sql = client;
  log("info", "db_ready", {});
}

async function runMigrations(client: SQL): Promise<void> {
  await client`
    create table if not exists _migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const dir = join(import.meta.dir, "..", "migrations");
  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const appliedRows = await client<{ name: string }[]>`
    select name from _migrations
  `;
  const applied = new Set(appliedRows.map((r) => r.name));

  for (const file of files) {
    if (applied.has(file)) continue;
    const content = await readFile(join(dir, file), "utf8");
    await client.begin(async (tx) => {
      await tx.unsafe(content).simple();
      await tx`insert into _migrations (name) values (${file})`;
    });
    log("info", "migration_applied", { file });
  }
}
