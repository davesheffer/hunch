/** Filesystem layout for the Brain (DESIGN.md §6 folder structure). */
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const BRAIN_DIR = ".brain";

export interface BrainPaths {
  /** Repo root (where .brain/ lives). */
  root: string;
  brain: string;
  sqlite: string;
  dir(kind: string): string;
}

export function brainPaths(root: string): BrainPaths {
  const brain = join(root, BRAIN_DIR);
  return {
    root,
    brain,
    sqlite: join(brain, "brain.sqlite"),
    dir: (kind: string) => join(brain, kind),
  };
}

/** Walk up from `start` to find the nearest repo containing a .brain/ dir,
 *  else the nearest git repo, else `start`. Lets `brain` run from subdirs. */
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
    if (isDir(join(cur, BRAIN_DIR))) return cur; // a `.brain` regular file is not a root
    if (gitFallback === null && existsSync(join(cur, ".git"))) gitFallback = cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return gitFallback ?? resolve(start);
}
