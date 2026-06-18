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
];

export interface GitignoreResult {
  path: string;
  action: "created" | "appended" | "unchanged";
}

export function ensureGitignore(root: string): GitignoreResult {
  const path = join(root, ".gitignore");
  const block = [MARK, ...ENTRIES, END].join("\n");
  if (!existsSync(path)) {
    writeFileSync(path, block + "\n");
    return { path, action: "created" };
  }
  const cur = readFileSync(path, "utf8");
  if (cur.includes(MARK)) return { path, action: "unchanged" }; // already managed
  const sep = cur.endsWith("\n") || cur.length === 0 ? "" : "\n";
  writeFileSync(path, `${cur}${sep}${block}\n`);
  return { path, action: "appended" };
}
