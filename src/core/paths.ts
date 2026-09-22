/** Filesystem layout for the Hunch (DESIGN.md §6 folder structure). */
import { join } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const HUNCH_DIR = ".hunch";

/** Canonicalize a free-form path/target to forward-slash form (Hunch stores every
 *  path with "/" — git emits it on all OSes — so any user- or agent-supplied
 *  target must be normalized before comparison, otherwise a Windows caller passing
 *  `src\auth\session.ts` never matches the stored `src/auth/session.ts`). Safe on
 *  symbol names too: they contain no backslashes. This does NOT make a path
 *  repo-relative — an absolute path passes through with its separators flipped,
 *  unchanged otherwise; use `repoRelativeTarget` for that.
 *
 *  Inherently ambiguous for a string like `docs/notes\notes.md`: it could be a
 *  Windows-style path with a literal separator, or a POSIX path whose filename
 *  legitimately contains a backslash BYTE (illegal on Windows, legal on
 *  POSIX/git) — the string alone can't say which, and this function always
 *  assumes the former. A caller that can check the filesystem/git history and
 *  needs the correct answer for a real file should decide from that evidence
 *  instead of trusting this blindly. */
export function toPosixTarget(target: string): string {
  return target.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** realpath a path even if it doesn't exist yet (e.g. a new file an agent is about
 *  to Write, or a glob whose concrete segments aren't literal): resolve the longest
 *  existing ancestor, then re-append the missing tail. Idempotent on an
 *  already-resolved path. */
export function realpathNorm(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p; // hit the root; nothing more to resolve
    return join(realpathNorm(parent), basename(p));
  }
}

/** Rewrite an ABSOLUTE target to repo-relative POSIX form when it falls inside
 *  `root`. Hunch's stored paths (symbols, constraint scopes, ...) are always
 *  repo-relative, so a caller that hands over an absolute edit-payload path
 *  matched nothing (issue #296: hunch_check_constraints / hunch_blast_radius
 *  returned empty for an absolute target that plainly had a matching rule). A
 *  relative target, a glob, or an absolute path outside `root` passes through
 *  unchanged (toPosixTarget'd) — there is nothing safe to rewrite it to.
 *
 *  BOTH ends are realpath-normalized before the relative-path computation: on
 *  macOS `process.cwd()` (hence `findRoot`) resolves /var → /private/var, but a
 *  hook event's `file_path` arrives UN-resolved, so a naive `relative()` yields a
 *  bogus "../" path under a symlinked root (/var, /tmp, symlinked $HOME) and the
 *  caller treats the file as outside the repo, silently dropping all context
 *  (dec_e0a36efbf5). */
export function repoRelativeTarget(target: string, root: string): string {
  const t = toPosixTarget(target);
  const looksAbsolute = isAbsolute(t) || /^[a-zA-Z]:/.test(t);
  if (!looksAbsolute) return t;
  // `root` is posix'd too, not just `target`: realpathNorm's fallback walk decomposes
  // by "/" (via node:path, which on a POSIX host does NOT treat "\" as a separator),
  // so an un-posix'd root and a posix'd target would decompose into differently-shaped
  // ancestor chains and never share a common realpath'd prefix.
  const rel = toPosixTarget(relative(realpathNorm(toPosixTarget(root)), realpathNorm(t)));
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return t;
  return rel;
}

/** True when `target` (already repo-relative POSIX form) names a regular FILE
 *  that really exists inside `root`. The LAST-RESORT half of the "is this a real
 *  path" question: `isIndexedPath` answers it from graph data alone, but a real
 *  working-tree file with zero tree-sitter symbols and no covering component
 *  glob is invisible to it, so it fell through to the suffix tier and leaked an
 *  unrelated same-basename file's records (issue #334). Callers consult the
 *  index FIRST and only fall back here, so a deleted-but-still-indexed path and
 *  a time-travel (`asOf`) query keep answering exactly as before.
 *
 *  Deliberately narrow: an absolute path (or a Windows drive letter) and any
 *  target escaping `root` via ".." are rejected rather than resolved — the
 *  caller has already run `repoRelativeTarget`, so anything still absolute is
 *  outside the repo. A DIRECTORY is false: directory targets must keep flowing
 *  to `structure()`'s dir tier. Any fs error (missing, EACCES, ...) → false.
 *
 *  Containment is checked twice: lexically, then again on the REALPATHS. `statSync`
 *  follows symlinks, so an in-repo `link -> /outside` would otherwise make
 *  `isRepoFile(root, "link/secret.ts")` true and turn this into a one-bit existence
 *  oracle for paths outside the repo. A symlinked file pointing at another file
 *  INSIDE the repo stays true. */
export function isRepoFile(root: string, target: string): boolean {
  const t = toPosixTarget(target);
  if (!t || isAbsolute(t) || /^[a-zA-Z]:/.test(t)) return false;
  const abs = resolve(root, t);
  const rel = relative(resolve(root), abs);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  try {
    if (!statSync(abs).isFile()) return false;
    const realRel = relative(realpathNorm(resolve(root)), realpathSync.native(abs));
    return !!realRel && realRel !== ".." && !realRel.startsWith(`..${sep}`) && !isAbsolute(realRel);
  } catch {
    return false;
  }
}

export interface HunchPaths {
  /** Repo root (where .hunch/ lives). */
  root: string;
  hunch: string;
  sqlite: string;
  /** `.hunch/manifest.json` — records the on-disk schema version. */
  manifest: string;
  /** `.hunch/config.json` — user runtime config (firmness, etc.). */
  config: string;
  dir(kind: string): string;
}

export function hunchPaths(root: string): HunchPaths {
  const hunch = join(root, HUNCH_DIR);
  return {
    root,
    hunch,
    sqlite: join(hunch, "hunch.sqlite"),
    manifest: join(hunch, "manifest.json"),
    config: join(hunch, "config.json"),
    dir: (kind: string) => join(hunch, kind),
  };
}

/** Build paths for a hunch-layout directory given DIRECTLY — i.e. `hunchDir` IS
 *  the dir holding the kind subdirs (decisions/, bugs/, …). Used for an external
 *  PRIVATE overlay store (HUNCH_PRIVATE_DIR), which lives in a separate repo the
 *  user controls rather than under the current repo's `.hunch/`. */
export function hunchPathsForDir(hunchDir: string): HunchPaths {
  const lexical = resolve(hunchDir);
  // An explicitly configured PRIVATE overlay may intentionally be a
  // final-component symlink to a distinct physical repository. Resolve that
  // user-selected root before handing it to JsonStore; public hunchPaths()
  // deliberately does not do this, so a committed public `.hunch` symlink and
  // every kind/record symlink remain fail-closed.
  let hunch = lexical;
  try {
    if (statSync(lexical).isDirectory()) hunch = realpathSync(lexical);
  } catch { /* missing overlay root is created at the lexical location */ }
  return {
    root: dirname(hunch),
    hunch,
    sqlite: join(hunch, "hunch.sqlite"),
    manifest: join(hunch, "manifest.json"),
    config: join(hunch, "config.json"),
    dir: (kind: string) => join(hunch, kind),
  };
}

/** Walk up from `start` to the nearest dir containing a .hunch/ dir OR a .git
 *  (repo boundary), else `start`. Lets `hunch` run from subdirs. A `.git`
 *  WITHOUT `.hunch` stops the walk: an ancestor `.hunch` above the repo
 *  boundary belongs to some other scope (e.g. a stray ~/.hunch) and must never
 *  hijack a fresh repo — init would scaffold, index, and scan OUTSIDE the repo. */
export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function findRoot(start: string = process.cwd()): string {
  let cur = resolve(start);
  for (;;) {
    if (isDir(join(cur, HUNCH_DIR))) return cur; // a `.hunch` regular file is not a root
    if (existsSync(join(cur, ".git"))) return cur; // repo boundary — .git file (worktree) counts
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return resolve(start);
}
