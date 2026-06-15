/** Filesystem layout for the Hunch (DESIGN.md §6 folder structure). */
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const HUNCH_DIR = ".hunch";

export interface HunchPaths {
  /** Repo root (where .hunch/ lives). */
  root: string;
  hunch: string;
  sqlite: string;
  /** `.hunch/manifest.json` — records the on-disk schema version. */
  manifest: string;
  dir(kind: string): string;
}

export function hunchPaths(root: string): HunchPaths {
  const hunch = join(root, HUNCH_DIR);
  return {
    root,
    hunch,
    sqlite: join(hunch, "hunch.sqlite"),
    manifest: join(hunch, "manifest.json"),
    dir: (kind: string) => join(hunch, kind),
  };
}

/** Walk up from `start` to find the nearest repo containing a .hunch/ dir,
 *  else the nearest git repo, else `start`. Lets `hunch` run from subdirs. */
export function findRoot(start: string = process.cwd()): string {
  let cur = resolve(start);
  let gitFallback: string | null = null;
  const isDir = (p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  for (;;) {
    if (isDir(join(cur, HUNCH_DIR))) return cur; // a `.hunch` regular file is not a root
    if (gitFallback === null && existsSync(join(cur, ".git"))) gitFallback = cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return gitFallback ?? resolve(start);
}
