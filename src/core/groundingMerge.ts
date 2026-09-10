/**
 * Merge driver for the generated grounding block's record-counts sentence
 * (dec_ba5b0dfa22, superseding dec_91da20a46b's "drop the counts sentence"):
 * resolves a HARD git conflict when it is confined to that one line by
 * keeping `ours`'s sentence as a placeholder. The merged store's counts can
 * only be >= ours's (decisions/bugs/constraints/components/policies are
 * append-only), so the doc then reads as "lagging" — which the post-merge
 * hook's `hunch grounding --refresh` already self-heals — never as "ahead",
 * the one signal fnd_6391b4242f depends on (a doc counting a record the repo
 * doesn't carry). Any conflict outside the counts sentence, anywhere in the
 * file, is left untouched with standard diff3 markers for a human to resolve.
 */
import { parseGroundingCounts } from "./groundingLag.js";

const CONFLICT_RE = /^<<<<<<< ours\n([\s\S]*?)\n\|\|\|\|\|\|\| base\n[\s\S]*?\n=======\n([\s\S]*?)\n>>>>>>> theirs$/gm;

function isCountsOnlyHunk(ours: string, theirs: string): boolean {
  const o = parseGroundingCounts(ours);
  const t = parseGroundingCounts(theirs);
  if (!o || !t) return false;
  return ours.replace(o.match, "<counts>") === theirs.replace(t.match, "<counts>");
}

/** Given `git merge-file --diff3 -L ours -L base -L theirs` output for a
 *  generated grounding doc, auto-resolve it if every conflicting hunk is
 *  confined to the counts sentence; otherwise return it untouched. */
export function resolveGroundingConflicts(diff3Text: string): { conflict: boolean; text: string } {
  if (!diff3Text.includes("<<<<<<< ours")) return { conflict: false, text: diff3Text };
  let allResolved = true;
  const resolved = diff3Text.replace(CONFLICT_RE, (whole: string, ours: string, theirs: string) => {
    if (!isCountsOnlyHunk(ours, theirs)) {
      allResolved = false;
      return whole;
    }
    return ours;
  });
  return allResolved ? { conflict: false, text: resolved } : { conflict: true, text: diff3Text };
}
