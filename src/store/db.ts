/** Thin wrapper around node:sqlite for the derived index. */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "./schema.js";

/** Load node:sqlite while swallowing ONLY its ExperimentalWarning (Node 22–24 still
 *  emits it on module load). Hunch's stderr reaches humans, hooks, and MCP clients on
 *  every invocation, so the noise would land everywhere; all other warnings pass through. */
function loadSqlite(): typeof import("node:sqlite") {
  const require = createRequire(import.meta.url);
  const realEmit = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    if (String(warning).includes("SQLite is an experimental feature")) return;
    (realEmit as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = realEmit;
  }
}

const sqlite = loadSqlite();

export type DB = import("node:sqlite").DatabaseSync;

export function openDb(sqlitePath: string): DB {
  mkdirSync(dirname(sqlitePath), { recursive: true });
  const db = new sqlite.DatabaseSync(sqlitePath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  return db;
}

/** In-memory db (tests / ephemeral queries). */
export function openMemoryDb(): DB {
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}

/** Run `fn` inside one transaction: BEGIN → fn → COMMIT, ROLLBACK on throw.
 *  (node:sqlite has no better-sqlite3-style transaction() helper.) */
export function withTx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* connection already rolled back */
    }
    throw err;
  }
}
