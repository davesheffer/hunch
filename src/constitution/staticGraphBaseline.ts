import { CODE_EXTENSIONS } from "../extractors/languages.js";
import {
  replacementFreeCommitFiles,
  replacementFreeExactCommit,
  replacementFreeIsAncestorOrSame,
} from "./replacementFreeGit.js";

const touchesGraphOrCheckoutInputs = (files: string[]): boolean =>
  files.some((file) =>
    CODE_EXTENSIONS.some((extension) => file.endsWith(extension))
    || file === ".gitattributes"
    || file.endsWith("/.gitattributes"));

/** Canonical committed identity for the deterministic static graph.
 *
 * Public Hunch pumping creates clone-local commits containing `.hunch/` JSON and
 * sometimes refreshed grounding docs. Those commits do not change anything the
 * indexer parses, so binding a shared static receipt to their local SHA makes the
 * same graph produce different artifact ids in otherwise identical clones. Walk
 * first-parent until the newest indexed-code or checkout-attribute change instead.
 * Attributes are a boundary because proof replay validates them before materializing
 * exact source bytes. A merge is always a boundary: its resolution can change the
 * effective tree even when a simple diff listing is incomplete. Reverts touch code
 * and therefore remain distinct. */
export function canonicalStaticGraphBaseline(root: string, ref = "HEAD"): string {
  const repositoryRef = replacementFreeExactCommit(root, ref);
  if (!repositoryRef) throw new Error(`static graph baseline needs a resolvable Git commit, got ${ref}`);
  let current = repositoryRef;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    if (replacementFreeExactCommit(root, `${current}^2`)) return current;
    if (touchesGraphOrCheckoutInputs(replacementFreeCommitFiles(root, current))) return current;
    // With no indexed-code commit at all, the repository root is the one
    // cross-clone-resolvable anchor for the empty static graph. Returning the
    // caller's docs/memory-only HEAD would reintroduce clone-local receipt churn.
    const parent = replacementFreeExactCommit(root, `${current}^1`);
    if (!parent) return current;
    if (parent === current) return repositoryRef;
    current = parent;
  }
  return current;
}

export function isAncestorOrSame(root: string, ancestor: string, descendant: string): boolean {
  return replacementFreeIsAncestorOrSame(root, ancestor, descendant);
}
