import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";

/** CLI options gate: every option of every command in the live Commander tree must be
 *  listed in test/cli-options-surface.json, keyed "<command path> <flag>" (root options
 *  are keyed by the bare flag), either with a test that PASSES THAT FLAG to that command
 *  or with an explicit `todo` reason — and a todo only for keys in FROZEN_TODOS. An option added without an entry (or removed while
 *  one remains) fails here, so no flag can ship without black-box coverage or a recorded
 *  reason. The flag is the option's long name (`--no-share` for a negatable option), or
 *  its short name when it has no long one.
 *
 *  "Passes that flag" is a documented heuristic over test source text, not an execution
 *  trace (the same one test/cli-surface.test.ts uses for commands, plus the flag):
 *   1. the listed test file spawns the CLI (CLI_MARKER), and
 *   2. the test block — from its title to the next test()/it()/describe() title, with
 *      comment lines removed — passes the command words as CLI arguments (see
 *      cli-surface.test.ts), and
 *   3. the same block contains the flag as a CLI token: inside a string literal, opening
 *      it (`"--flag"`, `"--flag=x"`) or after a space in it (`"serve init --flag 1"`).
 *  The block is the test's own call (balanced parentheses from `test(` to its `)`); a
 *  skipped or todo test (`test.skip(`, `it.todo(`, `{ skip: ... }`, `{ todo: ... }`, or
 *  inside a skipped describe) is not coverage, unless the skip value is decided at runtime
 *  (anything but a literal `true` or string: process.platform, SYMLINK_SKIP). The command words
 *  must be the invocation's FIRST literal arguments (after the CLI entry, for a raw spawn), in
 *  order, and the flag must come after them.
 *  A spawn counts only when it references the CLI entry: hunchCliArgs, a src|dist/cli/index
 *  path, or a name whose whole definition is one (a path builder, hunchCliArgs(...), `[tsx, cli]`)
 *  — never a name whose definition merely contains the text "cli".
 *
 *  Known limits (a source-text heuristic; CI backs it with execution evidence: tooling/trace-gate.mjs
 *  fails an entry whose flag no traced test run actually parsed, #512):
 *   - a hunchCliArgs(...) list that is built but never spawned still counts;
 *   - a parent command's option is satisfied by a block that runs one of its subcommands
 *     with a same-named flag. Keep those entries honest by hand.
 *
 *  Re-seed (adds missing options, drops removed ones, keeps existing entries):
 *    HUNCH_CLI_OPTIONS_SEED=1 node tooling/run-tests.mjs test/cli-options-surface.test.ts */

interface TestRef { file: string; title: string }
type Entry = { tests: TestRef[] } | { todo: string };
interface DumpOption { long?: string; short?: string }
interface DumpCommand { name: string; options: DumpOption[]; subs: DumpCommand[] }
interface Pair { key: string; path: string; flag: string }

const ROOT = process.cwd();
const REGISTRY = join(ROOT, "test/cli-options-surface.json");
const CLI_MARKER = /hunchCliArgs|cli["'/, ]+index\.[tj]s/;
const TEST_TITLE = /\b(test|it|describe)(\.\w+)?\(\s*(["'`])((?:\\.|(?!\3)[^\\])*)\3/g;
const TEST_FILE = /^test\/.+\.test\.(ts|mts)$/;
const NO_TEST_TODO = "no test passes this flag to this command";

/** Ratchet: the only options allowed to stay `todo`. This list may only shrink — cover one,
 *  then delete its key here. A new option cannot be parked as a todo; it must ship with a test. */
const FROZEN_TODOS: readonly string[] = [
  "constitution bootstrap --private",
  "constitution delta --private",
  "constitution ingest --private",
  "integrations check --probe",
  "integrations check --require",
  "landscape adopt --acknowledge-issues",
  "policy compile --private",
  "policy shadow --max-unknown-error-rate",
  "policy shadow --min-applicable",
  "policy shadow --recent",
  "review-memory capture --private",
  "update --dry-run",
  "update --global",
];

const DUMP_SCRIPT = `
const [commanderUrl, cliUrl] = process.argv.slice(2);
const { Command } = await import(commanderUrl);
Command.prototype.parseAsync = async function () {
  const walk = (c) => ({ name: c.name(), options: c.options.map((o) => ({ long: o.long, short: o.short })), subs: c.commands.map(walk) });
  process.stdout.write(JSON.stringify(walk(this)));
  process.exit(0);
};
await import(cliUrl);
`;

/** Every (command path, flag) declared in the live tree. */
function discoverPairs(): Pair[] {
  const base = tempDir("hunch-cli-options-");
  try {
    const dumpFile = join(base, "dump-tree.mjs");
    writeFileSync(dumpFile, DUMP_SCRIPT);
    const env = isolatedCliEnv({ HOME: base, USERPROFILE: base, HUNCH_PRIVATE_DIR: "", NO_COLOR: "1", CI: "1" });
    const dump = spawnSync(process.execPath, [join(ROOT, "node_modules/tsx/dist/cli.mjs"), dumpFile,
      import.meta.resolve("commander"), pathToFileURL(join(ROOT, "src/cli/index.ts")).href],
    { cwd: base, env, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(dump.status, 0, `${dump.stdout}${dump.stderr}`);
    const pairs = new Map<string, Pair>();
    const walk = (c: DumpCommand, path: string[]) => {
      for (const o of c.options) {
        const flag = o.long ?? o.short;
        if (!flag) continue;
        const key = [...path, flag].join(" ");
        pairs.set(key, { key, path: path.join(" "), flag });
      }
      for (const s of c.subs) walk(s, [...path, s.name]);
    };
    walk(JSON.parse(dump.stdout) as DumpCommand, []);
    return [...pairs.values()].sort((a, b) => a.key.localeCompare(b.key));
  } finally {
    cleanupDir(base);
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A CLI invocation is a call whose argument list runs the CLI: hunchCliArgs(...), a process
 *  spawner whose arguments reference the CLI entry (`[tsx, cli, ...]`, `hunchCliArgs(...)`),
 *  or a wrapper the test file defines around one of those — hunch()/run()/runCli()/ok()...,
 *  resolved to a fixed point with the wrapper's own literal arguments prepended (so
 *  `runCheck(root, "--strict")` -> `runCli(root, "check", ...args)` counts as `check --strict`). */
type Helpers = Map<string, string[][]>;
const SPAWNERS = ["spawnSync", "spawn", "execFileSync", "execFile"];
/** A CLI entry path in source text: "src/cli/index.ts", join(ROOT, "dist", "cli", "index.js"). */
const ENTRY_PATH = /(?:src|dist)["'`/\\, ]{1,6}cli["'`/\\, ]{1,6}index\b/;
/** Stands in for the CLI entry in a token list; the command's arguments start after it. */
const ENTRY = "\u0000entry";

/** A tsx loader path in source text: "node_modules/tsx/dist/cli.mjs", join(ROOT, "node_modules", "tsx", ...). */
const LOADER_PATH = /node_modules["'`/\\, ]{1,6}tsx\b/;

/** Per file: the names bound to the CLI entry (fixed point over `const NAME = ...`), and
 *  the test a spawn's arguments must pass to count as running the CLI. */
interface FileCtx { entries: Set<string>; spawnsCli: RegExp }
const ctxCache = new Map<string, FileCtx>();
function ctxFor(text: string): FileCtx {
  if (ctxCache.has(text)) return ctxCache.get(text)!;
  const defs = [...text.matchAll(/(?:const|let)\s+([\w$]+)\s*(?::[^=\n]+)?=(?!=)\s*/g)]
    .map((m) => [m[1]!, exprAt(text, m.index! + m[0].length)] as const);
  // `const [tsx, cli] = hunchCliArgs()` binds the loader(s) and, last, the entry.
  const entries = new Set<string>();
  const loaders = new Set<string>();
  for (const m of text.matchAll(/(?:const|let)\s*\[([^\]]*)\]\s*=\s*hunchCliArgs\(\s*\)/g)) {
    const names = m[1]!.split(",").map((s) => s.trim()).filter((s) => /^[\w$]+$/.test(s));
    names.forEach((n, i) => (i === names.length - 1 ? entries : loaders).add(n));
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, expr] of defs) {
      if (entries.has(name) || loaders.has(name)) continue;
      const kind = entryKind(expr, entries, loaders);
      if (kind) { (kind === "entry" ? entries : loaders).add(name); changed = true; }
    }
  }
  const names = entries.size ? `|(?<![\\w$.])(?:${[...entries].map(esc).join("|")})(?![\\w$])` : "";
  const ctx = { entries, spawnsCli: new RegExp(`hunchCliArgs|${ENTRY_PATH.source}${names}`) };
  ctxCache.set(text, ctx);
  return ctx;
}

/** Whether a whole expression is the CLI entry or a tsx loader — never by substring: a name
 *  already bound to one, a path literal/builder (join/resolve/pathToFileURL/fileURLToPath) naming
 *  src|dist/cli/index or node_modules/tsx, a hunchCliArgs(...) call, or an array literal whose
 *  elements are all entries/loaders with at least one entry (`[tsx, cli]`). */
function entryKind(expr: string, entries: Set<string>, loaders: Set<string>): "entry" | "loader" | undefined {
  const e = expr.trim().replace(/^\.\.\./, "");
  if (/^[A-Za-z_$][\w$]*$/.test(e)) return entries.has(e) ? "entry" : loaders.has(e) ? "loader" : undefined;
  if (e.startsWith("[")) {
    if (groupEnd(e, 0) !== e.length) return undefined;
    const kinds = topLevelItems(e.slice(1, -1)).map((item) => entryKind(item, entries, loaders));
    return kinds.length && kinds.every(Boolean) && kinds.includes("entry") ? "entry" : undefined;
  }
  let whole = /^["'`]/.test(e) && stringEnd(e, 0) === e.length;
  const call = /^(hunchCliArgs|(?:path\.)?(?:join|resolve)|pathToFileURL|fileURLToPath)\s*\(/.exec(e);
  if (call) {
    const rest = e.slice(groupEnd(e, call[0].length - 1));
    if (call[1] === "hunchCliArgs") return rest === "" ? "entry" : undefined;
    whole = rest === "" || rest === ".href";
  }
  if (!whole) return undefined;
  return ENTRY_PATH.test(e) ? "entry" : LOADER_PATH.test(e) ? "loader" : undefined;
}

/** The expression starting at `start`, up to a top-level `;`, `,`, newline or closing bracket. */
function exprAt(src: string, start: number): string {
  let i = start;
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") { i = stringEnd(src, i) - 1; continue; }
    if (c === "(" || c === "[" || c === "{") { i = groupEnd(src, i) - 1; continue; }
    if (c === ";" || c === "," || c === "\n" || c === ")" || c === "]" || c === "}") break;
  }
  return src.slice(start, i);
}

/** The top-level comma-separated items of a bracket group's inner text. */
function topLevelItems(inner: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c === '"' || c === "'" || c === "`") { i = stringEnd(inner, i) - 1; continue; }
    if (c === "(" || c === "[" || c === "{") { i = groupEnd(inner, i) - 1; continue; }
    if (c === ",") { out.push(inner.slice(start, i)); start = i + 1; }
  }
  out.push(inner.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** End index (exclusive) of the bracket group opening at `open`, skipping strings and comments. */
function groupEnd(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") { i = stringEnd(src, i) - 1; continue; }
    if (c === "/" && src[i + 1] === "/") { const n = src.indexOf("\n", i); i = n < 0 ? src.length : n; continue; }
    if (c === "/" && src[i + 1] === "*") { const n = src.indexOf("*/", i + 2); i = n < 0 ? src.length : n + 1; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { depth--; if (depth === 0) return i + 1; }
  }
  return src.length;
}

function stringEnd(src: string, open: number): number {
  const q = src[open]!;
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === "\\") { i++; continue; }
    if (q === "`" && src[i] === "$" && src[i + 1] === "{") { i = groupEnd(src, i + 1) - 1; continue; }
    if (src[i] === q) return i + 1;
  }
  return src.length;
}

/** CLI tokens from the string literals in an argument list; object literals (spawn options,
 *  env maps) and comments are skipped, `${...}` interpolations become token breaks. An
 *  identifier bound to a literal array in scope (`const args = [...]`, `for (const flag of
 *  [...])`) expands to its literals — one alternative per loop element. */
function literalTokens(args: string, bindings: Bindings = new Map(), entries: Set<string> = new Set()): string[][] {
  let alts: string[][] = [[]];
  const push = (options: string[][]) => {
    alts = alts.flatMap((a) => options.map((o) => [...a, ...o])).slice(0, 256);
  };
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (c === "{") { i = groupEnd(args, i) - 1; continue; }
    if (c === "/" && args[i + 1] === "/") { const n = args.indexOf("\n", i); i = n < 0 ? args.length : n; continue; }
    if (c === "/" && args[i + 1] === "*") { const n = args.indexOf("*/", i + 2); i = n < 0 ? args.length : n + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const end = stringEnd(args, i);
      let body = args.slice(i + 1, end - 1);
      if (c === "`") body = body.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, " ");
      push([body.split(/\s+/).filter(Boolean).map((t) => (/(?:^|[/\\])(?:src|dist)[/\\]cli[/\\]index\.[tj]s$/.test(t) ? ENTRY : t))]);
      i = end - 1;
      continue;
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(args.slice(i));
    if (id && (args.slice(Math.max(0, i - 3), i) === "..." || !/[\w$.]/.test(args[i - 1] ?? ""))) {
      const bound = bindings.get(id[0]);
      const plain = !/^\s*[.([]/.test(args.slice(i + id[0].length));
      if (plain && entries.has(id[0])) push([[ENTRY]]);
      else if (bound && plain) push(bound);
      i += id[0].length - 1;
    }
  }
  return alts;
}

/** Literal arrays bound to a name in `src`: `const NAME = [...]` (one alternative) and
 *  `for (const NAME of [...])` (one alternative per element). */
type Bindings = Map<string, string[][]>;
function bindingsIn(src: string, raw = new Map<string, string>(), entries: Set<string> = new Set()): Bindings {
  const out: Bindings = new Map();
  const re = /(?:for\s*\(\s*(?:const|let)\s+([\w$]+)\s+of\s*|(?:const|let)\s+([\w$]+)\s*(?::\s*[\w$[\]<> ]+)?=\s*)\[/g;
  for (const m of src.matchAll(re)) {
    const open = m.index! + m[0].length - 1;
    const inner = src.slice(open + 1, groupEnd(src, open) - 1);
    raw.set((m[1] ?? m[2])!, inner);
    if (m[2]) { out.set(m[2], literalTokens(inner, new Map(), entries)); continue; }
    const elements: string[][] = [];
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i]!;
      if (c === "[") { const end = groupEnd(inner, i); elements.push(...literalTokens(inner.slice(i + 1, end - 1), new Map(), entries)); i = end - 1; }
      else if (c === '"' || c === "'" || c === "`") { const end = stringEnd(inner, i); elements.push(...literalTokens(inner.slice(i, end))); i = end - 1; }
    }
    out.set(m[1]!, elements);
  }
  return out;
}

/** Each CLI invocation in `src` as its token list (one list per helper prefix and binding
 *  alternative). A raw spawn's tokens start after the CLI entry (`[tsx, CLI, "check"]` -> check). */
function invocations(src: string, helpers: Helpers, ctx: FileCtx): string[][] {
  const names = [...helpers.keys(), ...SPAWNERS].map(esc).join("|");
  const call = new RegExp(`(?<![\\w$.])(${names})\\s*\\(`, "g");
  const raw = new Map<string, string>();
  const bindings = bindingsIn(src, raw, ctx.entries);
  const out: string[][] = [];
  for (const m of src.matchAll(call)) {
    const open = m.index! + m[0].length - 1;
    const args = src.slice(open + 1, groupEnd(src, open) - 1);
    // A spawner runs the CLI when its arguments, or a literal array they spread, name the entry.
    const named = [...raw].filter(([name]) => new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`).test(args)).map(([, text]) => text);
    const prefixes = helpers.get(m[1]!) ?? ([args, ...named].some((t) => ctx.spawnsCli.test(t)) ? [[]] : []);
    const alts = literalTokens(args, bindings, ctx.entries).map(afterEntry);
    for (const prefix of prefixes) for (const tokens of alts) out.push([...prefix, ...tokens]);
  }
  return out;
}

/** The command's tokens: everything after the first run of CLI-entry markers (`[tsx, CLI, "serve",
 *  "init", "--config", join(dir, ...)]` keeps every argument after the entry). */
function afterEntry(tokens: string[]): string[] {
  let i = tokens.indexOf(ENTRY);
  if (i < 0) return tokens;
  while (tokens[i] === ENTRY) i++;
  return tokens.slice(i).filter((t) => t !== ENTRY);
}

/** hunchCliArgs plus the file's own wrappers around a CLI invocation (fixed point), each
 *  with the literal argument prefixes it adds (one per definition of that name). */
const helperCache = new Map<string, Helpers>();
function helpersFor(text: string): Helpers {
  if (helperCache.has(text)) return helperCache.get(text)!;
  const helpers: Helpers = new Map([["hunchCliArgs", [[]]]]);
  const defs = [...text.matchAll(/(?:function\s+([\w$]+)\s*\(|(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?\()/g)];
  const done = new Set<number>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [i, d] of defs.entries()) {
      const name = (d[1] ?? d[2])!;
      if (done.has(i) || SPAWNERS.includes(name)) continue;
      const paramsEnd = groupEnd(text, d.index! + d[0].length - 1);
      let body: string;
      if (d[1]) {
        // Skip `{...}` groups that belong to a return type annotation (`): { out: string } {`).
        let open = text.indexOf("{", paramsEnd);
        while (open >= 0 && /^\s*[{|&[>]/.test(text.slice(groupEnd(text, open)))) open = text.indexOf("{", groupEnd(text, open));
        body = open < 0 ? "" : text.slice(open, groupEnd(text, open));
      } else {
        const arrow = /^\s*(?::[^\n]*?)?=>\s*/.exec(text.slice(paramsEnd));
        if (!arrow) continue;
        const start = paramsEnd + arrow[0].length;
        const open = text.slice(start).search(/[({]/);
        body = open < 0 ? "" : text.slice(start, groupEnd(text, start + open));
      }
      const inner = invocations(body, helpers, ctxFor(text))[0];
      if (!inner) continue;
      helpers.set(name, [...(helpers.get(name) ?? []), inner]);
      done.add(i);
      changed = true;
    }
  }
  helperCache.set(text, helpers);
  return helpers;
}

/** The command words are the invocation's first literal arguments (positions 0..n-1), in
 *  order, and the flag comes after them — all in ONE invocation. */
function invokes(tokens: string[], pair: Pair, at = 0): boolean {
  const words = pair.path ? pair.path.split(" ") : [];
  if (words.every((w, j) => tokens[at + j] === w) &&
    tokens.slice(at + words.length).some((t) => t === pair.flag || t.startsWith(`${pair.flag}=`))) return true;
  // Root options (and a literal value each) may precede the command: `--cli-config x auto-review ...`.
  const t = tokens[at];
  if (!words.length || t === undefined || !ROOT_FLAGS.has(t.split("=")[0]!)) return false;
  return invokes(tokens, pair, at + 1) || invokes(tokens, pair, at + 2);
}
/** Flags of the root command, filled from the live tree before any check runs. */
const ROOT_FLAGS = new Set<string>();

interface Block { title: string; body: string }

const stripComments = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/** True when a test()/it()/describe() call is skipped or todo: a `.skip`/`.todo` modifier, a
 *  `{ todo: ... }` option (other than literal false/undefined), or a `{ skip: ... }` option whose
 *  value is a literal `true` or string. Any other skip value (process.platform, a probed capability
 *  constant like SYMLINK_SKIP) is decided at runtime, so the test runs, and covers, where CI can. */
function isSkipped(text: string, modifier: string | undefined, afterTitle: number): boolean {
  if (/^\.(skip|todo)$/.test(modifier ?? "")) return true;
  const opts = /^\s*,\s*\{/.exec(text.slice(afterTitle));
  if (!opts) return false;
  const open = afterTitle + opts[0].length - 1;
  return skipOption(text.slice(open, groupEnd(text, open)));
}

/** Whether an options object literal statically skips or todos its test (see isSkipped). */
function skipOption(obj: string): boolean {
  return [...obj.matchAll(/(?<![\w$.])(skip|todo)\s*:\s*/g)].some((m) => {
    const value = exprAt(obj, m.index! + m[0].length).trim();
    if (m[1] === "todo") return !/^(false|undefined|null)$/.test(value);
    return value === "true" || /^(["'`])[\s\S]*\1$/.test(value);
  });
}

/** Each non-skipped test()/it() call, its body bounded to its own balanced `(...)`. Tests inside a
 *  skipped describe() are skipped too. */
function testBlocks(text: string): Block[] {
  const calls = [...text.matchAll(TEST_TITLE)].map((m) => ({
    m, start: m.index!, end: groupEnd(text, text.indexOf("(", m.index!)),
    skipped: isSkipped(text, m[2], m.index! + m[0].length),
  }));
  const skippedRanges = calls.filter((c) => c.skipped && c.m[1] === "describe");
  return calls.flatMap((c) => c.m[1] === "describe" || c.skipped || skippedRanges.some((d) => c.start > d.start && c.start < d.end)
    ? [] : [{ title: c.m[4]!, body: stripComments(text.slice(c.start, c.end)) }]);
}

function passes(text: string, body: string, pair: Pair): boolean {
  return invocations(body, helpersFor(text), ctxFor(text)).some((tokens) => invokes(tokens, pair));
}

const fileCache = new Map<string, string>();
function source(file: string): string {
  if (!fileCache.has(file)) fileCache.set(file, readFileSync(join(ROOT, file), "utf8"));
  return fileCache.get(file)!;
}

function testFiles(): string[] {
  return readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".test.ts")).sort().map((f) => `test/${f}`);
}

/** Up to two tests per pair whose block passes the flag to the command. */
function seedFor(pair: Pair, files: string[]): Entry {
  const tests: TestRef[] = [];
  for (const file of files) {
    const text = source(file);
    if (!CLI_MARKER.test(text)) continue;
    for (const b of testBlocks(text)) {
      if (b.title.includes("${") || b.title.length < 8 || !passes(text, b.body, pair)) continue;
      if (text.split(b.title).length !== 2) continue; // title must identify one block
      tests.push({ file, title: b.title });
      break;
    }
    if (tests.length >= 2) break;
  }
  return tests.length ? { tests } : { todo: NO_TEST_TODO };
}

test("CLI options: every option of every command has a test that passes it, or an explicit todo", { timeout: 300_000 }, async (t) => {
  const pairs = discoverPairs();
  for (const p of pairs) if (!p.path) ROOT_FLAGS.add(p.flag);
  assert.ok(pairs.length > 300, `discovered the whole option surface (${pairs.length})`);
  let registry: Record<string, Entry> = existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, "utf8")) : {};

  if (process.env.HUNCH_CLI_OPTIONS_SEED === "1") {
    const files = testFiles();
    const next: Record<string, Entry> = {};
    for (const p of pairs) {
      let kept = registry[p.key];
      if (kept && "tests" in kept) {
        // Keep only references that still pass; an entry left with none is re-seeded.
        const live = kept.tests.filter((ref) => existsSync(join(ROOT, ref.file)) &&
          testBlocks(source(ref.file)).some((b) => b.title.includes(ref.title) && passes(source(ref.file), b.body, p)));
        kept = live.length ? { tests: live } : undefined;
      }
      next[p.key] = kept && !("todo" in kept && kept.todo === NO_TEST_TODO) ? kept : seedFor(p, files);
    }
    writeFileSync(REGISTRY, `${JSON.stringify(next, null, 2)}\n`);
    registry = next;
  }

  const discovered = pairs.map((p) => p.key);
  const missing = discovered.filter((k) => !(k in registry));
  const stale = Object.keys(registry).filter((k) => !discovered.includes(k));
  assert.deepEqual({ missing, stale }, { missing: [], stale: [] },
    `test/cli-options-surface.json is out of step with the CLI.\n` +
    (missing.length ? `  New option(s) with no entry: ${missing.join(", ")} — add a test that passes each flag to its command and list it, or a { "todo": "<reason>" }.\n` : "") +
    (stale.length ? `  Entries for option(s) that no longer exist: ${stale.join(", ")} — remove them.\n` : ""));

  const todos: string[] = [];
  const problems: string[] = [];
  for (const p of pairs) {
    const entry = registry[p.key];
    if ("todo" in entry) {
      assert.ok(typeof entry.todo === "string" && entry.todo.trim(), `${p.key}: todo needs a reason`);
      todos.push(p.key);
      await t.test(`hunch ${p.key}`, { todo: entry.todo }, () => {});
      continue;
    }
    assert.ok(Array.isArray(entry.tests) && entry.tests.length > 0, `${p.key}: needs tests[] or todo`);
    for (const ref of entry.tests) {
      const where = `${p.key} -> ${ref.file} :: "${ref.title}"`;
      if (!TEST_FILE.test(ref.file)) { problems.push(`${where}: not a test file (test/**/*.test.ts|mts)`); continue; }
      if (!existsSync(join(ROOT, ref.file))) { problems.push(`${where}: file does not exist`); continue; }
      const text = source(ref.file);
      if (!text.includes(ref.title)) { problems.push(`${where}: no test with that title`); continue; }
      if (!CLI_MARKER.test(text)) { problems.push(`${where}: file never spawns the CLI`); continue; }
      if (!testBlocks(text).some((b) => b.title.includes(ref.title) && passes(text, b.body, p))) {
        problems.push(`${where}: test body does not pass ${p.flag} to \`${p.path || "hunch"}\``);
      }
    }
  }
  assert.deepEqual(problems, [], `cli-options-surface.json references tests that do not pass their flag:\n  ${problems.join("\n  ")}`);
  const unfrozen = todos.filter((k) => !FROZEN_TODOS.includes(k));
  assert.deepEqual(unfrozen, [], unfrozen.map((k) =>
    `new option \`hunch ${k}\` must have a test that passes it; a todo is not accepted for options outside FROZEN_TODOS`).join("\n"));
  console.log(`[cli-options] ${pairs.length} (command, option) pairs: ${pairs.length - todos.length} covered, ${todos.length} todo`);
});
