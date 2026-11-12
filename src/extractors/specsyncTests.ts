/**
 * Test-name extraction for spec-sync (design §4.1). A test references a clause only
 * through its name, so these extractors read test DECLARATIONS and nothing else:
 * comments, helper strings and code never count (SS-4.1). Dependency-free: a small
 * tokenizer for JS/TS, a string-aware line scanner for Python, and user regexes
 * (`testNamePatterns`) for everything else. A declaration whose name cannot be read is
 * counted (SS-4.5).
 */
import { compileGlob, type TestFileNames, type TestNamePattern } from "../core/specsync.js";

export interface ExtractedNames { names: { name: string; line: number }[]; unreadable: number; supported: boolean }

const JS_EXT = /\.(?:[cm]?[jt]sx?)$/i;
const PY_EXT = /\.py$/i;

/** Extract the test names of one file (SS-4.3, SS-4.4). A custom pattern whose glob
 *  matches the file replaces the built-in extractor for it. */
export function extractTestNames(file: string, text: string, patterns: readonly TestNamePattern[] = []): ExtractedNames {
  const custom = patterns.filter((p) => compileGlob(p.glob).test(file));
  if (custom.length) return extractWithPatterns(text, custom);
  if (JS_EXT.test(file)) return extractJs(text);
  if (PY_EXT.test(file)) return extractPython(text);
  return { names: [], unreadable: 0, supported: false };
}

export function testFileNames(file: string, text: string, patterns: readonly TestNamePattern[] = []): TestFileNames {
  const { names, unreadable } = extractTestNames(file, text, patterns);
  return { file, names, unreadable };
}

/** 1-based line of an offset, by binary search over precomputed line starts. */
function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// ---- custom patterns (SS-4.4) ------------------------------------------------

function extractWithPatterns(text: string, patterns: readonly TestNamePattern[]): ExtractedNames {
  const names: ExtractedNames["names"] = [];
  const lineAt = lineIndex(text);
  let unreadable = 0;
  for (const p of patterns) {
    const re = new RegExp(p.regex, "gm");
    for (const m of text.matchAll(re)) {
      const name = (m[1] ?? "").trim();
      if (name) names.push({ name, line: lineAt(m.index) });
      else unreadable++;
      if (m[0] === "") re.lastIndex++;
    }
  }
  return { names, unreadable, supported: true };
}

// ---- Python: pytest / unittest ---------------------------------------------

/** Scan one line for string/comment state: returns the open triple-quote delimiter left
 *  at the end of the line (or null). `from` skips text already consumed. */
function pyLineState(line: string, from: number, open: string | null): string | null {
  let i = from;
  while (i < line.length) {
    if (open) {
      const end = line.indexOf(open, i);
      if (end === -1) return open;
      // An escaped quote before the delimiter does not close it.
      let bs = 0;
      for (let k = end - 1; k >= 0 && line[k] === "\\"; k--) bs++;
      if (bs % 2 === 1) { i = end + 1; continue; }
      i = end + 3;
      open = null;
      continue;
    }
    const c = line[i]!;
    if (c === "#") return null;
    if (c === '"' || c === "'") {
      if (line.startsWith(c.repeat(3), i)) { open = c.repeat(3); i += 3; continue; }
      i++;
      while (i < line.length && line[i] !== c) i += line[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    i++;
  }
  return open;
}

function extractPython(text: string): ExtractedNames {
  const names: ExtractedNames["names"] = [];
  let unreadable = 0;
  let open: string | null = null;
  text.split(/\r?\n/).forEach((line, i) => {
    // Inside a triple-quoted string (docstring, assigned or passed as an argument), a
    // `def test_…` is text, not a test.
    const startedInString = open !== null;
    if (!startedInString) {
      const def = /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/.exec(line);
      if (def) names.push({ name: def[1]!, line: i + 1 });
      const mark = /^\s*@pytest\.mark\.spec\(\s*(.*)$/.exec(line);
      if (mark) {
        const lit = /^(?:[rRuU]?)("|')((?:\\.|(?!\1).)*)\1/.exec(mark[1]!);
        if (lit) names.push({ name: lit[2]!, line: i + 1 });
        else unreadable++;
      }
    }
    open = pyLineState(line, 0, open);
  });
  return { names, unreadable, supported: true };
}

// ---- JS/TS: jest, vitest, mocha, jasmine -----------------------------------

type Tok =
  | { t: "id"; v: string; i: number }
  | { t: "str"; v: string; i: number }
  | { t: "tpl"; v: string; i: number }
  | { t: "num"; v: string; i: number }
  | { t: "p"; v: string; i: number };

/** Marks a `${…}` (or `.each` placeholder) inside a title; a clause id cut by one is unreadable. */
const HOLE = "\u0000";

// After these, `/` starts a regex literal; after a number, identifier, `)` or `]` it divides.
const REGEX_AFTER = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void", "yield", "await", "delete", "new", "throw"]);

/** Tokens of JS/TS source with comments dropped. A template literal yields its literal
 *  parts with every `${…}` replaced by HOLE. Regex literals are skipped by a
 *  previous-token heuristic; `</` (a JSX closing tag) is never a regex. */
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  const prev = () => out[out.length - 1];
  while (i < n) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e === -1 ? n : e + 2; continue; }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === "'" || c === '"') {
      const start = i;
      let v = "";
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") { v += src[i + 1] ?? ""; i += 2; continue; }
        v += src[i++];
      }
      i++;
      out.push({ t: "str", v, i: start });
      continue;
    }
    if (c === "`") {
      const start = i;
      const [v, end] = readTemplate(src, i);
      i = end;
      out.push({ t: "tpl", v, i: start });
      continue;
    }
    if (c === "/") {
      const p = prev();
      const jsxClose = p && p.t === "p" && p.v === "<";
      const regexStart = !jsxClose && (!p || (p.t === "p" && REGEX_AFTER.has(p.v)) || (p.t === "id" && REGEX_AFTER_WORD.has(p.v)));
      if (regexStart) {
        i++;
        let cls = false;
        while (i < n && src[i] !== "\n") {
          const ch = src[i]!;
          if (ch === "\\") { i += 2; continue; }
          if (ch === "[") cls = true;
          else if (ch === "]") cls = false;
          else if (ch === "/" && !cls) break;
          i++;
        }
        i++;
        while (i < n && /[a-z]/i.test(src[i]!)) i++;
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < n && /[\w$]/.test(src[i]!)) i++;
      out.push({ t: "id", v: src.slice(start, i), i: start });
      continue;
    }
    if (/\d/.test(c) || (c === "." && /\d/.test(src[i + 1] ?? ""))) {
      const start = i;
      while (i < n && /[\w.]/.test(src[i]!)) i++;
      out.push({ t: "num", v: src.slice(start, i), i: start });
      continue;
    }
    out.push({ t: "p", v: c, i });
    i++;
  }
  return out;
}

/** Read a template literal starting at the backtick; returns its literal text (each
 *  `${…}` replaced by HOLE, nested braces and strings respected) and the index after it. */
function readTemplate(src: string, start: number): [string, number] {
  let i = start + 1;
  let v = "";
  while (i < src.length && src[i] !== "`") {
    if (src[i] === "\\") { v += src[i + 1] ?? ""; i += 2; continue; }
    if (src[i] === "$" && src[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        const ch = src[i]!;
        if (ch === "`") { i = readTemplate(src, i)[1]; continue; }
        if (ch === "'" || ch === '"') {
          i++;
          while (i < src.length && src[i] !== ch) i += src[i] === "\\" ? 2 : 1;
        } else if (ch === "{") depth++;
        else if (ch === "}") depth--;
        i++;
      }
      v += HOLE;
      continue;
    }
    v += src[i++];
  }
  return [v, i + 1];
}

const TEST_FN = new Set(["it", "test", "describe", "context", "suite", "specify", "fit", "xit", "fdescribe", "xdescribe", "xtest"]);
const GROUP_FN = new Set(["describe", "context", "suite", "fdescribe", "xdescribe"]);

/** `.each` titles: printf placeholders and `$var` / `$var.path` interpolations are holes (SS-4.3). */
function eachHoles(title: string): string {
  return title.replace(/%[sdifjoOp#]/g, HOLE).replace(/\$[A-Za-z_][\w.]*|\$#/g, HOLE);
}

/** A clause-id-like run cut by a hole (`PAY-1.${n}`, `pay_1_%s`): the id cannot be read. */
const CUT_ID = new RegExp(`[A-Za-z][A-Za-z0-9]*[-_]\\d+(?:[._]\\d+)*[._]?${HOLE}`);

/** Matching close index for every open bracket token, computed once (linear). */
function bracketPairs(toks: Tok[]): Int32Array {
  const pair = new Int32Array(toks.length).fill(-1);
  const stack: number[] = [];
  const opens: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    if (t.t !== "p") continue;
    if (t.v === "(" || t.v === "[" || t.v === "{") stack.push(k);
    else if (opens[t.v]) {
      // Unbalanced input: drop opens until the matching kind (or give up on this close).
      let at = stack.length - 1;
      while (at >= 0 && toks[stack[at]!]!.v !== opens[t.v]) at--;
      if (at < 0) continue;
      pair[stack[at]!] = k;
      stack.length = at;
    }
  }
  return pair;
}

/** Skip TypeScript type arguments (`<[number]>`, `<Ctx>`) at `j`; returns the index after them. */
function skipTypeArgs(toks: Tok[], j: number): number {
  if (!(toks[j]?.t === "p" && toks[j]!.v === "<")) return j;
  let depth = 0;
  for (let k = j; k < toks.length && k < j + 64; k++) {
    const t = toks[k]!;
    if (t.t !== "p") continue;
    if (t.v === "<") depth++;
    else if (t.v === ">" && --depth === 0) return k + 1;
    else if (t.v === ";") return j;
  }
  return j;
}

function extractJs(src: string): ExtractedNames {
  const toks = tokenize(src);
  const pair = bracketPairs(toks);
  const lineAt = lineIndex(src);
  const names: ExtractedNames["names"] = [];
  let unreadable = 0;
  // Enclosing describe titles, each live until its call's closing paren.
  const groups: { title: string; end: number }[] = [];
  for (let k = 0; k < toks.length; k++) {
    while (groups.length && k > groups[groups.length - 1]!.end) groups.pop();
    const t = toks[k]!;
    if (t.t !== "id" || !TEST_FN.has(t.v)) continue;
    const before = toks[k - 1];
    if (before && before.t === "p" && before.v === ".") continue; // `regex.test(…)`, `obj.it(…)`
    if (before && before.t === "id" && (before.v === "function" || before.v === "const" || before.v === "let" || before.v === "var")) continue;
    // Member chain: `.only`, `.skip`, `.each`, `.concurrent`, `.todo`, …
    let j = k + 1;
    let each = false;
    let todo = false;
    while (toks[j]?.t === "p" && toks[j]!.v === "." && toks[j + 1]?.t === "id") {
      if (toks[j + 1]!.v === "each") each = true;
      if (toks[j + 1]!.v === "todo") todo = true;
      j += 2;
    }
    if (todo) continue; // a planned test is not a test that references a clause
    j = skipTypeArgs(toks, j);
    if (each) {
      // `.each(table)(title, fn)` or `.each\`table\`(title, fn)`.
      if (toks[j]?.t === "tpl") j++;
      else if (toks[j]?.t === "p" && toks[j]!.v === "(") {
        if (pair[j] === -1) continue;
        j = pair[j]! + 1;
      } else continue;
      j = skipTypeArgs(toks, j);
    }
    const open = toks[j];
    if (!open || open.t !== "p" || open.v !== "(") continue;
    const end = pair[j]!;
    const arg = toks[j + 1];
    const argEnd = toks[j + 2];
    // A title is a lone literal argument: `it("x", …)` / `it(\`x\`, …)`, not `it(a + "x")`.
    const literal = arg && (arg.t === "str" || arg.t === "tpl") && (!argEnd || (argEnd.t === "p" && (argEnd.v === "," || argEnd.v === ")")));
    if (!literal) {
      if (arg && !(arg.t === "p" && arg.v === ")")) unreadable++;
      continue;
    }
    const raw = each ? eachHoles(arg.v) : arg.v;
    if (CUT_ID.test(raw)) { unreadable++; continue; }
    const title = raw.split(HOLE).join(" ");
    if (GROUP_FN.has(t.v)) {
      groups.push({ title, end: end === -1 ? toks.length : end });
      continue;
    }
    const full = [...groups.map((g) => g.title), title].join(" > ");
    names.push({ name: full, line: lineAt(t.i) });
  }
  return { names, unreadable, supported: true };
}
