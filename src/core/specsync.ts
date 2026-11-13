/**
 * spec-sync: keep a spec, its tests and its code in step. A spec is any text file whose
 * testable rules carry bracketed clause markers (`[PAY-1.2]`); tests reference a clause
 * through their name; `.hunch/spec-sync.json` maps each spec to its code and tests.
 *
 * This module holds the pure parts: config load/validate/merge, glob matching, the clause
 * parser, reference matching and the findings engine. Git, file and JUnit IO live in
 * `src/cli/specsyncCommand.ts`, test-name extraction in `src/extractors/specsyncTests.ts`.
 * Every path here is repo-relative POSIX. Clause ids in comments refer to the design
 * (`SS-x.y`).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./io.js";

export const SPEC_SYNC_FILE = ".hunch/spec-sync.json";
export const SPEC_SYNC_VERSION = 1;
const SPEC_ID = /^[A-Z][A-Z0-9]*$/;

export interface SpecEntry { id: string; path: string; code: string[]; tests: string[] }
export interface TestNamePattern { glob: string; regex: string }
export interface SpecSyncConfig {
  version: number;
  enabled: boolean;
  specsDir: string[];
  specs: SpecEntry[];
  ignore: string[];
  junit: string[];
  testNamePatterns: TestNamePattern[];
}

/** A config error names the field at fault (SS-2.5, SS-7.3). It never falls back to defaults. */
export class SpecSyncConfigError extends Error {
  constructor(readonly field: string, readonly detail: string) {
    super(`${SPEC_SYNC_FILE}: ${field}: ${detail}`);
    this.name = "SpecSyncConfigError";
  }
}

// ---- globs (SS-2.3) --------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** A glob token: a literal char, `?` (one non-`/`), `*` (a run of non-`/`), `**` (any run)
 *  or `**​/` (zero or more whole directories). */
type GlobTok = { k: "lit"; c: string } | { k: "one" } | { k: "star" } | { k: "globstar" } | { k: "dirs" };

export interface CompiledGlob { test(path: string): boolean }

/** Brace expansions per glob before it is refused as a config error. */
const MAX_BRACE_EXPANSIONS = 256;

/** `./` prefix dropped, backslashes turned into `/` (SS-2.3: repo-relative POSIX). */
export function normalizeGlob(glob: string): string {
  return glob.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

/** Expand `{a,b}` groups (nested groups too) into plain globs. Throws on an unbalanced
 *  brace or more than MAX_BRACE_EXPANSIONS alternatives. */
function expandBraces(glob: string): string[] {
  const open = glob.indexOf("{");
  const close = glob.indexOf("}");
  if (open === -1) {
    if (close !== -1) throw new Error(`unbalanced "}" in glob "${glob}"`);
    return [glob];
  }
  if (close !== -1 && close < open) throw new Error(`unbalanced "}" in glob "${glob}"`);
  let depth = 0;
  let end = -1;
  const commas: number[] = [];
  for (let i = open; i < glob.length; i++) {
    const c = glob[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) { end = i; break; }
    else if (c === "," && depth === 1) commas.push(i);
  }
  if (end === -1) throw new Error(`unbalanced "{" in glob "${glob}"`);
  const bounds = [open, ...commas, end];
  const parts = bounds.slice(0, -1).map((b, i) => glob.slice(b + 1, bounds[i + 1]));
  const out: string[] = [];
  for (const part of parts) {
    for (const g of expandBraces(glob.slice(0, open) + part + glob.slice(end + 1))) {
      out.push(g);
      if (out.length > MAX_BRACE_EXPANSIONS) throw new Error(`glob "${glob}" expands to more than ${MAX_BRACE_EXPANSIONS} alternatives`);
    }
  }
  return out;
}

/** Tokens per code point, as the matcher walks the path (an astral char is one literal). */
function tokenizeGlob(glob: string): GlobTok[] {
  const toks: GlobTok[] = [];
  const cs = Array.from(glob);
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]!;
    if (c === "*") {
      if (cs[i + 1] === "*") {
        i++;
        if (cs[i + 1] === "/") { i++; toks.push({ k: "dirs" }); } else toks.push({ k: "globstar" });
      } else toks.push({ k: "star" });
    } else if (c === "?") toks.push({ k: "one" });
    else toks.push({ k: "lit", c });
  }
  return toks;
}

/** Linear-time match (an NFA state-set simulation, O(path × glob)): no regex
 *  backtracking, so `*a*a*a*…b` against a long name stays fast. A `**​/` token has two
 *  states: at a directory boundary (`states`, where it may match zero directories) and
 *  mid-segment (`mid`, which must reach a `/` first), so `**​/foo.ts` never matches `afoo.ts`. */
function nfaTest(toks: GlobTok[], path: string): boolean {
  const n = toks.length;
  let states: Uint8Array<ArrayBuffer> = new Uint8Array(n + 1);
  let mid: Uint8Array<ArrayBuffer> = new Uint8Array(n + 1);
  const close = (set: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
    for (let i = 0; i < n; i++) {
      const k = toks[i]!.k;
      if (set[i] && (k === "star" || k === "globstar" || k === "dirs")) set[i + 1] = 1;
    }
    return set;
  };
  states[0] = 1;
  close(states);
  for (const ch of path) {
    const next = new Uint8Array(n + 1);
    const nextMid = new Uint8Array(n + 1);
    let any = false;
    for (let i = 0; i < n; i++) {
      const t = toks[i]!;
      if (t.k === "dirs") {
        // Boundary or mid-segment alike: a `/` returns to the boundary, anything else is mid.
        if (states[i] || mid[i]) { if (ch === "/") next[i] = 1; else nextMid[i] = 1; }
        continue;
      }
      if (!states[i]) continue;
      if (t.k === "lit") { if (t.c === ch) next[i + 1] = 1; }
      else if (t.k === "one") { if (ch !== "/") next[i + 1] = 1; }
      else if (t.k === "star") { if (ch !== "/") next[i] = 1; }
      else next[i] = 1;
    }
    for (let i = 0; i <= n; i++) if (next[i] || nextMid[i]) { any = true; break; }
    if (!any) return false;
    states = close(next);
    mid = nextMid;
  }
  return states[n] === 1;
}

const globCache = new Map<string, CompiledGlob>();

/** Compile a glob over repo-relative POSIX paths: `**`, `*`, `?` and `{a,b}` (nestable;
 *  `*`/`?` inside a group are wildcards). Throws on an invalid glob. */
export function compileGlob(glob: string): CompiledGlob {
  const cached = globCache.get(glob);
  if (cached) return cached;
  const alts = expandBraces(normalizeGlob(glob)).map(tokenizeGlob);
  const out: CompiledGlob = { test: (path) => alts.some((t) => nfaTest(t, path)) };
  globCache.set(glob, out);
  return out;
}

export function matchesAny(file: string, globs: readonly string[]): boolean {
  return globs.some((g) => compileGlob(g).test(file));
}

/** A `specsDir` entry is a glob or a directory: `docs/specs` covers every file under it. */
export function underSpecsDir(file: string, dirs: readonly string[]): boolean {
  return dirs.some((d) => {
    const dir = d.replace(/\/+$/, "");
    return file.startsWith(`${normalizeGlob(dir)}/`) || compileGlob(d).test(file);
  });
}

// ---- config (SS-1.1, SS-2.1, SS-2.3, SS-2.5) ------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function globList(raw: Record<string, unknown>, key: string, field: string, required: boolean): string[] {
  const v = raw[key];
  if (v === undefined) {
    if (required) throw new SpecSyncConfigError(field, "missing (expected an array of globs)");
    return [];
  }
  if (!Array.isArray(v)) throw new SpecSyncConfigError(field, "must be an array of glob strings");
  return v.map((g, i) => checkedGlob(g, `${field}[${i}]`));
}

/** A normalised glob that compiles, or a config error naming the field (SS-2.3, SS-2.5). */
function checkedGlob(g: unknown, field: string): string {
  if (typeof g !== "string" || !g.trim()) throw new SpecSyncConfigError(field, "must be a non-empty glob string");
  // "." or "./" would normalise to a path no file has: refused, never silently matching nothing.
  if (/^[./]*$/.test(normalizeGlob(g))) throw new SpecSyncConfigError(field, `"${g}" names the repository root, not files (use "**" for every file)`);
  try {
    compileGlob(g);
  } catch (e) {
    throw new SpecSyncConfigError(field, (e as Error).message);
  }
  return normalizeGlob(g);
}

/** Validate parsed config JSON. Unknown keys are kept on disk but ignored here. */
export function validateSpecSyncConfig(raw: unknown): SpecSyncConfig {
  if (!isObject(raw)) throw new SpecSyncConfigError("(root)", "must be a JSON object");
  if (raw.version === undefined) throw new SpecSyncConfigError("version", "missing (expected 1)");
  if (raw.version !== SPEC_SYNC_VERSION) throw new SpecSyncConfigError("version", `unknown version ${JSON.stringify(raw.version)} (this Hunch reads version ${SPEC_SYNC_VERSION})`);
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new SpecSyncConfigError("enabled", "must be true or false");
  if (raw.specs === undefined) throw new SpecSyncConfigError("specs", "missing (expected an array)");
  if (!Array.isArray(raw.specs)) throw new SpecSyncConfigError("specs", "must be an array");
  const seen = new Map<string, number>();
  const specs: SpecEntry[] = raw.specs.map((s, i) => {
    const at = `specs[${i}]`;
    if (!isObject(s)) throw new SpecSyncConfigError(at, "must be an object");
    if (s.id === undefined) throw new SpecSyncConfigError(`${at}.id`, "missing");
    if (typeof s.id !== "string" || !SPEC_ID.test(s.id)) throw new SpecSyncConfigError(`${at}.id`, `must match ${SPEC_ID.source} (got ${JSON.stringify(s.id)})`);
    if (seen.has(s.id)) throw new SpecSyncConfigError(`${at}.id`, `duplicate id "${s.id}" (also specs[${seen.get(s.id)}].id)`);
    seen.set(s.id, i);
    if (s.path === undefined) throw new SpecSyncConfigError(`${at}.path`, "missing");
    if (typeof s.path !== "string" || !s.path.trim()) throw new SpecSyncConfigError(`${at}.path`, "must be a repo-relative path");
    return { id: s.id, path: normPath(s.path), code: globList(s, "code", `${at}.code`, true), tests: globList(s, "tests", `${at}.tests`, true) };
  });
  const patterns = raw.testNamePatterns;
  if (patterns !== undefined && !Array.isArray(patterns)) throw new SpecSyncConfigError("testNamePatterns", "must be an array");
  const testNamePatterns: TestNamePattern[] = (patterns ?? []).map((p, i) => {
    const at = `testNamePatterns[${i}]`;
    if (!isObject(p)) throw new SpecSyncConfigError(at, "must be an object with glob and regex");
    const glob = checkedGlob(p.glob, `${at}.glob`);
    if (typeof p.regex !== "string" || !p.regex) throw new SpecSyncConfigError(`${at}.regex`, "missing or not a string");
    try {
      // Group count: an empty alternative always matches, so exec returns every group slot.
      if (new RegExp(`${p.regex}|`, "m").exec("")!.length < 2) throw new Error("needs a capture group for the test name");
    } catch (e) {
      throw new SpecSyncConfigError(`${at}.regex`, (e as Error).message);
    }
    return { glob, regex: p.regex };

  });
  return {
    version: SPEC_SYNC_VERSION,
    enabled: raw.enabled !== false,
    specsDir: globList(raw, "specsDir", "specsDir", false),
    specs,
    ignore: globList(raw, "ignore", "ignore", false),
    junit: globList(raw, "junit", "junit", false),
    testNamePatterns,
  };
}

export function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

export function specSyncConfigPath(root: string): string {
  return join(root, SPEC_SYNC_FILE);
}

/** Parse config text; a parse error is a config error naming the file. */
export function parseSpecSyncText(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    throw new SpecSyncConfigError("(parse)", (e as Error).message);
  }
}

/** The validated config, or null when the file is absent (spec-sync off, SS-1.1). A
 *  config with `enabled: false` is off before anything else is validated: it loads as an
 *  empty disabled config, so an entry being edited never fails a disabled repository. */
export function loadSpecSyncConfig(root: string): SpecSyncConfig | null {
  const file = specSyncConfigPath(root);
  if (!existsSync(file)) return null;
  const raw = parseSpecSyncText(readFileSync(file, "utf8"));
  if (isObject(raw) && raw.enabled === false) return { version: SPEC_SYNC_VERSION, enabled: false, specsDir: [], specs: [], ignore: [], junit: [], testNamePatterns: [] };
  return validateSpecSyncConfig(raw);
}

export function defaultSpecSyncConfig(): Record<string, unknown> {
  return { version: SPEC_SYNC_VERSION, enabled: true, specsDir: [], specs: [], ignore: [], junit: [] };
}

export interface ConfigEdit {
  /** Whether the file was written. A no-op leaves it byte-for-byte unchanged. */
  written: boolean;
  created: boolean;
  added: SpecEntry[];
  /** Ids already registered: reported, never replaced. */
  kept: string[];
}

/**
 * Merge an edit into the on-disk config (SS-1.3, SS-1.5): create it when absent, refuse
 * (throw, file untouched) when it does not parse, keep every existing key and entry,
 * add only specs whose id is not registered, and write atomically only when something
 * changed — running the same edit twice changes nothing.
 */
export function editSpecSyncConfig(root: string, edit: { enabled?: boolean; addSpecs?: SpecEntry[] }): ConfigEdit {
  const file = specSyncConfigPath(root);
  const created = !existsSync(file);
  const raw = created ? defaultSpecSyncConfig() : parseSpecSyncText(readFileSync(file, "utf8"));
  // An existing config must be valid as a whole (version, structure) before it is edited;
  // otherwise it is refused and left untouched (SS-1.3, SS-2.5). Turning it off only needs
  // a JSON object: a broken config can always be switched off (other fields are kept).
  const offOnly = edit.enabled === false && !edit.addSpecs?.length;
  if (!created && !offOnly) validateSpecSyncConfig(raw);
  if (!isObject(raw)) throw new SpecSyncConfigError("(root)", "must be a JSON object");
  let changed = created;

  if (edit.enabled !== undefined && raw.enabled !== edit.enabled) {
    // `enabled` absent means on (SS-1.1): only write it when it changes the meaning.
    if (!(edit.enabled && raw.enabled === undefined)) { raw.enabled = edit.enabled; changed = true; }
  }
  const added: SpecEntry[] = [];
  const kept: string[] = [];
  if (edit.addSpecs?.length) {
    if (raw.specs === undefined) raw.specs = [];
    if (!Array.isArray(raw.specs)) throw new SpecSyncConfigError("specs", "must be an array");
    const specs = raw.specs as unknown[];
    const ids = new Set(specs.map((s) => (isObject(s) ? s.id : undefined)));
    for (const s of edit.addSpecs) {
      if (ids.has(s.id)) { kept.push(s.id); continue; }
      ids.add(s.id);
      specs.push({ id: s.id, path: s.path, code: s.code, tests: s.tests });
      added.push(s);
      changed = true;
    }
  }
  if (changed) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(file, `${JSON.stringify(raw, null, 2)}\n`);
  }
  return { written: changed, created, added, kept };
}

// ---- legacy pilot header (SS-1.3) ------------------------------------------

/** Split a glob list on commas/whitespace outside `{a,b}` groups. */
function splitGlobs(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of value) {
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "," || /\s/.test(ch))) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** The legacy `<!-- spec-sync id=… code=… tests=… -->` header (or its `key: value`
 *  multi-line form), or null. `error` explains a header that cannot be imported. */
export function parseLegacyHeader(text: string): { id: string; code: string[]; tests: string[]; error?: string } | null {
  const m = /<!--\s*spec-sync\b([\s\S]*?)-->/.exec(withoutFences(text));
  if (!m) return null;
  const body = m[1]!;
  const keys = [...body.matchAll(/(?<![\w-])(id|code|tests)\s*[:=]\s*/gi)];
  const fields: Record<string, string> = {};
  keys.forEach((k, i) => {
    const end = i + 1 < keys.length ? keys[i + 1]!.index : body.length;
    fields[k[1]!.toLowerCase()] = body.slice(k.index + k[0].length, end).trim();
  });
  const id = (fields.id ?? "").split(/\s+/)[0] ?? "";
  const header = { id, code: splitGlobs(fields.code ?? ""), tests: splitGlobs(fields.tests ?? "") };
  if (!SPEC_ID.test(id)) return { ...header, error: `header id must match ${SPEC_ID.source} (got ${JSON.stringify(id)})` };
  return header;
}

// ---- clauses (SS-3.1 – SS-3.5) --------------------------------------------

export interface Clause { id: string; line: number; manual: boolean; text: string }
export interface ParsedSpec { clauses: Clause[]; duplicates: { id: string; lines: number[] }[] }

interface Marker { prefix: string; num: string; manual: boolean; lineStart: number; start: number; end: number; line: number }

/** A clause DEFINITION: the marker is the first thing on its line, after optional
 *  indentation, blockquote `>`s, and a list bullet (`-`, `*`, `+`, `1.`, `1)`, optionally
 *  a task box `[ ]`/`[x]`) or heading hashes, and optionally wrapped in bold (`**`/`__`).
 *  A bracketed id anywhere else (a table cell too) is a cross-reference: not a clause, not
 *  a duplicate, and it does not end the previous clause's text. */
const DEFINITION = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+)?(\*\*|__)?\[([A-Z][A-Z0-9]*)-(\d+(?:\.\d+)*)(\s+manual)?\](?:\1)?/;

/** What follows `[ID]` in a Markdown link reference definition (`[PAY-1.1]: #pay-11`):
 *  `:`, then one destination token and an optional quoted or parenthesised title, nothing
 *  else. `[PAY-1.1]: Refunds must …` is prose, so a definition. */
const LINK_DESTINATION = /^:[ \t]*(<[^<>\n]*>|[^\s<>]+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*$/;

/** Whether the text after `[ID]` makes a link reference definition: its token must look
 *  like a destination: starts with `#`; `<…>` that is empty or holds one of `/ . # :`;
 *  starts with `/`, `./`, `../`; a URI scheme followed by a non-space character; a path with
 *  `/` whose last segment has a file extension (or that ends with `/`); or a bare file name
 *  with a document extension (optionally `#anchor`). `[PAY-1.1]: N/A`, `: HTTP/2`, `: v2.0`,
 *  `: Node.js` and `: <removed>` are clauses. */
function isLinkReference(rest: string): boolean {
  const m = LINK_DESTINATION.exec(rest);
  if (!m) return false;
  const dest = m[1]!;
  if (dest.startsWith("#")) return true;
  if (dest.startsWith("<")) {
    const inner = dest.slice(1, -1);
    return inner === "" || /[/.#:]/.test(inner);
  }
  if (/^(?:\/|\.\.?\/)/.test(dest) || /^[a-z][a-z0-9+.-]*:\S/i.test(dest)) return true;
  if (dest.includes("/")) {
    const path = dest.replace(/#.*$/, "");
    return path.endsWith("/") || /\.[A-Za-z0-9]+$/.test(path.slice(path.lastIndexOf("/") + 1));
  }
  return /^[^#]+\.(?:md|markdown|html|htm|rst|txt|pdf|adoc|json|yaml|yml)(?:#.*)?$/i.test(dest);
}

/** Backtick runs of one line, each with the index of the next run of exactly its length
 *  (-1: none), from one backward pass, so code-span pairing stays linear. */
function backtickRuns(line: string): { start: number; len: number; next: number }[] {
  const runs: { start: number; len: number; next: number }[] = [];
  for (let i = line.indexOf("`"); i !== -1; i = line.indexOf("`", i)) {
    let j = i;
    while (line[j] === "`") j++;
    runs.push({ start: i, len: j - i, next: -1 });
    i = j;
  }
  const seen = new Map<number, number>();
  for (let k = runs.length - 1; k >= 0; k--) {
    runs[k]!.next = seen.get(runs[k]!.len) ?? -1;
    seen.set(runs[k]!.len, k);
  }
  return runs;
}

/** A line with its inline code spans blanked to same-length spaces: a backtick run opens a
 *  span closed by the next run of exactly its length (CommonMark); an unmatched run is
 *  literal. */
function blankCodeSpans(line: string): string {
  if (!line.includes("`")) return line;
  const runs = backtickRuns(line);
  let out = "";
  let last = 0;
  for (let k = 0; k < runs.length;) {
    const close = runs[k]!.next;
    if (close === -1) { k++; continue; }
    const end = runs[close]!.start + runs[close]!.len;
    out += line.slice(last, runs[k]!.start) + " ".repeat(end - runs[k]!.start);
    last = end;
    k = close + 1;
  }
  return out + line.slice(last);
}

/** Fences apply to Markdown only (an rst `~~~~` underline is not a fence). */
export function isMarkdownPath(path: string | undefined): boolean {
  return !path || /\.(?:md|markdown)$/i.test(path);
}

/** A fence opener: 3+ backticks or tildes, then an optional info string (a backtick
 *  fence's info string never holds a backtick, so ```` ```js x``` ```` inline is not one). */
function fenceOpen(line: string): { ch: string; len: number } | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m || (m[1]![0] === "`" && m[2]!.includes("`"))) return null;
  return { ch: m[1]![0]!, len: m[1]!.length };
}

/** A closing fence: same character, at least as long as the opener, nothing after it. */
function fenceCloses(line: string, open: { ch: string; len: number }): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return !!m && m[1]![0] === open.ch && m[1]!.length >= open.len;
}

/** Per line: whether it is inside (or is) a fenced block. All false for non-Markdown. */
function fencedLines(lines: readonly string[], markdown: boolean): boolean[] {
  const out = new Array<boolean>(lines.length).fill(false);
  if (!markdown) return out;
  let open: { ch: string; len: number } | null = null;
  lines.forEach((line, i) => {
    if (open) {
      out[i] = true;
      if (fenceCloses(line, open)) open = null;
      return;
    }
    open = fenceOpen(line);
    if (open) out[i] = true;
  });
  return out;
}

/** Text with fenced lines blanked (for the legacy header, SS-1.3). */
export function withoutFences(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const fenced = fencedLines(lines, true);
  return lines.map((l, i) => (fenced[i] ? "" : l)).join("\n");
}

/** Markdown HTML comments (`<!-- … -->`, multi-line too) outside fenced blocks and code
 *  spans, blanked to spaces with every newline kept, so offsets and line numbers stay
 *  true: a commented-out clause is not a clause. (The legacy header is parsed separately.)
 *  One linear pass tracks fences and comments together: a comment opened outside a fence
 *  runs to its `-->` whatever fence lines it holds; `<!--` inside a fence is literal. An
 *  opener with no closer anywhere after it blanks nothing from there on. */
function withoutComments(text: string, markdown: boolean): string {
  if (!markdown || !text.includes("<!--")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  let inComment = false;
  let lineStart = 0;
  for (let li = 0; li < lines.length; lineStart += lines[li]!.length + 1, li++) {
    const line = lines[li]!;
    let pos = 0;
    let kept = "";
    if (inComment) {
      const close = line.indexOf("-->");
      if (close === -1) { out.push(" ".repeat(line.length)); continue; }
      kept = " ".repeat(close + 3);
      pos = close + 3;
      inComment = false;
    } else if (fence) {
      if (fenceCloses(line, fence)) fence = null;
      out.push(line);
      continue;
    } else if ((fence = fenceOpen(line))) {
      out.push(line);
      continue;
    }
    // Left to right, the earlier of a code span and a comment wins (CommonMark).
    const runs = line.includes("`") ? backtickRuns(line) : [];
    let k = 0;
    let open = -2; // next `<!--` at or after pos; -2: not searched yet
    let last = pos;
    while (pos < line.length) {
      while (k < runs.length && runs[k]!.start < pos) k++;
      if (open !== -1 && open < pos) open = line.indexOf("<!--", pos);
      const run = runs[k];
      if (run && (open === -1 || run.start < open)) {
        const close = run.next;
        if (close === -1) { pos = run.start + run.len; k++; continue; }
        pos = runs[close]!.start + runs[close]!.len;
        k = close + 1;
        continue;
      }
      if (open === -1) break;
      const close = line.indexOf("-->", open + 2); // `<!-->` and `<!--->` are complete comments
      if (close !== -1) {
        kept += line.slice(last, open) + " ".repeat(close + 3 - open);
        pos = last = close + 3;
        continue;
      }
      // The comment runs past this line: it must close somewhere, else blank nothing more.
      if (text.indexOf("-->", lineStart + open + 2) === -1) {
        out.push(kept + line.slice(last));
        return [...out, ...lines.slice(li + 1)].join("\n");
      }
      kept += line.slice(last, open) + " ".repeat(line.length - open);
      last = line.length;
      inComment = true;
      break;
    }
    out.push(kept + line.slice(last));
  }
  return out.join("\n");
}

/** Clause definitions outside fenced blocks and inline code spans (SS-3.2), plus the
 *  offsets of headings (ATX, or a text line underlined with `===`/`---`, or any
 *  punctuation run in non-Markdown such as rst), which end a clause's text (SS-3.5). */
function scanMarkers(text: string, markdown: boolean): { markers: Marker[]; headings: number[] } {
  const markers: Marker[] = [];
  const headings: number[] = [];
  const lines = text.split("\n");
  const fenced = fencedLines(lines, markdown);
  const underline = markdown ? /^ {0,3}(?:=+|-+)\s*$/ : /^\s*([=\-~^*#+"'`:._])\1{2,}\s*$/;
  let offset = 0;
  let prevStart = -1;
  let prevText = false;
  let prevContinues = false; // the line above continued a text line (a wrapped paragraph)
  let prevUnder = -1; // start of the line above when it is an underline pattern, else -1
  let prevPrevUnder = -1; // same, for the line two above (a possible rst overline)
  const thematic = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  lines.forEach((line, i) => {
    const start = offset;
    offset += line.length + 1;
    if (fenced[i]) { prevText = prevContinues = false; prevUnder = prevPrevUnder = -1; return; }
    // A setext underline under a one-line paragraph makes that line the heading; under a
    // wrapped paragraph (the last line of a wrapped clause, say) the text ends at the
    // underline itself, so the paragraph's last line is never lost.
    const setext = prevText && underline.test(line);
    if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) headings.push(start);
    else if (markdown && !underline.test(line) && thematic.test(line)) headings.push(start); // a thematic break ends clause text
    else if (setext) {
      // rst overline + title + underline: the heading begins at its overline, not the title line.
      headings.push(prevContinues ? start : !markdown && prevPrevUnder !== -1 ? prevPrevUnder : prevStart);
    }
    const isUnder = underline.test(line);
    // An underline/overline, and in Markdown a thematic break (`***`, `___`), is no text.
    const text = !isUnder && line.trim() !== "" && !(markdown && thematic.test(line));
    prevPrevUnder = prevUnder;
    prevUnder = isUnder ? start : -1;
    prevContinues = prevText && text;
    prevStart = start;
    prevText = text;
    // Line start is tested on the RAW line (a blanked code span is not indentation); a
    // marker inside a code span is not a definition, nor in Markdown is a link
    // (`[PAY-1.1](#pay-11)`, `[PAY-1.1][]`) or a link reference definition (`[PAY-1.1]: #pay`).
    const m = DEFINITION.exec(line);
    if (m) {
      const after = m.index + m[0].lastIndexOf("]") + 1;
      if (markdown && (line[after] === "(" || line[after] === "[" || isLinkReference(line.slice(after)))) return;
      const at = m.index + m[0].lastIndexOf("[");
      // Inline code spans are blanked with same-length padding so offsets stay true.
      if (blankCodeSpans(line)[at] !== "[") return;
      markers.push({ prefix: m[2]!, num: m[3]!, manual: Boolean(m[4]), lineStart: start, start: start + at, end: start + m.index + m[0].length, line: i + 1 });
    }
  });
  return { markers, headings: headings.sort((a, b) => a - b) };
}

/** Clauses of the spec with id `specId`. Text runs from a definition to the line of the
 *  next definition, or a heading. `path` decides Markdown fence and comment handling. */
export function parseClauses(text: string, specId: string, path?: string): ParsedSpec {
  const markdown = isMarkdownPath(path);
  const src = withoutComments(text.replace(/\r\n?/g, "\n"), markdown);
  const { markers, headings } = scanMarkers(src, markdown);
  const own = markers.filter((m) => m.prefix === specId);
  const clauses: Clause[] = [];
  const seen = new Map<string, number[]>();
  let hi = 0;
  own.forEach((m, i) => {
    const id = `${specId}-${m.num}`;
    while (hi < headings.length && headings[hi]! <= m.start) hi++; // both ascending
    const lines = seen.get(id);
    if (lines) { lines.push(m.line); return; }
    seen.set(id, [m.line]);
    const nextMarker = i + 1 < own.length ? own[i + 1]!.lineStart : src.length;
    const nextHeading = headings[hi] ?? src.length;
    clauses.push({ id, line: m.line, manual: m.manual, text: src.slice(m.end, Math.min(nextMarker, nextHeading)) });
  });
  const duplicates = [...seen].filter(([, lines]) => lines.length > 1).map(([id, lines]) => ({ id, lines }));
  return { clauses, duplicates };
}

/** Clause-definition prefixes in a text, most frequent first (for `add`, SS-2.4). */
export function clausePrefixes(text: string, path?: string): { prefix: string; count: number }[] {
  const counts = new Map<string, number>();
  const markdown = isMarkdownPath(path);
  for (const m of scanMarkers(withoutComments(text.replace(/\r\n?/g, "\n"), markdown), markdown).markers) counts.set(m.prefix, (counts.get(m.prefix) ?? 0) + 1);
  return [...counts].map(([prefix, count]) => ({ prefix, count })).sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
}

/** Whitespace and line wrapping never count as a clause change (SS-3.5). */
export function normalizeClauseText(text: string): string {
  return text.replace(/\s+/g, "");
}

/** Whether some clause's text changed between two versions of a spec (SS-5.4). */
export function clauseTextChanged(before: string | null, after: string, specId: string, path?: string): boolean {
  const a = before === null ? [] : parseClauses(before, specId, path).clauses;
  const b = parseClauses(after, specId, path).clauses;
  const old = new Map(a.map((c) => [c.id, normalizeClauseText(c.text)]));
  if (old.size !== b.length) return true;
  return b.some((c) => old.get(c.id) !== normalizeClauseText(c.text));
}

// ---- references (SS-4.2) ---------------------------------------------------

/** Clause ids a test name references, among the given spec ids. Literal `PAY-1.2` and
 *  identifier `PAY_1_2` forms match case-insensitively; the id must end at a
 *  non-alphanumeric character or the end of the name, so `PAY_1_20` is not `PAY-1.2`. */
export function clauseRefs(name: string, specIds: readonly string[]): string[] {
  if (!specIds.length) return [];
  const alt = [...specIds].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
  const re = new RegExp(`(${alt})(?:-(\\d+(?:\\.\\d+)*)|_(\\d+(?:_\\d+)*))(?![A-Za-z0-9]|[._]\\d)`, "gi");
  const out = new Set<string>();
  for (const m of name.matchAll(re)) {
    const before = m.index > 0 ? name[m.index - 1]! : "";
    // Start boundary: start, a non-alphanumeric, or a camelCase hump (`TestPAY_1_2`).
    const camel = /[a-z]/.test(before) && /[A-Z]/.test(name[m.index]!);
    if (before && /[A-Za-z0-9]/.test(before) && !camel) continue;
    const id = specIds.find((s) => s.toLowerCase() === m[1]!.toLowerCase())!;
    const num = m[2] ?? m[3]!.replace(/_/g, ".");
    out.add(`${id}-${num}`);
  }
  return [...out];
}

// ---- findings (§5) ---------------------------------------------------------

export type FindingCode =
  | "untested" | "failing" | "orphan-ref" | "code-without-spec-change" | "new-code-no-spec"
  | "unregistered-spec" | "duplicate-clause" | "no-tests-recognised" | "junit-skipped";

const INFO: ReadonlySet<FindingCode> = new Set(["no-tests-recognised", "junit-skipped"]);

export interface Finding {
  code: FindingCode;
  blocking: boolean;
  /** The clause id or path the finding is about. */
  subject: string;
  spec?: string;
  message: string;
}

export function finding(code: FindingCode, subject: string, message: string, spec?: string, blocking = !INFO.has(code)): Finding {
  return { code, blocking, subject, ...(spec ? { spec } : {}), message };
}

export interface TestFileNames {
  file: string;
  names: { name: string; line: number }[];
  unreadable: number;
}

export interface JunitCase { name: string; classname: string; status: "passed" | "failed" | "skipped" }

export interface SpecInput {
  spec: SpecEntry;
  /** Current spec text. */
  text: string;
  /** Spec text at base, or null when the spec did not exist there. */
  baseText: string | null;
  /** Fresh JUnit testcases for this spec (SS-4.7), or null when no fresh report applies. */
  junit: JunitCase[] | null;
}

export interface CheckInput {
  config: SpecSyncConfig;
  specs: SpecInput[];
  /** Every test file matched by any spec's `tests` globs, with extracted names. */
  tests: TestFileNames[];
  /** Repo paths changed from base (incl. working tree) and the subset that was added. */
  changed: ReadonlySet<string>;
  added: ReadonlySet<string>;
  /** Files under `specsDir` that contain clause markers. */
  specsDirFiles: string[];
  /** JUnit findings produced while reading reports. */
  junitFindings: Finding[];
}

export interface SpecSummary { id: string; path: string; clauses: number; manual: number; tested: number }

/** "Code file" (SS-5.2): matches no spec's tests glob, no spec path and no ignore glob.
 *  Hunch's own `.hunch/` directory and configured JUnit reports are never code. */
export function isCodeFile(file: string, config: SpecSyncConfig): boolean {
  if (file.startsWith(".hunch/")) return false;
  if (matchesAny(file, config.junit)) return false;
  // Spec documents are never code: a new spec under specsDir is reported as
  // `unregistered-spec`, not also as `new-code-no-spec`.
  if (underSpecsDir(file, config.specsDir)) return false;
  if (config.specs.some((s) => s.path === file || matchesAny(file, s.tests))) return false;
  return !matchesAny(file, config.ignore);
}

export function computeFindings(input: CheckInput): { findings: Finding[]; summary: SpecSummary[] } {
  const { config } = input;
  const findings: Finding[] = [];
  const ids = config.specs.map((s) => s.id);
  const parsed = new Map(input.specs.map((s) => [s.spec.id, parseClauses(s.text, s.spec.id, s.spec.path)]));
  const known = new Set([...parsed.values()].flatMap((p) => p.clauses.map((c) => c.id)));

  // Static references from test names (SS-4.1, SS-4.2).
  const refs = new Map<string, number>();
  for (const t of input.tests) {
    for (const n of t.names) {
      for (const ref of clauseRefs(n.name, ids)) {
        if (known.has(ref)) refs.set(ref, (refs.get(ref) ?? 0) + 1);
        else findings.push(finding("orphan-ref", ref, `${t.file}:${n.line} test "${n.name}" references ${ref}, which no spec defines`, ref.slice(0, ref.indexOf("-"))));
      }
    }
    if (!t.names.length || t.unreadable) {
      const detail = t.names.length ? `${t.unreadable} test declaration(s) with an unreadable name` : `no readable test names${t.unreadable ? ` (${t.unreadable} unreadable declaration(s))` : ""}`;
      findings.push(finding("no-tests-recognised", t.file, `${t.file}: ${detail}`));
    }
  }

  const summary: SpecSummary[] = [];
  for (const s of input.specs) {
    const { spec } = s;
    const p = parsed.get(spec.id)!;
    for (const d of p.duplicates) findings.push(finding("duplicate-clause", d.id, `${d.id} defined more than once in ${spec.path} (lines ${d.lines.join(", ")})`, spec.id));
    let tested = 0;
    for (const c of p.clauses) {
      const cases = s.junit?.filter((jc) => clauseRefs(`${jc.classname} ${jc.name}`, ids).includes(c.id)) ?? [];
      if (cases.some((jc) => jc.status === "failed")) {
        findings.push(finding("failing", c.id, `${c.id} (${spec.path}:${c.line}): a referencing test failed in the JUnit report`, spec.id));
        continue;
      }
      if (c.manual) continue;
      const skippedOnly = cases.length > 0 && cases.every((jc) => jc.status === "skipped");
      if (!refs.has(c.id) || skippedOnly) {
        findings.push(finding("untested", c.id, `${c.id} (${spec.path}:${c.line}) has no ${skippedOnly ? "test that ran (only skipped testcases)" : "referencing test"}`, spec.id));
      } else tested++;
    }
    summary.push({ id: spec.id, path: spec.path, clauses: p.clauses.length, manual: p.clauses.filter((c) => c.manual).length, tested });

    const codeChanged = [...input.changed].filter((f) => matchesAny(f, spec.code) && isCodeFile(f, config)).sort();
    if (codeChanged.length && !clauseTextChanged(s.baseText, s.text, spec.id, spec.path)) {

      findings.push(finding("code-without-spec-change", spec.path, `code under ${spec.id} changed but no clause text in ${spec.path} did: ${codeChanged.join(", ")}`, spec.id));
    }
  }

  // Coverage only ratchets up: only ADDED code files (SS-5.1).
  for (const f of [...input.added].sort()) {
    if (isCodeFile(f, config) && !config.specs.some((s) => matchesAny(f, s.code))) {
      findings.push(finding("new-code-no-spec", f, `${f} was added and matches no spec's code globs (and no ignore glob)`));
    }
  }

  const registered = new Set(config.specs.map((s) => s.path));
  for (const f of input.specsDirFiles) {
    if (!registered.has(f)) findings.push(finding("unregistered-spec", f, `${f} contains clause markers but is not registered: run \`hunch spec-sync add ${f}\``));
  }

  findings.push(...input.junitFindings);
  return { findings, summary };
}
