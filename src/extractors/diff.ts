/**
 * Structured analysis of a git unified diff (deterministic, no LLM). Turns raw
 * patch text into "what actually changed" — added/removed/changed symbols, new
 * and dropped dependencies, file add/delete/rename — so the synthesis layer can
 * write an INFORMATIVE decision even with no model available.
 *
 * Parsing is hunk-state-aware: file headers ("--- "/"+++ ") are only honored in
 * the pre-hunk region, so a CONTENT line like `+++counter` (source `++counter`)
 * is never mistaken for a header. Symbol classification is PER FILE, so moving a
 * function between files isn't misread as a signature change.
 */

export interface SymbolChange {
  name: string;
  kind: "function" | "class" | "interface" | "trait" | "enum" | "type" | "const";
}

export interface RenamePair {
  from: string;
  to: string;
}

export interface DiffAnalysis {
  filesAdded: string[];
  filesDeleted: string[];
  filesModified: string[];
  filesRenamed: RenamePair[];
  addedSymbols: SymbolChange[];
  removedSymbols: SymbolChange[];
  changedSymbols: SymbolChange[]; // appeared on both sides of the SAME file
  addedDeps: string[]; // new external (non-relative) imports
  removedDeps: string[];
  addedLines: number; // substantive lines only (code + prose, per isSubstantive)
  removedLines: number;
  /** Added line bodies (the "+" content, marker stripped) per file — every file,
   *  not just substantive ones. The text veto's symbol/pattern tiers match against
   *  — call sites, not just declarations, which addedSymbols can't see. Keyed by
   *  the same (new-path) key as perFile. */
  addedLinesByFile: Map<string, string[]>;
}

const DECL_PATTERNS: Array<{ kind: SymbolChange["kind"]; re: RegExp }> = [
  { kind: "class", re: /^\s*(?:(?:final|abstract|readonly)\s+)+class\s+([A-Za-z_][\w]*)/ },
  { kind: "trait", re: /^\s*trait\s+([A-Za-z_][\w]*)/ },
  { kind: "enum", re: /^\s*enum\s+([A-Za-z_][\w]*)/ },
  { kind: "function", re: /^\s*(?:(?:public|protected|private|final|abstract|static)\s+)*function\s*&?\s*([A-Za-z_][\w]*)\s*\(/ },
  { kind: "function", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: "class", re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "interface", re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: "type", re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/ },
  { kind: "const", re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
  { kind: "const", re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function/ },
  { kind: "function", re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/ },
  // No Python-specific class pattern needed: the generic TS `class` pattern above has no
  // trailing-syntax requirement (no `{`/`:`), so it already matches Python's
  // `class Foo(Bar):` header too, and — since declOf() returns on the first match —
  // always wins for Python class lines before any Python-specific pattern would run.
];
import { languageFor, isSubstantive } from "./languages.js";

const IMPORT_RE = /^\s*import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/;
const CONT_IMPORT_RE = /^\s*\}?\s*from\s+['"]([^'"]+)['"]/; // multi-line: "} from 'x'"
const REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/;
const PHP_REQUIRE_RE = /\b(?:require|require_once|include|include_once)\s*(?:\(\s*)?['"]([^'"]+)['"]/;
// "import os" / "import a.b.c" / "import os as o" / "import os, sys" / trailing "# comment".
// Anchored to the END of the line (optional "as alias", comma-separated modules, comment)
// so it matches a COMPLETE Python import statement only — this deliberately rejects
// TypeScript's `import Foo = Bar.Baz;` (import-equals), which would otherwise falsely
// look like a Python "import Foo" prefix match.
const PY_IMPORT_RE =
  /^\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+\w+)?(?:\s*,\s*[A-Za-z_][\w.]*(?:\s+as\s+\w+)?)*\s*(?:#.*)?$/;
const PY_FROM_IMPORT_RE = /^\s*from\s+([.\w]+)\s+import\s+/; // "from os import path" / "from . import x"
const isCode = (p: string) => !!p && languageFor(p) !== null;

function declOf(line: string): SymbolChange | null {
  for (const { kind, re } of DECL_PATTERNS) {
    const m = re.exec(line);
    if (m) return { name: m[1]!, kind };
  }
  return null;
}
function importOf(line: string): string | null {
  const m =
    IMPORT_RE.exec(line) ??
    CONT_IMPORT_RE.exec(line) ??
    REQUIRE_RE.exec(line) ??
    PHP_REQUIRE_RE.exec(line) ??
    PY_FROM_IMPORT_RE.exec(line) ??
    PY_IMPORT_RE.exec(line);
  return m ? m[1]! : null;
}
function stripAB(p: string): string {
  return p.replace(/^[ab]\//, "");
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Undo git's C-style path quoting. Even with core.quotePath=false, git quotes a
 *  path holding `"`, `\`, or a control character (`"src/a\"b.ts"`); with the
 *  default quotePath it also octal-escapes every byte above 0x7F. Octal escapes
 *  are raw bytes, so the unescaped byte string is decoded as UTF-8. An unquoted
 *  or malformed value is returned unchanged. */
export function unquoteGitPath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) return p;
    if (/[0-7]/.test(next)) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))![0];
      bytes.push(parseInt(oct, 8) & 0xff);
      i += oct.length;
      continue;
    }
    const code = C_ESCAPES[next];
    if (code === undefined) return p;
    bytes.push(code);
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** A `---`/`+++` header path: strip git's trailing tab (added after names with
 *  spaces), unquote, then drop the a/ b/ prefix. */
function headerPath(raw: string): string {
  const value = raw.replace(/\r$/, "").replace(/\t$/, "").trim();
  return value.startsWith('"') ? unquoteGitPath(value) : value;
}

/** The final line a budget-capped diff ends with (see SYNTHESIS_DIFF_BUDGET in git.ts). */
export const DIFF_TRUNCATED_LINE = "…(diff truncated)…";

/** Does this diff end with the truncation marker (i.e. is it a prefix of the change)? */
export function isTruncatedDiff(diff: string): boolean {
  return diff === DIFF_TRUNCATED_LINE || diff.endsWith(`\n${DIFF_TRUNCATED_LINE}`);
}

/** The (new-side) path of every file block in a unified diff, in order — including
 *  blocks with no hunks (binary, mode-only). Paths use the same keys as
 *  DiffAnalysis.addedLinesByFile. */
export function diffBlockFiles(diff: string): string[] {
  const out: string[] = [];
  let cur: { path: string; inHunk: boolean } | null = null;
  const flush = () => { if (cur?.path) out.push(cur.path); };
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      flush();
      cur = { path: gitHeaderNewPath(raw.slice("diff --git ".length)), inHunk: false };
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("@@")) { cur.inHunk = true; continue; }
    if (cur.inHunk) continue;
    if (raw.startsWith("rename to ") || raw.startsWith("copy to ")) {
      cur.path = headerPath(raw.slice(raw.indexOf(" to ") + 4));
    } else if (raw.startsWith("+++ ")) {
      const p = headerPath(raw.slice(4));
      if (p !== "/dev/null") cur.path = stripAB(p);
    } else if (raw.startsWith("--- ")) {
      const p = headerPath(raw.slice(4));
      if (p !== "/dev/null") cur.path = stripAB(p);
    }
  }
  flush();
  return out;
}

/** How complete a gate's diff is (git.ts GateDiff satisfies this shape). */
export interface DiffStatus {
  /** Why the diff as a whole cannot be trusted as complete. */
  incomplete?: string;
  /** The diff is a byte prefix of the change, so its last block may be cut. */
  truncated?: boolean;
  /** Files whose content could not be read into the diff. */
  unreadFiles?: string[];
}

export interface DiffContentGaps {
  /** True when this file's added lines may be missing from the diff. */
  missing(file: string): boolean;
  /** A human-readable reason for the given missing files. */
  reason(files: string[]): string;
}

/** Which files a content check cannot trust "no added lines" for. Null when the
 *  diff is complete, so callers keep the exact small-diff behavior. A truncated
 *  diff (ends with DIFF_TRUNCATED_LINE) covers only the blocks before its last,
 *  possibly cut, block; an `incomplete` status covers only the blocks present. */
export function diffContentGaps(diff: string, status?: DiffStatus): DiffContentGaps | null {
  const truncated = !!status?.truncated || isTruncatedDiff(diff);
  const unread = new Set(status?.unreadFiles ?? []);
  const wholeReason = status?.incomplete ?? (truncated ? "the diff was truncated before this file's changes" : undefined);
  if (!wholeReason && !unread.size) return null;
  let covered: Set<string> | null = null;
  if (wholeReason) {
    const blocks = diffBlockFiles(diff);
    if (truncated) blocks.pop();
    covered = new Set(blocks);
  }
  const outsideDiff = (f: string) => covered !== null && !covered.has(f);
  return {
    missing: (f) => unread.has(f) || outsideDiff(f),
    reason: (files) => {
      const parts: string[] = [];
      if (files.some(outsideDiff)) parts.push(wholeReason!);
      if (files.some((f) => unread.has(f))) parts.push("file content could not be read");
      return parts.join("; ");
    },
  };
}

/** Best-effort new path from a `diff --git <a> <b>` line, used only when a block
 *  has no ---/+++ header (binary or mode-only). Unambiguous when both sides are
 *  the same path, which is the case for every non-rename block. */
function gitHeaderNewPath(rest: string): string {
  const line = rest.replace(/\r$/, "");
  if (line.startsWith('"')) {
    const close = /^"(?:[^"\\]|\\.)*"/.exec(line);
    if (!close) return "";
    const second = line.slice(close[0].length + 1);
    return stripAB(unquoteGitPath(second.startsWith('"') ? second : second.trim()));
  }
  if (line.endsWith('"')) {
    const open = line.lastIndexOf(' "');
    return open >= 0 ? stripAB(unquoteGitPath(line.slice(open + 1))) : "";
  }
  // "a/P b/P": both halves have equal length when old and new path agree.
  if ((line.length - 1) % 2 === 0) {
    const half = (line.length - 1) / 2;
    const a = line.slice(0, half), b = line.slice(half + 1);
    if (stripAB(a) === stripAB(b)) return stripAB(b);
  }
  const lastB = line.lastIndexOf(" b/");
  return lastB >= 0 ? line.slice(lastB + 3) : "";
}

interface FileDecls {
  added: Map<string, SymbolChange>;
  removed: Map<string, SymbolChange>;
}

export function analyzeDiff(diff: string): DiffAnalysis {
  const filesAdded = new Set<string>();
  const filesDeleted = new Set<string>();
  const filesModified = new Set<string>();
  const filesRenamed: RenamePair[] = [];
  const perFile = new Map<string, FileDecls>();
  const addedImports = new Set<string>();
  const removedImports = new Set<string>();
  const addedLinesBy = new Map<string, string[]>();
  let addedLines = 0;
  let removedLines = 0;

  let curFile = "";
  let inHunk = false;
  let curAdded = false;
  let curDeleted = false;
  let renameFrom = "";

  const declsFor = (f: string): FileDecls | null => {
    if (!isCode(f)) return null;
    let e = perFile.get(f);
    if (!e) {
      e = { added: new Map(), removed: new Map() };
      perFile.set(f, e);
    }
    return e;
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      curFile = "";
      inHunk = false;
      curAdded = curDeleted = false;
      renameFrom = "";
      continue;
    }
    if (raw.startsWith("@@")) {
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      // ---- pre-hunk header region (file metadata) ----
      if (raw.startsWith("new file mode")) {
        curAdded = true;
      } else if (raw.startsWith("deleted file mode")) {
        curDeleted = true;
      } else if (raw.startsWith("rename from ")) {
        renameFrom = headerPath(raw.slice("rename from ".length));
      } else if (raw.startsWith("copy from ")) {
        renameFrom = headerPath(raw.slice("copy from ".length));
      } else if (raw.startsWith("rename to ") || raw.startsWith("copy to ")) {
        const to = headerPath(raw.slice(raw.indexOf(" to ") + 4));
        curFile = to;
        if (isSubstantive(to)) filesRenamed.push({ from: renameFrom, to });
      } else if (raw.startsWith("--- ")) {
        const p = headerPath(raw.slice(4));
        if (p !== "/dev/null") curFile = stripAB(p); // old path (may be replaced by +++)
      } else if (raw.startsWith("+++ ")) {
        const p = headerPath(raw.slice(4));
        if (p !== "/dev/null") curFile = stripAB(p); // new path preferred
        if (isSubstantive(curFile)) {
          if (curAdded) filesAdded.add(curFile);
          else if (curDeleted) filesDeleted.add(curFile);
        }
      }
      continue;
    }

    // ---- inside a hunk: content lines ----
    if (raw.startsWith("+")) {
      const body = raw.slice(1);
      // Raw added lines are captured for EVERY file, before the substantive gate:
      // content-matched constraints and Veto tripwires are not code-only rules
      // (a blocking invariant legitimately scopes .github/workflows/**, *.sql,
      // Dockerfile). Skipping them here left `scopedAdded` empty, which
      // buildCheckReport reads as "cannot prove a violation ⇒ complies" — so the
      // pre-edit hook denied the edit while `hunch check --strict` passed the
      // very commit that landed it. The churn counters below now also include
      // prose (isSubstantive, issue #12); symbol/import extraction stays
      // code-only (isCode/languageFor) since declarations are a code concept.
      let lines = addedLinesBy.get(curFile);
      if (!lines) { lines = []; addedLinesBy.set(curFile, lines); }
      lines.push(body);
      if (!isSubstantive(curFile)) continue;
      addedLines++;
      if (!curAdded && !curDeleted) filesModified.add(curFile);
      if (isCode(curFile)) {
        const d = declOf(body);
        if (d) declsFor(curFile)?.added.set(d.name, d);
        const imp = importOf(body);
        if (imp && !imp.startsWith(".")) addedImports.add(imp);
      }
    } else if (raw.startsWith("-")) {
      if (!isSubstantive(curFile)) continue;
      removedLines++;
      if (!curAdded && !curDeleted) filesModified.add(curFile);
      if (isCode(curFile)) {
        const body = raw.slice(1);
        const d = declOf(body);
        if (d) declsFor(curFile)?.removed.set(d.name, d);
        const imp = importOf(body);
        if (imp && !imp.startsWith(".")) removedImports.add(imp);
      }
    }
  }

  // per-file symbol classification (added/removed/changed within the same file)
  const addedSymbols: SymbolChange[] = [];
  const removedSymbols: SymbolChange[] = [];
  const changedSymbols: SymbolChange[] = [];
  for (const { added, removed } of perFile.values()) {
    for (const [name, sc] of added) {
      if (removed.has(name)) changedSymbols.push(sc);
      else addedSymbols.push(sc);
    }
    for (const [name, sc] of removed) {
      if (!added.has(name)) removedSymbols.push(sc);
    }
  }

  const renamedSet = new Set(filesRenamed.map((r) => r.to));
  return {
    filesAdded: [...filesAdded],
    filesDeleted: [...filesDeleted],
    filesModified: [...filesModified].filter((f) => !filesAdded.has(f) && !filesDeleted.has(f) && !renamedSet.has(f)),
    filesRenamed,
    addedSymbols,
    removedSymbols,
    changedSymbols,
    addedDeps: [...addedImports].filter((d) => !removedImports.has(d)),
    removedDeps: [...removedImports].filter((d) => !addedImports.has(d)),
    addedLines,
    removedLines,
    addedLinesByFile: addedLinesBy,
  };
}

/** A compact human-readable summary of a DiffAnalysis (used in decision text). */
export function summarizeDiff(a: DiffAnalysis): string {
  const parts: string[] = [];
  const names = (arr: SymbolChange[]) => arr.map((s) => s.name).slice(0, 8).join(", ");
  if (a.addedSymbols.length) parts.push(`added ${names(a.addedSymbols)}`);
  if (a.removedSymbols.length) parts.push(`removed ${names(a.removedSymbols)}`);
  if (a.changedSymbols.length) parts.push(`changed ${names(a.changedSymbols)}`);
  if (a.addedDeps.length) parts.push(`new dep(s): ${a.addedDeps.slice(0, 6).join(", ")}`);
  if (a.removedDeps.length) parts.push(`dropped dep(s): ${a.removedDeps.slice(0, 6).join(", ")}`);
  if (a.filesRenamed.length) parts.push(`renamed ${a.filesRenamed.map((r) => `${r.from}→${r.to}`).slice(0, 4).join(", ")}`);
  if (a.filesAdded.length) parts.push(`${a.filesAdded.length} new file(s)`);
  if (a.filesDeleted.length) parts.push(`${a.filesDeleted.length} deleted file(s)`);
  return parts.join("; ");
}
