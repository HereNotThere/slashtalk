#!/usr/bin/env bun
// Generate docs/generated/db-schema.md from apps/server/src/db/schema.ts.
//
//   bun run gen:db-schema           # regenerate
//   bun run gen:db-schema -- --check  # fail if drift
//
// Invoked from apps/server/ via package.json scripts.

import * as schema from "../src/db/schema";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.resolve(import.meta.dir, "../../../docs/generated/db-schema.md");

function isTable(x: unknown): x is PgTable {
  if (!x || typeof x !== "object") return false;
  try {
    getTableConfig(x as PgTable);
    return true;
  } catch {
    return false;
  }
}

function render(tables: Array<{ export: string; table: PgTable }>): string {
  const lines: string[] = [];
  lines.push("# Database schema");
  lines.push("");
  lines.push(
    "> Auto-generated from [`apps/server/src/db/schema.ts`](../../apps/server/src/db/schema.ts). Do not edit by hand. Regenerate with `bun run gen:db-schema` from `apps/server/`.",
  );
  lines.push("");
  lines.push(`Tables: ${tables.map((t) => `\`${getTableConfig(t.table).name}\``).join(", ")}`);
  lines.push("");

  for (const { export: exportName, table } of tables) {
    const cfg = getTableConfig(table);
    lines.push(`## \`${cfg.name}\``);
    lines.push("");
    lines.push(`Drizzle export: \`${exportName}\`.`);
    lines.push("");
    lines.push("| Column | Type | Notes |");
    lines.push("| --- | --- | --- |");
    for (const col of cfg.columns) {
      const c = col as unknown as {
        name: string;
        columnType?: string;
        dataType?: string;
        notNull?: boolean;
        primary?: boolean;
        hasDefault?: boolean;
        default?: unknown;
      };
      const type = c.columnType ?? c.dataType ?? "unknown";
      const flags: string[] = [];
      if (c.primary) flags.push("pk");
      if (c.notNull) flags.push("not null");
      if (c.hasDefault) flags.push("has default");
      lines.push(`| \`${c.name}\` | \`${type}\` | ${flags.join(", ") || "—"} |`);
    }

    if (cfg.primaryKeys.length) {
      lines.push("");
      for (const pk of cfg.primaryKeys) {
        const cols = (pk as unknown as { columns: Array<{ name: string }> }).columns
          .map((c) => c.name)
          .join(", ");
        lines.push(`**Primary key:** \`(${cols})\``);
      }
    }

    if (cfg.indexes.length) {
      lines.push("");
      lines.push("**Indexes:**");
      for (const ix of cfg.indexes) {
        const conf = (ix as unknown as {
          config: {
            name: string;
            columns: Array<{ name?: string } | unknown>;
            unique?: boolean;
          };
        }).config;
        const cols = conf.columns
          .map((col) => (typeof col === "object" && col && "name" in col ? (col as { name?: string }).name ?? "expr" : "expr"))
          .join(", ");
        const kind = conf.unique ? "unique index" : "index";
        lines.push(`- \`${conf.name}\` (${kind}) on \`(${cols})\``);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

const tables = Object.entries(schema)
  .filter(([, v]) => isTable(v))
  .map(([exportName, table]) => ({ export: exportName, table: table as PgTable }));

const generated = render(tables) + "\n";

const checkMode = process.argv.slice(2).includes("--check");

if (checkMode) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current !== generated) {
    console.error(
      `docs/generated/db-schema.md is out of date. Run: bun run gen:db-schema (from apps/server/)`,
    );
    process.exit(1);
  }
  console.log("docs/generated/db-schema.md is up to date.");
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, generated);
  console.log(`Wrote ${OUT} (${tables.length} tables).`);
}
