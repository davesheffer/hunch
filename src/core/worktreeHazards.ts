/**
 * Hazards in removing a linked worktree. `git worktree remove` on Windows follows a
 * junction (a linked `node_modules`, say) and deletes the TARGET's contents, which can
 * be another checkout's dependency tree. Doctor names each such link with the command
 * that removes only the link, to run first.
 */
import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface OutwardLink {
  /** The top-level entry name in the worktree. */
  name: string;
  /** Absolute path of the link itself. */
  path: string;
  /** Where it points (as recorded when its target is gone). */
  target: string;
}

const key = (path: string): string => process.platform === "win32" ? path.toLowerCase() : path;

function real(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/** The worktree's top-level entries that are links (symlinks or junctions) resolving
 *  outside it, a dangling one included. Read-only; a missing worktree has none. */
export function outwardLinks(worktree: string): OutwardLink[] {
  const root = real(worktree);
  if (!root) return [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: OutwardLink[] = [];
  for (const name of names.sort()) {
    const path = resolve(root, name);
    try {
      if (!lstatSync(path).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    let target = real(path);
    // A link to a file is no hazard: git deletes the link, and rmdir could not remove it.
    if (target) {
      try {
        if (!statSync(target).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    if (!target) {
      try {
        const raw = readlinkSync(path).replace(/^\\\\\?\\/, "");
        target = isAbsolute(raw) ? resolve(raw) : resolve(dirname(path), raw);
      } catch {
        target = path;
      }
    }
    const rel = relative(key(root), key(target));
    const inside = rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    if (!inside) out.push({ name, path, target });
  }
  return out;
}

/** The command that removes the link at `path` and leaves its target alone. */
export function unlinkHint(path: string): string {
  return process.platform === "win32" ? `cmd /c rmdir "${path}"` : `rm "${path}"`;
}
