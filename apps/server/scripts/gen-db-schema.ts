#!/usr/bin/env bun
// Keeps docs/generated/db-schema.md in lockstep with the Drizzle schema.

import * as schema from "../src/db/schema";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.resolve(import.meta.dir, "../../../docs/generated/db-schema.md");

function render(
  tables: Array<{ export: string; table: PgTable; cfg: ReturnType<typeof getTableConfig> }>,
): string {
  const lines: string[] = [];
  lines.push("# Database schema");
  lines.push("");
  lines.push(
    "> Auto-generated from [`apps/server/src/db/schema.ts`](../../apps/server/src/db/schema.ts). Do not edit by hand. Regenerate with `bun run gen:db-schema` from `apps/server/`.",
  );
  lines.push("");
  lines.push(`Tables: ${tables.map((t) => `\`${t.cfg.name}\``).join(", ")}`);
  lines.push("");

  for (const { export: exportName, cfg } of tables) {
    lines.push(`## \`${cfg.name}\``);
    lines.push("");
    lines.push(`Drizzle export: \`${exportName}\`.`);
    lines.push("");
    lines.push("| Column | Type | Notes |");
    lines.push("| --- | --- | --- |");
    for (const col of cfg.columns) {
      const type = col.columnType ?? col.dataType ?? "unknown";
      const flags: string[] = [];
      if (col.primary) flags.push("pk");
      if (col.notNull) flags.push("not null");
      if (col.hasDefault) flags.push("has default");
      lines.push(`| \`${col.name}\` | \`${type}\` | ${flags.join(", ") || "—"} |`);
    }

    if (cfg.primaryKeys.length) {
      lines.push("");
      for (const pk of cfg.primaryKeys) {
        const cols = pk.columns.map((c) => c.name).join(", ");
        lines.push(`**Primary key:** \`(${cols})\``);
      }
    }

    if (cfg.indexes.length) {
      lines.push("");
      lines.push("**Indexes:**");
      for (const ix of cfg.indexes) {
        const cols = ix.config.columns
          .map((col) => (is(col, SQL) ? "expr" : (col.name ?? "expr")))
          .join(", ");
        const kind = ix.config.unique ? "unique index" : "index";
        lines.push(`- \`${ix.config.name}\` (${kind}) on \`(${cols})\``);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

const tables = Object.entries(schema)
  .filter(([, v]) => is(v, PgTable))
  .map(([exportName, table]) => {
    const t = table as PgTable;
    return { export: exportName, table: t, cfg: getTableConfig(t) };
  });

const generated = render(tables) + "\n";

const checkMode = process.argv.slice(2).includes("--check");

function readIfExists(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

if (checkMode) {
  if (normalize(readIfExists(OUT)) !== normalize(generated)) {
    console.error(
      `docs/generated/db-schema.md is out of date. Run: bun run gen:db-schema (from apps/server/)`,
    );
    process.exit(1);
  }
  console.log("docs/generated/db-schema.md is up to date.");
} else {
  const current = readIfExists(OUT);
  if (normalize(current) === normalize(generated)) {
    console.log(`${OUT} already up to date (${tables.length} tables).`);
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, generated);
    console.log(`Wrote ${OUT} (${tables.length} tables).`);
  }
}
