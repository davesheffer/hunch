/** Filesystem layout for the Hunch (DESIGN.md §6 folder structure). */
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const HUNCH_DIR = ".hunch";

/** Canonicalize a free-form path/target to repo-relative POSIX form. Hunch stores
 *  every path with forward slashes (git emits "/" on all OSes), so any user- or
 *  agent-supplied target must be normalized before comparison — otherwise a
 *  Windows caller passing `src\auth\session.ts` never matches the stored
 *  `src/auth/session.ts`. Safe on symbol names too: they contain no backslashes. */
export function toPosixTarget(target: string): string {
  return target.replace(/\\/g, "/").replace(/^\.\//, "");
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
  const hunch = resolve(hunchDir);
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
export function findRoot(start: string = process.cwd()): string {
  let cur = resolve(start);
  const isDir = (p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  for (;;) {
    if (isDir(join(cur, HUNCH_DIR))) return cur; // a `.hunch` regular file is not a root
    if (existsSync(join(cur, ".git"))) return cur; // repo boundary — .git file (worktree) counts
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return resolve(start);
}
