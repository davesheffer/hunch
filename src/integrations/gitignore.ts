/**
 * Ensure the project's .gitignore excludes Hunch's DERIVED runtime artifacts: the
 * SQLite index (rebuilt from the committed .hunch/*.json source of truth) and the
 * atomic-write temp files. Without this the MCP server's constant index writes
 * leave the working tree perpetually dirty, which blocks branch switches, pulls,
 * and rebases. The .hunch/*.json graph itself stays TRACKED — only the regenerable
 * index is ignored.
 *
 * Idempotent + merge-safe (con_8460b6770f): appends a single marked block and
 * never rewrites the user's existing entries; re-running is a no-op.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MARK = "# >>> hunch (derived runtime index — regenerable from .hunch/*.json) >>>";
const END = "# <<< hunch <<<";
const ENTRIES = [
  ".hunch/*.sqlite",
  ".hunch/*.sqlite-shm",
  ".hunch/*.sqlite-wal",
  ".hunch/*.sqlite-journal",
  ".hunch/**/*.tmp*",
  ".hunch-cache/",
  // Per-machine private-overlay pointer written by `hunch private` (holds the local
  // path to the private store) — never committed.
  ".hunch/local.json",
  // A local PRIVATE overlay store (HUNCH_PRIVATE_DIR) for sensitive memory — never
  // committed. This is the conventional in-repo path; point the env elsewhere for a
  // fully separate private repo.
  ".hunch-private/",
];

// `hunch private --migrate` makes the repo CODE-ONLY: the engineering-memory tree
// (one curated subdir per kind) moves to a private overlay and must stop being
// published here. The derived index + pointer are already covered by the block
// above; this is a SEPARATE marked block so re-running `private` doesn't have to
// re-touch the block above, and so the two concerns read clearly in the file.
const MEM_MARK = "# >>> hunch private-only (engineering memory kept in a private overlay; not published here) >>>";
const MEM_END = "# <<< hunch private-only <<<";
const MEM_ENTRIES = [
  ".hunch/decisions/",
  ".hunch/bugs/",
  ".hunch/constraints/",
  ".hunch/components/",
  ".hunch/evidence/",
  ".hunch/corpora/",
  ".hunch/policies/",
  ".hunch/proofs/",
  ".hunch/plans/",
  ".hunch/dispositions/",
  ".hunch/shadow/",
  ".hunch/symbols/",
  ".hunch/edges/",
];

export interface GitignoreResult {
  path: string;
  action: "created" | "appended" | "unchanged";
}

/** Idempotent + merge-safe append of one marked block (con_8460b6770f): never
 *  rewrites the user's existing entries, and re-running is a no-op once the block
 *  (or an equivalent hand-written set of the same patterns) is present. */
function appendBlock(root: string, mark: string, entries: string[], end: string): GitignoreResult {
  const path = join(root, ".gitignore");
  const block = [mark, ...entries, end].join("\n");
  if (!existsSync(path)) {
    writeFileSync(path, block + "\n");
    return { path, action: "created" };
  }
  const cur = readFileSync(path, "utf8");
  if (cur.includes(mark)) return { path, action: "unchanged" }; // already managed
  // Already covered by the user's OWN entries (e.g. a hand-written, commented
  // section listing the same patterns)? Don't append a redundant managed block —
  // that would leave two copies of every ignore. Keep the .gitignore clean.
  const lines = new Set(cur.split("\n").map((l) => l.trim()));
  if (entries.every((e) => lines.has(e))) return { path, action: "unchanged" };
  const sep = cur.endsWith("\n") || cur.length === 0 ? "" : "\n";
  writeFileSync(path, `${cur}${sep}${block}\n`);
  return { path, action: "appended" };
}

export function ensureGitignore(root: string): GitignoreResult {
  return appendBlock(root, MARK, ENTRIES, END);
}

/** Ignore the engineering-memory tree so a private-migrated repo stays code-only.
 *  The kind subdirs the user's records live in (decisions/, bugs/, …) move to the
 *  private overlay; this stops git from re-publishing them. The `.hunch/` dir, its
 *  manifest, and the local.json pointer are left tracked/managed elsewhere. */
export function ignoreHunchMemory(root: string): GitignoreResult {
  return appendBlock(root, MEM_MARK, MEM_ENTRIES, MEM_END);
}

/** The .hunch memory subdirs un-published by a private migration (git pathspecs). */
export const HUNCH_MEMORY_DIRS = MEM_ENTRIES.map((e) => e.replace(/\/$/, ""));
