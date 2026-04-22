// Tiny JSON store in app.getPath('userData'). Mirrors the couple of
// UserDefaults keys the Swift app uses.

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

type Cache = Record<string, unknown>;

let cache: Cache | null = null;
let filePath: string | null = null;

function load(): Cache {
  if (cache) return cache;
  filePath = path.join(app.getPath("userData"), "chatheads.json");
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    cache = JSON.parse(raw) as Cache;
  } catch {
    cache = {};
  }
  return cache;
}

function save(): void {
  if (!cache || !filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error("[store] write failed:", err);
  }
}

export function get<T>(key: string): T | undefined {
  return load()[key] as T | undefined;
}

export function set(key: string, value: unknown): void {
  load();
  cache![key] = value;
  save();
}

export function del(key: string): void {
  load();
  delete cache![key];
  save();
}
