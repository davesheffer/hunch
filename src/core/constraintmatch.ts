/** Optional CONTENT matcher for a constraint: a regex tested against the lines a
 *  diff/edit ADDS. When a constraint carries one, the gate decides a violation by
 *  CONTENT (the rule was actually broken) instead of by bare SCOPE-touch.
 *
 *  Why this matters: scope-touch enforcement is so blunt that strict had to fail
 *  OPEN once a guarded file changed (the "staleness" gate) or it would block every
 *  edit in scope — which silently retracts the teeth over a file's normal life
 *  (dec_e0a36efbf5). A content match is verifiable PER COMMIT, so it needs no
 *  staleness proxy: a vouched, content-matched invariant keeps blocking the actual
 *  violation across the whole life of the file, and stays quiet on edits that don't
 *  break it. Bad user/LLM regex is compiled defensively and is simply inert. */
export function constraintMatcher(pattern?: string | null): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null; // malformed pattern → inert, never throws
  }
}

/** The enforceable CODE of an added line: a comment carries no invariant, so a rule
 *  must not fire on it (a `// we avoid lodash` note is not a violation). We strip
 *  comments but NOT string literals — the thing a matcher most often targets, an
 *  import specifier (`from "lodash"`), IS a string, so stripping strings would blind
 *  the matcher to the real violation. A comment-only line → "". */
export function matchableCode(line: string): string {
  if (/^\s*(\/\/|\/\*|\*)/.test(line)) return ""; // // line, /* block, or * JSDoc-continuation
  return line.replace(/\s+\/\/.*$/, ""); // drop a trailing inline // comment (keeps "://" in URLs/strings)
}

/** True iff any ADDED line's CODE trips the constraint's content matcher. */
export function contentViolates(re: RegExp | null, addedLines: string[]): boolean {
  if (!re) return false;
  return addedLines.some((l) => re.test(matchableCode(l)));
}
