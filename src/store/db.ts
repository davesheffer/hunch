/** Thin wrapper around better-sqlite3 for the derived index. */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "./schema.js";

export type DB = Database.Database;

export function openDb(sqlitePath: string): DB {
  mkdirSync(dirname(sqlitePath), { recursive: true });
  const db = new Database(sqlitePath);
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  return db;
}

/** In-memory db (tests / ephemeral queries). */
export function openMemoryDb(): DB {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}
