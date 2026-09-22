/**
 * Ensure the project's .gitignore excludes Hunch's DERIVED runtime artifacts: the
 * SQLite index (rebuilt from the committed .hunch/*.json source of truth) and the
 * atomic-write temp files. Without this the MCP server's constant index writes
 * leave the working tree perpetually dirty, which blocks branch switches, pulls,
 * and rebases. The .hunch/*.json graph itself stays TRACKED — only the regenerable
 * index is ignored.
 *
 * Idempotent + merge-safe (con_8460b6770f): appends a single marked block and
 * never rewrites the user's existing entries. Once the block exists, re-running
 * brings ONLY the content between its markers up to the current entry list (so a
 * block written by an older release gains entries added later) and is otherwise
 * byte-identical; everything outside the markers is left untouched.
 */
import { readFileSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeFileAtomic } from "../core/io.js";
import { gitTrackedPaths, gitUntrackCached, isGitRepoRoot } from "../extractors/git.js";

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
  // The strict hook's append-only catch-log: clone-local, never a memory record.
  ".hunch/events.log",
  // The post-merge hook's queue of detected-but-unconfirmed commit-provenance
  // repairs — clone-local scratch state, never committed (`hunch repair-provenance
  // --apply` confirms and clears it).
  ".hunch/pending-commit-repairs.json",
  // Tombstones for commit-repair matches a human rejected via `--drop` — clone-local
  // scratch state, same discipline as the queue above.
  ".hunch/dropped-commit-repairs.json",
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
// Every ENTITY_KINDS directory (src/core/types.ts) must be listed here — guarded by
// test/gitignore.test.ts — plus the non-entity Constitution/ledger directories.
const MEM_ENTRIES = [
  ".hunch/decisions/",
  ".hunch/bugs/",
  ".hunch/constraints/",
  ".hunch/components/",
  ".hunch/resources/",
  ".hunch/conventions/",
  ".hunch/workspaces/",
  ".hunch/evidence/",
  ".hunch/corpora/",
  ".hunch/policies/",
  ".hunch/proofs/",
  ".hunch/plans/",
  ".hunch/dispositions/",
  ".hunch/shadow/",
  ".hunch/symbols/",
  ".hunch/edges/",
  ".hunch/runbooks/",
  ".hunch/findings/",
  ".hunch/tasks/",
  // nuryel.state/1 record kinds (state facets)
  ".hunch/receipts/",
  ".hunch/commitments/",
  ".hunch/derived/",
  ".hunch/entities/",
  ".hunch/relationships/",
  // nuryel.state/1 per-scope change ledgers (subscribe stream + idempotency table)
  ".hunch/changes/",
];

export interface GitignoreResult {
  path: string;
  /** `updated` = an existing managed block was brought up to the current entry list. */
  action: "created" | "appended" | "updated" | "unchanged";
  /** Entries this call newly wrote into the managed block (empty when unchanged). */
  added: string[];
}

function pathIsWithin(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Defense in depth for integration files written automatically after a clone.
 * Refuse symlinks, directories/devices, and hard links; require the canonical
 * target to be the expected top-level file inside the canonical repository root. */
export function assertSafeTopLevelConfigFile(root: string, name: string): string {
  const lexicalRoot = resolve(root);
  const rootStat = lstatSync(lexicalRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`refusing to write integration config through unsafe repository root: ${root}`);
  }
  if (name !== ".gitignore" && name !== ".gitattributes") {
    throw new Error(`refusing unexpected integration config path: ${name}`);
  }
  const canonicalRoot = realpathSync(lexicalRoot);
  const path = join(lexicalRoot, name);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`refusing to write unsafe integration config: ${path}`);
  }
  const canonicalPath = realpathSync(path);
  if (!pathIsWithin(canonicalPath, canonicalRoot) || canonicalPath !== join(canonicalRoot, name)) {
    throw new Error(`refusing integration config outside repository root: ${path}`);
  }
  return path;
}

interface BlockSpan { start: number; end: number; inner: string[] }

const cleanLine = (line: string): string => line.replace(/\r$/, "").trim();

/** Locate a managed block as whole lines: the marker line and the FIRST end-marker
 *  line after it. `null` when either is missing — a hand-damaged block is never
 *  guessed at (con_8460b6770f). Indices are into `text.split("\n")`, whose items
 *  keep a trailing `\r` in a CRLF file. */
function findBlock(lines: string[], mark: string, end: string): BlockSpan | null {
  const start = lines.findIndex((l) => cleanLine(l) === mark);
  if (start < 0) return null;
  const stop = lines.findIndex((l, i) => i > start && cleanLine(l) === end);
  if (stop < 0) return null;
  return { start, end: stop, inner: lines.slice(start + 1, stop).map(cleanLine).filter(Boolean) };
}

/** Rewrite ONLY the lines between an existing block's markers to the current entry
 *  list, keeping the file's line-ending style and every byte outside the markers.
 *  No write (byte-identical) when the block is already current. */
function upgradeBlock(root: string, path: string, cur: string, mark: string, entries: string[], end: string): GitignoreResult {
  const lines = cur.split("\n");
  const span = findBlock(lines, mark, end);
  if (!span) return { path, action: "unchanged", added: [] };
  const cr = lines[span.start]!.endsWith("\r") ? "\r" : "";
  const endCr = lines[span.end]!.endsWith("\r") ? "\r" : "";
  const replacement = [mark + cr, ...entries.map((e) => e + cr), end + endCr];
  const next = [...lines.slice(0, span.start), ...replacement, ...lines.slice(span.end + 1)].join("\n");
  if (next === cur) return { path, action: "unchanged", added: [] };
  const had = new Set(span.inner);
  assertSafeTopLevelConfigFile(root, ".gitignore");
  writeFileAtomic(path, next);
  return { path, action: "updated", added: entries.filter((e) => !had.has(e)) };
}

/** Idempotent + merge-safe write of one marked block (con_8460b6770f): never
 *  rewrites the user's entries outside the markers. A present block is upgraded in
 *  place to the current entry list; an absent one is appended unless the user's own
 *  lines already cover every entry. Re-running on a current file is a no-op. */
function appendBlock(root: string, mark: string, entries: string[], end: string, upgrade = true): GitignoreResult {
  const path = assertSafeTopLevelConfigFile(root, ".gitignore");
  if (!existsSync(path)) {
    assertSafeTopLevelConfigFile(root, ".gitignore");
    writeFileAtomic(path, [mark, ...entries, end].join("\n") + "\n");
    return { path, action: "created", added: [...entries] };
  }
  const cur = readFileSync(path, "utf8");
  if (cur.includes(mark)) { // already managed
    return upgrade ? upgradeBlock(root, path, cur, mark, entries, end) : { path, action: "unchanged", added: [] };
  }
  // Already covered by the user's OWN entries (e.g. a hand-written, commented
  // section listing the same patterns)? Don't append a redundant managed block —
  // that would leave two copies of every ignore. Keep the .gitignore clean.
  const lines = new Set(cur.split("\n").map(cleanLine));
  if (entries.every((e) => lines.has(e))) return { path, action: "unchanged", added: [] };
  const eol = cur.includes("\r\n") ? "\r\n" : "\n";
  const gap = cur.endsWith("\n") || cur.length === 0 ? "" : eol;
  assertSafeTopLevelConfigFile(root, ".gitignore");
  writeFileAtomic(path, `${cur}${gap}${[mark, ...entries, end].join(eol)}${eol}`);
  return { path, action: "appended", added: [...entries] };
}

/** `upgradeExisting: false` only adds a missing block and never rewrites a present
 *  one — for `hunch index`, which also runs in CI and release gates where rewriting
 *  a tracked .gitignore would dirty the checkout. Setup and repair commands upgrade. */
export function ensureGitignore(root: string, opts: { upgradeExisting?: boolean } = {}): GitignoreResult {
  return appendBlock(root, MARK, ENTRIES, END, opts.upgradeExisting ?? true);
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

export interface ManagedGitignoreUpgrade {
  /** The base runtime block, when this repository already has it. */
  base: GitignoreResult | null;
  /** The private-only memory block, when this repository was migrated to an overlay. */
  memory: GitignoreResult | null;
  /** Tracked memory files removed from the git INDEX (the files stay on disk). */
  untracked: string[];
}

/** Bring every EXISTING managed block up to the current entry lists without adding
 *  a block the repository never had (a repair path, not setup). A private-only
 *  block means the repository already declared its memory tree unpublished, so
 *  memory directories that a later release added to that block are also removed
 *  from the git index — never from disk — as `private --migrate` does for the whole
 *  list. */
export function upgradeManagedGitignore(root: string): ManagedGitignoreUpgrade {
  const result: ManagedGitignoreUpgrade = { base: null, memory: null, untracked: [] };
  const path = assertSafeTopLevelConfigFile(root, ".gitignore");
  if (!existsSync(path)) return result;
  if (readFileSync(path, "utf8").includes(MARK)) result.base = ensureGitignore(root);
  if (readFileSync(path, "utf8").includes(MEM_MARK)) {
    result.memory = ignoreHunchMemory(root);
    const dirs = result.memory.added.map((e) => e.replace(/\/$/, ""));
    if (dirs.length && isGitRepoRoot(root)) {
      result.untracked = gitTrackedPaths(root, dirs);
      if (result.untracked.length) gitUntrackCached(root, dirs);
    }
  }
  return result;
}

/** Output lines describing what an upgrade changed; empty when nothing did. */
export function describeGitignoreUpgrade(upgrade: ManagedGitignoreUpgrade): string[] {
  const out: string[] = [];
  if (upgrade.base?.action === "updated") {
    out.push(`.gitignore: Hunch runtime block updated (added ${upgrade.base.added.join(", ") || "nothing; block normalized"})`);
  }
  if (upgrade.memory?.action === "updated") {
    out.push(`.gitignore: private-only memory block updated (added ${upgrade.memory.added.join(", ") || "nothing; block normalized"})`);
  }
  if (upgrade.untracked.length) {
    const shown = upgrade.untracked.slice(0, 5).join(", ") + (upgrade.untracked.length > 5 ? ", ..." : "");
    out.push(`removed ${upgrade.untracked.length} newly ignored memory file(s) from the git index, kept on disk (commit the removal): ${shown}`);
  }
  return out;
}
