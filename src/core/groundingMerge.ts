/**
 * Merge driver for the generated grounding block's record-counts sentence.
 *
 * When two branches each regenerate the block, git reports a hard conflict on
 * that one line. This driver resolves a conflict confined to it by taking the
 * element-wise maximum of the two sides' counts.
 *
 * "Take ours" would be simpler but could discard a higher count, and a higher
 * count may be the ahead-of-store signal that freshness classification relies
 * on. The maximum is safe: append-only kinds only grow and the merged store is
 * the union of both sides, so the result reads as "lagging" (self-healed by the
 * post-merge `hunch grounding --refresh`), never falsely "ahead". An inflated
 * count from a side that genuinely carries the defect survives and still reads
 * "ahead".
 *
 * A conflict anywhere else is left untouched, with standard diff3 markers.
 */
import { execFileSync } from "node:child_process";
import { parseGroundingCounts, stripCountsMatch, renderCountsMatch, type GroundingCounts } from "./groundingLag.js";
import { normalizeEol } from "./eol.js";

// The entry point normalizes EOL before matching. `^...$` with /m anchors
// each marker at its own line start rather than
// demanding a literal newline before or after a marker: a hunk with an empty
// side (one side deleted the line, the other edited it) has no such newline in
// git's real output, so a pattern requiring one would silently miss it.
const CONFLICT_RE = /^<<<<<<< ours\n([\s\S]*?)^\|\|\|\|\|\|\| base\n[\s\S]*?^=======\n([\s\S]*?)^>>>>>>> theirs[^\n]*\n?/gm;

/** Resolve one hunk's ours/theirs text, or null when it is not confined to the counts sentence. */
function resolveHunk(ours: string, theirs: string): string | null {
  const o = parseGroundingCounts(ours);
  const t = parseGroundingCounts(theirs);
  if (!o || !t) return null;
  if (stripCountsMatch(ours, o.match) !== stripCountsMatch(theirs, t.match)) return null;
  const keys = Object.keys(o.counts) as Array<keyof GroundingCounts>;
  if (keys.every((k) => o.counts[k] >= t.counts[k])) return ours;
  const combined = { ...o.counts };
  for (const k of keys) combined[k] = Math.max(o.counts[k], t.counts[k]);
  return ours.replace(o.match, () => renderCountsMatch(combined));
}

/** Input is `git merge-file --diff3 -L ours -L base -L theirs` output. */
export function resolveGroundingConflicts(diff3Text: string): { conflict: boolean; text: string } {
  if (!diff3Text.includes("<<<<<<< ours")) return { conflict: false, text: diff3Text };
  const eol = diff3Text.includes("\r\n") ? "\r\n" : diff3Text.includes("\r") ? "\r" : "\n";
  const normalized = normalizeEol(diff3Text);
  let allResolved = true;
  const resolved = normalized.replace(CONFLICT_RE, (whole: string, ours: string, theirs: string) => {
    const out = resolveHunk(ours, theirs);
    if (out === null) {
      allResolved = false;
      return whole;
    }
    return out;
  });
  if (!allResolved || resolved.includes("<<<<<<< ours")) return { conflict: true, text: diff3Text };
  return { conflict: false, text: eol === "\n" ? resolved : resolved.replace(/\n/g, eol) };
}

/** Three-way merge of a grounding doc; the CLI writes `write` to the ours path and exits 1 on conflict. */
export function mergeGroundingFile(basePath: string, oursPath: string, theirsPath: string): { conflict: boolean; write: string | null } {
  try {
    const out = execFileSync("git", ["merge-file", "-p", "--diff3", "-L", "ours", "-L", "base", "-L", "theirs", oursPath, basePath, theirsPath],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { conflict: false, write: out };
  } catch (e) {
    const err = e as { status?: unknown; stdout?: string | Buffer | null };
    const status = err.status;
    if (typeof status === "number" && status >= 1 && status <= 127) {
      const res = resolveGroundingConflicts(err.stdout == null ? "" : String(err.stdout));
      return { conflict: res.conflict, write: res.text };
    }
    return { conflict: true, write: null };
  }
}
