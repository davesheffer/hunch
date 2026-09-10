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
import { execFileSync } from "node:child_process";
import { parseGroundingCounts, stripCountsMatch } from "./groundingLag.js";

// `\r?\n` (not a bare `\n`) throughout: on a CRLF worktree every diff3 marker
// line is itself `\r\n`-terminated, and a bare `\n` fails to match ANY of
// them. `^...$` with /m anchor each marker at its own line start rather than
// requiring a specific preceding/following literal newline, so a hunk whose
// ours or theirs side is EMPTY (one side deleted the line, the other edited
// it) still matches — with a literal `\n` requirement there, git's real
// output for that shape has no such newline to match, so the whole hunk
// silently fails to match at all.
const CONFLICT_RE = /^<<<<<<< ours\r?\n([\s\S]*?)^\|\|\|\|\|\|\| base\r?\n[\s\S]*?^=======\r?\n([\s\S]*?)^>>>>>>> theirs[^\n]*\r?\n?/gm;

function isCountsOnlyHunk(ours: string, theirs: string): boolean {
  const o = parseGroundingCounts(ours);
  const t = parseGroundingCounts(theirs);
  if (!o || !t) return false;
  return stripCountsMatch(ours, o.match) === stripCountsMatch(theirs, t.match);
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
  // Defense in depth: a hunk shape CONFLICT_RE fails to recognize must never
  // read as resolved just because the callback never ran on it — if any
  // marker survives, this is a real conflict, full stop.
  if (!allResolved || resolved.includes("<<<<<<< ours")) return { conflict: true, text: diff3Text };
  return { conflict: false, text: resolved };
}

/** Run `git merge-file --diff3` on real files and resolve the result.
 *  `write: null` means git itself errored (e.g. one side is binary) — never
 *  guess content in that case; leave the file exactly as git already
 *  populated it before invoking this driver. */
export function mergeGroundingFile(basePath: string, oursPath: string, theirsPath: string): { conflict: boolean; write: string | null } {
  try {
    const merged = execFileSync("git", ["merge-file", "-p", "--diff3", "-L", "ours", "-L", "base", "-L", "theirs", oursPath, basePath, theirsPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { conflict: false, write: merged };
  } catch (e) {
    const err = e as { stdout?: string | Buffer; status?: number | null };
    const status = typeof err.status === "number" ? err.status : -1;
    // `git merge-file`'s exit status is the number of conflicting hunks
    // (1-127) on a genuine 3-way merge attempt. Anything else (a negative
    // status, or >127) means git itself errored — e.g. "Cannot merge binary
    // files" exits 255 with EMPTY stdout — and treating that as diff3 output
    // silently truncates the file to nothing.
    if (status < 1 || status > 127) return { conflict: true, write: null };
    const out = typeof err.stdout === "string" ? err.stdout : (err.stdout?.toString() ?? "");
    const res = resolveGroundingConflicts(out);
    return { conflict: res.conflict, write: res.text };
  }
}
