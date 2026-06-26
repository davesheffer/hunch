/** Precise, AST-grounded matching for a constraint's content — the primitive behind
 *  "this change actually BREAKS the rule" (dec_… content-matched constraints).
 *
 *  A constraint can forbid, in precision order:
 *   - deps:     an external import (matched against the PARSED import set, so a comment
 *               or a string literal that merely names the module can't trip it; a
 *               submodule import like "lodash/groupBy" is caught by "lodash").
 *   - symbols:  an identifier added in scoped code (whole-word, comments stripped).
 *   - patterns: a line regex (lint-grade last resort; comments stripped, strings kept).
 *
 *  Deciding a violation by CONTENT is verifiable per commit, so a content-matched
 *  invariant is immune to file-change "staleness" and keeps its teeth across the file's
 *  whole life. The same matcher backs the Veto Guard's tripwires (one matcher, audited
 *  once) — see HunchStore.matchTripwire. */

export interface Forbids {
  deps: string[];
  symbols: string[];
  patterns: string[];
}

export interface ForbidMatch {
  tier: "dep" | "symbol" | "pattern";
  evidence: string[];
}

const EMPTY: Forbids = { deps: [], symbols: [], patterns: [] };

/** Walk the precision-first ladder against an analyzed diff/edit: dep (parsed import,
 *  exact or submodule) > symbol (whole-word identifier in scoped code) > pattern (scoped
 *  regex). Returns the highest-precision match, or null. */
export function matchForbids(f: Forbids, addedDeps: Set<string>, scopedAdded: string[]): ForbidMatch | null {
  const codeLines = scopedAdded.map(matchableCode); // comments stripped once, strings kept
  // dep tier: a forbidden dep (or a submodule of it) must be a genuinely-new external
  // import (addedDeps, parsed) AND actually imported on a scoped line — never a mention
  // in a comment or string. addedDeps comes from the import parser, so it is already
  // comment/string-immune; the scoped importsDep check stops an out-of-scope import from
  // tripping an in-scope edit.
  const hitDeps: string[] = [];
  for (const dep of f.deps) {
    const added = [...addedDeps].find((d) => d === dep || d.startsWith(`${dep}/`));
    if (added && codeLines.some((l) => importsDep(l, added))) hitDeps.push(added);
  }
  if (hitDeps.length) return { tier: "dep", evidence: hitDeps.map((d) => `+import ${d}`) };

  const hitSyms = f.symbols.filter((s) => {
    const re = new RegExp(`\\b${escapeRe(s)}\\b`);
    return codeLines.some((l) => re.test(l));
  });
  if (hitSyms.length) return { tier: "symbol", evidence: hitSyms.map((s) => `+${s}`) };

  for (const p of f.patterns) {
    const re = safeRe(p);
    if (!re) continue;
    const hit = codeLines.find((l) => re.test(l));
    if (hit) return { tier: "pattern", evidence: [`/${p}/ matched: ${hit.trim().slice(0, 80)}`] };
  }
  return null;
}

/** A constraint's effective forbids: its structured `forbids` plus a legacy `--match`
 *  regex folded into the pattern tier (back-compat with v0.35). null when it has none. */
export function effectiveForbids(c: { forbids?: Forbids | null; match?: string | null }): Forbids | null {
  const base = c.forbids ?? EMPTY;
  const patterns = c.match ? [...base.patterns, c.match] : base.patterns;
  const f: Forbids = { deps: base.deps, symbols: base.symbols, patterns };
  return f.deps.length || f.symbols.length || f.patterns.length ? f : null;
}

/** The external import module names on a set of raw lines (for the edit-time hook,
 *  which sees proposed lines, not a parsed diff). Relative imports are ignored. */
export function importedDeps(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of lines) {
    const l = matchableCode(raw);
    const m = l.match(/(?:^\s*import\b[^'"]*|^\s*\}?\s*from\s+|\brequire\(\s*)['"]([^'"]+)['"]/);
    if (m && m[1] && !m[1].startsWith(".")) out.add(m[1]);
  }
  return out;
}

/** Best-effort: derive a forbidden DEP from a natural-language rule like "never import
 *  lodash" / "don't use the axios package" — so the seamless capture path (a human
 *  correction → enforced constraint) mints a PRECISE matcher, not a scope-only rule that
 *  goes stale. Conservative: only fires on an explicit import/require verb + a
 *  module-shaped token; returns null otherwise (caller falls back to scope-only). */
export function deriveForbids(rule: string, knownDeps?: readonly string[]): Forbids | null {
  // Derive ONLY from a NEGATIVE rule with an UNAMBIGUOUS import verb. "use"/"add" are
  // deliberately excluded: "don't use react hooks" names hooks, not react, and "never use
  // synchronous fs" names no dependency at all — over-deriving there mints a wrong or
  // never-firing rule on the seamless path. Under-deriving is safe (caller falls back to a
  // scope-only rule + the "add --forbid-dep" warning); over-deriving is not.
  if (!/\b(never|don'?t|do\s+not|avoid|stop|without|ban|banned|forbid|forbidden|prohibit|not\s+allowed|no\s+longer)\b/i.test(rule)) return null;
  const m = rule.match(/\b(?:import(?:ing)?|requir(?:e|ing)|depend(?:s|ing)?\s+on)\s+(?:from\s+|the\s+)?["'`]?(@?[a-z0-9][\w.@/-]*)["'`]?/i);
  if (!m || !m[1]) return null;
  const dep = m[1].replace(/[).,;:'"`]+$/, "").toLowerCase();
  if (!dep || dep.length < 2 || /\s/.test(dep) || STOP_TOKENS.has(dep)) return null;
  // When the caller can supply the repo's real dependencies, only auto-mint a matcher for a
  // dep that ACTUALLY exists — so a typo or a non-dependency concept ("never import the old
  // helper") doesn't silently create a never-firing rule. Submodule-aware both ways. No list
  // supplied (no/unreadable package.json) → skip validation rather than reject everything.
  if (knownDeps && knownDeps.length) {
    const ok = knownDeps.some((d) => {
      const k = d.toLowerCase();
      return k === dep || dep.startsWith(`${k}/`) || k.startsWith(`${dep}/`);
    });
    if (!ok) return null;
  }
  return { deps: [dep], symbols: [], patterns: [] };
}

// English words a forbid-verb might grab that are never a dependency.
const STOP_TOKENS = new Set([
  "strict", "this", "that", "it", "them", "the", "a", "an", "any", "async", "await",
  "const", "let", "var", "new", "type", "types", "care", "caution", "again", "anything",
]);

/** The enforceable CODE of an added line: a comment carries no invariant, so the lint-grade
 *  symbol/pattern tiers must not fire on it (a `// we avoid lodash` note is not a violation).
 *  Strips a line comment, an inline block comment, and a comment-only / JSDoc line — but NOT
 *  string literals, since an import specifier (`from "lodash"`) is itself a string.
 *  Single-pass and line-local, so a multi-line block-comment BODY line (no marker) is NOT
 *  stripped: that residual false-positive is why the DEP tier — gated on the PARSED import
 *  set, immune to any comment — is the precise path for "never import X". */
export function matchableCode(line: string): string {
  if (/^\s*(\/\/|\/\*|\*)/.test(line)) return "";
  return line
    .replace(/\/\*.*?\*\//g, "") // inline /* … */
    .replace(/\s+\/\/.*$/, ""); // trailing // comment (keeps "://" inside strings/URLs)
}

/** Legacy: compile a constraint's `--match` regex defensively (bad regex → inert). */
export function constraintMatcher(pattern?: string | null): RegExp | null {
  return safeRe(pattern);
}

/** True iff any added line's CODE trips a single regex (the v0.35 textual path). */
export function contentViolates(re: RegExp | null, addedLines: string[]): boolean {
  if (!re) return false;
  return addedLines.some((l) => re.test(matchableCode(l)));
}

function safeRe(p?: string | null): RegExp | null {
  if (!p) return null;
  try {
    return new RegExp(p);
  } catch {
    return null;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does a line actually IMPORT `dep` (not merely mention it)? Covers `import x from
 *  "dep"`, `import "dep"`, `} from "dep"`, `require("dep")`. */
function importsDep(line: string, dep: string): boolean {
  return new RegExp(`(?:from|import|require\\(?)\\s*['"]${escapeRe(dep)}['"]`).test(line);
}
