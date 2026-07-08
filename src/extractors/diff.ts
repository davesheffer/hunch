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
  kind: "function" | "class" | "interface" | "type" | "const";
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
  addedLines: number; // code lines only
  removedLines: number;
  /** Added line bodies (the "+" content, marker stripped) per code file. The text
   *  veto's symbol/pattern tiers match against — call sites, not just declarations,
   *  which addedSymbols can't see. Keyed by the same (new-path) key as perFile. */
  addedLinesByFile: Map<string, string[]>;
}

const DECL_PATTERNS: Array<{ kind: SymbolChange["kind"]; re: RegExp }> = [
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
import { languageFor } from "./languages.js";

const IMPORT_RE = /^\s*import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/;
const CONT_IMPORT_RE = /^\s*\}?\s*from\s+['"]([^'"]+)['"]/; // multi-line: "} from 'x'"
const REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/;
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
    PY_FROM_IMPORT_RE.exec(line) ??
    PY_IMPORT_RE.exec(line);
  return m ? m[1]! : null;
}
function stripAB(p: string): string {
  return p.replace(/^[ab]\//, "");
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
        renameFrom = raw.slice("rename from ".length).trim();
      } else if (raw.startsWith("copy from ")) {
        renameFrom = raw.slice("copy from ".length).trim();
      } else if (raw.startsWith("rename to ") || raw.startsWith("copy to ")) {
        const to = raw.slice(raw.indexOf(" to ") + 4).trim();
        curFile = to;
        if (isCode(to)) filesRenamed.push({ from: renameFrom, to });
      } else if (raw.startsWith("--- ")) {
        const p = raw.slice(4).trim();
        if (p !== "/dev/null") curFile = stripAB(p); // old path (may be replaced by +++)
      } else if (raw.startsWith("+++ ")) {
        const p = raw.slice(4).trim();
        if (p !== "/dev/null") curFile = stripAB(p); // new path preferred
        if (isCode(curFile)) {
          if (curAdded) filesAdded.add(curFile);
          else if (curDeleted) filesDeleted.add(curFile);
        }
      }
      continue;
    }

    // ---- inside a hunk: content lines ----
    if (raw.startsWith("+")) {
      if (!isCode(curFile)) continue;
      addedLines++;
      if (!curAdded && !curDeleted) filesModified.add(curFile);
      const body = raw.slice(1);
      let lines = addedLinesBy.get(curFile);
      if (!lines) { lines = []; addedLinesBy.set(curFile, lines); }
      lines.push(body);
      const d = declOf(body);
      if (d) declsFor(curFile)?.added.set(d.name, d);
      const imp = importOf(body);
      if (imp && !imp.startsWith(".")) addedImports.add(imp);
    } else if (raw.startsWith("-")) {
      if (!isCode(curFile)) continue;
      removedLines++;
      if (!curAdded && !curDeleted) filesModified.add(curFile);
      const body = raw.slice(1);
      const d = declOf(body);
      if (d) declsFor(curFile)?.removed.set(d.name, d);
      const imp = importOf(body);
      if (imp && !imp.startsWith(".")) removedImports.add(imp);
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
