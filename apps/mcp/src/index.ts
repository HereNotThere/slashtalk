#!/usr/bin/env bun
import { log } from "./server.ts";
import { runHttp } from "./http.ts";
import * as db from "./db.ts";

const name = "slashtalk-mcp";
const version = "0.0.1";
const port = Number(process.env.PORT ?? 3000);

try {
  await db.start();
  runHttp({ port, name, version });
} catch (err) {
  log("error", "boot_failed", { err: String(err) });
  process.exit(1);
}
