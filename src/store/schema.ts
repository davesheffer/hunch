/**
 * SQLite schema for the DERIVED index (DESIGN.md §2.1 / §6).
 *
 * The JSON files under .hunch/ are the source of truth; this database is rebuilt
 * from them by `hunch index`. JSON-array/object fields are stored as TEXT (JSON)
 * — we only need them indexed where we query them. Search is a single unified
 * FTS5 table; the graph is plain tables walked with recursive CTEs.
 */
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

-- Unified full-text search across every entity. Rebuilt on index; bm25-ranked.
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  ref UNINDEXED,   -- entity id
  kind UNINDEXED,  -- components | edges | symbols | decisions | bugs | constraints
  title,
  body,
  tokenize = 'porter unicode61'
);
`;

/** Drop derived data (used before a full reindex). */
export const RESET_SQL = /* sql */ `
DELETE FROM components; DELETE FROM edges; DELETE FROM symbols;
DELETE FROM decisions; DELETE FROM bugs; DELETE FROM constraints;
DELETE FROM search;
`;
