/**
 * SQLite schema for the DERIVED index (DESIGN.md §2.1 / §6).
 *
 * The JSON files under .hunch/ are the source of truth; this database is rebuilt
 * from them by `hunch index`. JSON-array/object fields are stored as TEXT (JSON)
 * — we only need them indexed where we query them. Search prefers one unified
 * FTS5 table, but db.ts substitutes a plain table when the host Node binary was
 * built without FTS5; the graph is plain tables walked with recursive CTEs.
 */
import { shortHash } from "../core/ids.js";

/** Canonical content hash of the exact title+body that fed both FTS and the
 *  embedding for a doc. Stored in `embeddings.doc_hash` so reindex can tell, with
 *  NO model loaded, whether a stored vector is stale (its source text changed).
 *  The NUL separator keeps the title/body boundary unambiguous. Reuses the shared
 *  sha1-truncate idiom from core/ids so the hashing scheme lives in one place. */
export function embedHash(title: string, body: string): string {
  return shortHash(`${title}\x00${body ?? ""}`, 16);
}

export const SCHEMA_SQL = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS components (
  id TEXT PRIMARY KEY,
  kind TEXT, name TEXT, responsibility TEXT,
  paths TEXT, status TEXT, owners TEXT,
  fragility REAL,
  prov_source TEXT, prov_confidence REAL, prov_evidence TEXT,
  created_at TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  "from" TEXT, "to" TEXT, type TEXT, reason TEXT, strength REAL,
  prov_source TEXT, prov_confidence REAL, prov_evidence TEXT
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges("from");
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges("to");
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);

CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  file TEXT, name TEXT, kind TEXT, signature_hash TEXT,
  calls TEXT, called_by TEXT,
  loc INTEGER, churn_90d INTEGER, bug_count INTEGER, fan_in INTEGER, fan_out INTEGER,
  last_changed TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  title TEXT, status TEXT, context TEXT, decision TEXT,
  consequences TEXT, alternatives_rejected TEXT,
  related_components TEXT, related_files TEXT,
  supersedes TEXT, caused_by_bug TEXT, "commit" TEXT,
  prov_source TEXT, prov_confidence REAL, prov_evidence TEXT,
  date TEXT
);

CREATE TABLE IF NOT EXISTS bugs (
  id TEXT PRIMARY KEY,
  title TEXT, symptom TEXT, root_cause TEXT, severity TEXT, status TEXT,
  affected_files TEXT, affected_symbols TEXT, lineage TEXT,
  prov_source TEXT, prov_confidence REAL, prov_evidence TEXT
);

CREATE TABLE IF NOT EXISTS constraints (
  id TEXT PRIMARY KEY,
  type TEXT, statement TEXT, scope TEXT, severity TEXT, enforcement TEXT,
  rationale TEXT, source_decision TEXT, violations TEXT,
  prov_source TEXT, prov_confidence REAL, prov_evidence TEXT
);

-- Local semantic-search vectors (opt-in; written by \`hunch embed\`). One row per
-- (ref, model); vec is a Float32 BLOB. DELIBERATELY NOT in RESET_SQL: reindex()
-- runs RESET on nearly every path (MCP startup, every query/context), so resetting
-- embeddings here would wipe them constantly and make the feature a no-op. Staleness
-- is tracked by doc_hash and reconciled by pruneStaleEmbeddings() instead. Recall is
-- exact brute-force cosine in JS (graphs are small); sqlite-vec only past ~100k rows.
CREATE TABLE IF NOT EXISTS embeddings (
  ref TEXT, kind TEXT, model TEXT, dim INTEGER, doc_hash TEXT, vec BLOB,
  PRIMARY KEY (ref, model)
);
`;

/** Preferred search table when the host SQLite build includes FTS5. Kept
 * separate from SCHEMA_SQL so a missing optional SQLite module cannot prevent
 * deterministic graph/constraint operations from opening the derived index. */
export const FTS_SEARCH_SCHEMA_SQL = /* sql */ `
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  ref UNINDEXED,   -- entity id
  kind UNINDEXED,  -- components | edges | symbols | decisions | bugs | constraints
  title,
  body,
  tokenize = 'porter unicode61'
);
`;

/** Portable keyword-search fallback. HunchStore detects that MATCH/bm25 are
 * unavailable and performs a bounded LIKE scan over the same four columns. */
export const PLAIN_SEARCH_SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS search (
  ref TEXT,
  kind TEXT,
  title TEXT,
  body TEXT
);
CREATE INDEX IF NOT EXISTS idx_search_ref ON search(ref);
CREATE INDEX IF NOT EXISTS idx_search_kind ON search(kind);
`;

/** Drop derived data (used before a full reindex). NOTE: embeddings is omitted on
 *  purpose — see the embeddings table comment above. */
export const RESET_SQL = /* sql */ `
DELETE FROM components; DELETE FROM edges; DELETE FROM symbols;
DELETE FROM decisions; DELETE FROM bugs; DELETE FROM constraints;
DELETE FROM search;
`;
