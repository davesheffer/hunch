/**
 * Delivery receipts (roadmap dec_925f4bcaad): a machine-local ledger of which
 * memory records were actually DELIVERED to an agent, when, and into what.
 *
 * This is observed telemetry, not derived state: it cannot be reconstructed
 * from the JSON store, so it must NOT live in the reindex-rebuilt SQLite index
 * (con_a87360128b's derived layer is dropped and rebuilt at will). It gets its
 * own database under .hunch-cache/ — gitignored, per-machine, append-only —
 * the same family as hookcache's session state, not the store's.
 *
 * Failure posture inherits the hook's: recording a receipt must never cost a
 * delivery. Every entry point swallows every error; a lost receipt is noise,
 * a blocked edit is a broken product.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Load node:sqlite while swallowing ONLY its ExperimentalWarning — the same
 *  discipline as src/store/db.ts: this module rides the hook into every CLI
 *  invocation, and Hunch's stderr reaches humans, hooks, and MCP clients. A
 *  bare top-level import printed the warning on every command and failed the
 *  release gate's clean-stderr contract. */
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

type DatabaseSync = import("node:sqlite").DatabaseSync;

export type ServedEvent = "served" | "refreshed";

export interface ServedEntry {
  event: ServedEvent;
  /** decisions | constraints | bugs | findings */
  kind: string;
  record_id: string;
  /** what the delivery grounded: a repo-relative file, or a moment like "(subagent:Explore)" */
  target: string;
  session_id?: string;
  rank?: number;
  delivery_reason?: string;
  provenance_status?: string;
  token_cost?: number;
  delivery_profile?: string;
  ranking_policy?: string;
}

export interface ServedRow {
  record_id: string;
  kind: string;
  serves: number;
  refreshes: number;
  last_at: string;
  best_rank: number | null;
  average_token_cost: number | null;
}

export interface ServedReceipt {
  at: string;
  session_id: string | null;
  event: ServedEvent;
  kind: string;
  record_id: string;
  target: string;
  rank: number | null;
  delivery_reason: string | null;
  provenance_status: string | null;
  token_cost: number | null;
  delivery_profile: string | null;
  ranking_policy: string | null;
}

export interface ServedSummary {
  total: number;
  distinct_records: number;
  distinct_sessions: number;
  first_at: string | null;
  last_at: string | null;
  rows: ServedRow[];
  recent: ServedReceipt[];
}

let sqlite: typeof import("node:sqlite") | null = null;

const RECEIPT_COLUMNS = [
  ["rank", "INTEGER"],
  ["delivery_reason", "TEXT"],
  ["provenance_status", "TEXT"],
  ["token_cost", "INTEGER"],
  ["delivery_profile", "TEXT"],
  ["ranking_policy", "TEXT"],
] as const;

function columnNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare("PRAGMA table_info(served)").all() as unknown as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** Additive, idempotent migration for machine-local ledgers created by older releases. */
function ensureReceiptColumns(db: DatabaseSync): void {
  const existing = columnNames(db);
  for (const [name, type] of RECEIPT_COLUMNS) {
    if (existing.has(name)) continue;
    try {
      db.exec(`ALTER TABLE served ADD COLUMN ${name} ${type}`);
    } catch (error) {
      // Two hook processes may race the same migration. Only swallow when the
      // other process demonstrably completed this exact additive change.
      if (!columnNames(db).has(name)) throw error;
    }
    existing.add(name);
  }
}

function openServedDb(root: string): DatabaseSync {
  sqlite ??= loadSqlite();
  const dir = join(root, ".hunch-cache");
  mkdirSync(dir, { recursive: true });
  const db = new sqlite.DatabaseSync(join(dir, "served.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS served (
    at TEXT NOT NULL,
    session TEXT,
    event TEXT NOT NULL,
    kind TEXT NOT NULL,
    record_id TEXT NOT NULL,
    target TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS served_record ON served (record_id);`);
  ensureReceiptColumns(db);
  return db;
}

/** Append delivery receipts. Never throws — a receipt must never cost a delivery. */
export function recordServed(root: string, entries: readonly ServedEntry[]): void {
  if (!entries.length) return;
  try {
    const db = openServedDb(root);
    try {
      const at = new Date().toISOString();
      const insert = db.prepare(
        "INSERT INTO served (at, session, event, kind, record_id, target, rank, delivery_reason, provenance_status, token_cost, delivery_profile, ranking_policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const entry of entries) {
        insert.run(
          at,
          entry.session_id ?? null,
          entry.event,
          entry.kind,
          entry.record_id,
          entry.target,
          entry.rank ?? null,
          entry.delivery_reason ?? null,
          entry.provenance_status ?? null,
          entry.token_cost ?? null,
          entry.delivery_profile ?? null,
          entry.ranking_policy ?? null,
        );
      }
    } finally {
      db.close();
    }
  } catch {
    /* unwritable cache dir / locked db — the delivery already happened; drop the receipt */
  }
}

/** The ledger, aggregated per record. Never throws; an unreadable ledger reads as empty. */
export function servedSummary(root: string): ServedSummary {
  const empty: ServedSummary = { total: 0, distinct_records: 0, distinct_sessions: 0, first_at: null, last_at: null, rows: [], recent: [] };
  try {
    const db = openServedDb(root);
    try {
      const totals = db.prepare(
        "SELECT COUNT(*) AS total, COUNT(DISTINCT record_id) AS records, COUNT(DISTINCT session) AS sessions, MIN(at) AS first_at, MAX(at) AS last_at FROM served",
      ).get() as { total: number; records: number; sessions: number; first_at: string | null; last_at: string | null } | undefined;
      const rawRows = db.prepare(
        `SELECT record_id, kind,
           SUM(CASE WHEN event = 'served' THEN 1 ELSE 0 END) AS serves,
           SUM(CASE WHEN event = 'refreshed' THEN 1 ELSE 0 END) AS refreshes,
           MAX(at) AS last_at,
           MIN(rank) AS best_rank,
           ROUND(AVG(token_cost), 2) AS average_token_cost
         FROM served GROUP BY record_id, kind ORDER BY serves DESC, refreshes DESC`,
      ).all() as unknown as ServedRow[];
      const rawRecent = db.prepare(
        `SELECT at, session AS session_id, event, kind, record_id, target,
           rank, delivery_reason, provenance_status, token_cost, delivery_profile, ranking_policy
         FROM served ORDER BY rowid DESC LIMIT 50`,
      ).all() as unknown as ServedReceipt[];
      const rows = rawRows.map((row) => ({ ...row }));
      const recent = rawRecent.map((receipt) => ({ ...receipt }));
      return {
        total: totals?.total ?? 0,
        distinct_records: totals?.records ?? 0,
        distinct_sessions: totals?.sessions ?? 0,
        first_at: totals?.first_at ?? null,
        last_at: totals?.last_at ?? null,
        rows,
        recent,
      };
    } finally {
      db.close();
    }
  } catch {
    return empty;
  }
}
