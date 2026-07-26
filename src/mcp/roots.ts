/**
 * Resolve MCP client roots to the one repository this server may safely serve.
 *
 * A server process keeps the cwd it was spawned with, while the client can move to
 * another workspace or linked worktree. MCP roots are the client-neutral protocol
 * mechanism for following that change.
 */
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findRoot, HUNCH_DIR, isDir } from "../core/paths.js";

function toPath(uri: string): string {
  if (!uri.startsWith("file:")) return "";
  try {
    return fileURLToPath(uri);
  } catch {
    return "";
  }
}

function rootStart(path: string): string {
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) return path;
    if (stat.isFile()) return dirname(path);
  } catch {
    // Missing/inaccessible roots are unusable.
  }
  return "";
}

/**
 * Returns null when several advertised repositories are equally plausible.
 * The roots protocol exposes a set of URI/name pairs, not an "active root" bit;
 * choosing the first Hunch store in that case could silently write repo B's
 * decision into repo A.
 */
export function resolveActiveRoot(rootUris: readonly string[], fallbackCwd: string): string | null {
  const candidates: string[] = [];
  for (const uri of rootUris) {
    const start = rootStart(toPath(uri));
    if (!start) continue;
    const root = findRoot(start);
    if (!candidates.includes(root)) candidates.push(root);
  }

  if (!candidates.length) return findRoot(fallbackCwd);
  if (candidates.length === 1) return candidates[0]!;

  const withStore = candidates.filter((candidate) => isDir(join(candidate, HUNCH_DIR)));
  return withStore.length === 1 ? withStore[0]! : null;
}
