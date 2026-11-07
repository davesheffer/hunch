import { join } from "node:path";
import { findRoot, realpathNorm } from "../core/paths.js";
import { isOptedOut, OPT_OUT_FILE, optOutMarkerAt } from "../integrations/optout.js";

/** The marker gating `path` (the cwd, or a location a command writes to). Its own store
 *  or repository root (`findRoot`: git-less stores included) counts first; inside a
 *  repository the walk then passes any nested `.hunch` store up to the repository
 *  (#488). A stray marker in a non-store, non-repository ancestor (e.g. ~) gates nothing. */
export function markerFor(path: string): string | null {
  const real = realpathNorm(path);
  const root = findRoot(real);
  if (isOptedOut(root)) return join(root, OPT_OUT_FILE);
  return optOutMarkerAt(real, { withinRepo: true });
}
