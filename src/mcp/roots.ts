/**
 * MCP `roots` → the workspace the CLIENT is actually in.
 *
 * The server's own cwd is fixed when the client spawns it, so it cannot follow the
 * user into a git worktree opened mid-session: captures keep landing in the spawn
 * directory (normally the primary checkout, on the default branch) instead of on the
 * branch the work is on. The protocol's `roots` capability is the supported way to
 * learn where the client is working, so prefer an advertised root and fall back to
 * the spawn cwd when the client advertises none (unsupporting clients are unaffected).
 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { findRoot, isDir, HUNCH_DIR } from "../core/paths.js";

/** `file://` URI or plain path → path, or "" when it is neither. */
function toPath(uriOrPath: string): string {
  if (!uriOrPath) return "";
  if (!uriOrPath.startsWith("file:")) return uriOrPath;
  try {
    return fileURLToPath(uriOrPath);
  } catch {
    return "";
  }
}

/**
 * The root a capture should be written to, given the roots the client advertised.
 *
 * Each advertised root is normalised through `findRoot`, so a subdirectory resolves to
 * its repo. Roots that do not exist are ignored rather than trusted. When several
 * usable roots are advertised, one that already carries a `.hunch` store wins — that is
 * the repo whose memory is being written; otherwise the first usable root is used.
 *
 * Trust note: this widens where memory can be homed. Previously the root came only from
 * our own spawn cwd; now a client asserts it. `findRoot` falls back to the literal path
 * when it finds no `.git`/`.hunch` walking up, so a client advertising a directory outside
 * any repo will home memory there. That is deliberate — the client is the authority on its
 * own workspace, and a repo that already has a store is preferred over a bare directory —
 * but it does mean a buggy client can point memory somewhere unexpected.
 */
export function resolveActiveRoot(rootUris: readonly string[], fallbackCwd: string): string {
  const candidates: string[] = [];
  for (const uri of rootUris) {
    const p = toPath(uri);
    if (!p || !isDir(p)) continue;
    const r = findRoot(p);
    if (!candidates.includes(r)) candidates.push(r);
  }
  const withStore = candidates.find((c) => isDir(join(c, HUNCH_DIR)));
  if (withStore) return withStore;
  const [first] = candidates;
  return first ?? findRoot(fallbackCwd);
}
