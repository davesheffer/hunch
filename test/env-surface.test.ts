/**
 * Environment-variable surface gate. Every variable Hunch's source reads must be
 * registered in test/env-surface.json with a purpose and either the tests that
 * exercise it (each test's body must mention the variable) or an explicit todo.
 * New variables can never land as todo: the todo set is ratcheted against the
 * frozen baseline below, so adding an env read without a test fails CI.
 *
 * Discovery sees `process.env.X`, `process.env["X"]`, `env.X`, aliases of process.env
 * (`const e = process.env; e.X`), destructuring (`const { X, Y: y } = process.env`) and
 * helper reads (`numEnv("X")`). A read whose name is not a literal (`process.env[key]`,
 * `...rest`) is a dynamic env read and must be listed in DYNAMIC_ALLOW with a reason.
 *
 * Known limits (a source-text heuristic, not a trace; runtime env tracing is the planned fix):
 *  - a test counts when its body names the variable as a string literal anywhere, so a
 *    literal env name inside an unrelated data structure satisfies the gate;
 *  - aliases are found only when assigned directly from process.env in the same file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveSpawnCommand } from "../src/core/spawnCommand.js";

const ROOT = process.cwd();
const NAME = "([A-Z][A-Za-z0-9_]*)";
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Reads on process.env, an `env` name, or a declared alias of process.env; assignments and deletes are writes, not reads. */
function readsFor(aliases: string[]): RegExp[] {
  const on = ["process\\.env", "env", ...aliases.map(escRe)].join("|");
  return [
    new RegExp(`(?<![\\w.$])(?:${on})\\??\\.${NAME}\\b(?!\\s*=(?!=))`, "g"),
    new RegExp(`(?<![\\w.$])(?:${on})\\??\\.?\\[\\s*["'\`]${NAME}["'\`]\\s*\\](?!\\s*=(?!=))`, "g"),
    // Helpers such as numEnv("HUNCH_RRF_K", 60) that read the variable by name.
    new RegExp(`\\b\\w*Env\\(\\s*["'\`]([A-Z][A-Z0-9_]*)["'\`]`, "g"),
  ];
}
/** Names bound directly to process.env: `const e = process.env`, `env: NodeJS.ProcessEnv = process.env`. */
const ALIAS = /(?:(?:const|let|var)\s+([\w$]+)\s*(?::[^=;\n]+)?|([\w$]+)\s*:\s*NodeJS\.ProcessEnv\s*)=\s*process\.env\b(?!\s*(?:\?\.|[.[]))/g;
/** Pass-through allowlists: `for (const key of ["PATH", ...]) if (process.env[key]) ...`. */
const PASSTHROUGH = /for \(const (\w+) of \[([^\]]*)\]\)\s*\{?\s*if \(process\.env\[\1\]\)/g;

/** Dynamic env reads (non-literal key or a destructuring rest), `file: expression` -> why it is safe.
 *  Each needs a reason; a new dynamic read fails until it is listed here. */
const DYNAMIC_ALLOW: Record<string, string> = {
  "src/extractors/nativeTreeSitter.ts: process.env[key]": "saves the native-binding override keys it is about to set, to restore them afterwards; keys come from NATIVE_PACKAGES, not user input",
  "src/store/hunchStore.ts: process.env[name]": "numEnv(name) helper; every caller passes a literal name, which discovery reads through the \\w*Env(\"X\") pattern",
};

interface Entry { class: string; purpose: string; tests?: { file: string; title: string }[]; todo?: string }
const registry = JSON.parse(readFileSync(join(ROOT, "test/env-surface.json"), "utf8")) as Record<string, Entry>;

/** Frozen: shrink only. A variable may be `todo` only if it was untested when this gate landed. */
const TODO_BASELINE = new Set([
  "SystemRoot", "WINDIR",
  "npm_config_registry", "HUNCH_GRAPH_GAMMA", "HUNCH_GRAPH_MAX_DEPTH", "HUNCH_GRAPH_NODE_CAP", "HUNCH_GRAPH_TOKEN_CAP",
  "HUNCH_MEMORY_PRIOR_SHIFT", "HUNCH_RRF_K", "HUNCH_RRF_W_FTS", "HUNCH_RRF_W_GRAPH", "HUNCH_RRF_W_SEM",
  "HUNCH_STALE_DECISION_PRIOR_WEIGHT", "HUNCH_STATE_HISTORY_SCORE_FACTOR", "HUNCH_TEAM_CLONE_DEBUG",
  "HUNCH_TEAM_CLONE_TIMEOUT_MS",
]);

function walk(dir: string, suffix: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, suffix, out);
    else if (path.endsWith(suffix)) out.push(path);
  }
  return out;
}

export function discoverEnvReads(root = ROOT, dynamic: string[] = []): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const add = (name: string, file: string) => {
    if (!found.has(name)) found.set(name, new Set());
    found.get(name)!.add(relative(root, file).replace(/\\/g, "/"));
  };
  for (const file of walk(join(root, "src"), ".ts")) {
    const src = readFileSync(file, "utf8");
    const rel = relative(root, file).replace(/\\/g, "/");
    const aliases = [...new Set([...src.matchAll(ALIAS)].map((m) => (m[1] ?? m[2])!))];
    for (const re of readsFor(aliases)) {
      for (const m of src.matchAll(re)) {
        if (/delete\s*$/.test(src.slice(Math.max(0, m.index! - 8), m.index))) continue;
        add(m[1]!, file);
      }
    }
    const passthrough: [number, number][] = [];
    for (const m of src.matchAll(PASSTHROUGH)) {
      for (const key of m[2]!.matchAll(/["']([A-Za-z_][A-Za-z0-9_]*)["']/g)) add(key[1]!, file);
      const eol = src.indexOf("\n", m.index! + m[0].length);
      passthrough.push([m.index!, eol < 0 ? src.length : eol]);
    }
    const on = ["process\\.env", ...aliases.map(escRe)].join("|");
    // Destructuring: `const { X, Y: y = "d", ...rest } = process.env` (or an alias).
    for (const m of src.matchAll(new RegExp(`(?:const|let|var)\\s*\\{([^{}]*)\\}\\s*(?::[^=;\\n]+)?=\\s*(?:${on})\\b(?!\\s*(?:\\?\\.|[.[]))`, "g"))) {
      for (const part of m[1]!.split(",").map((p) => p.trim()).filter(Boolean)) {
        if (part.startsWith("...")) { dynamic.push(`${rel}: ...${part.slice(3).trim()}`); continue; }
        const key = part.split(/[:=]/)[0]!.trim().replace(/^["'`]|["'`]$/g, "");
        if (/^[A-Za-z_]\w*$/.test(key)) add(key, file);
      }
    }
    // Dynamic: a non-literal key on process.env or an alias, read (not assigned or deleted).
    for (const m of src.matchAll(new RegExp(`(?<![\\w.$])(?:${on})\\??\\.?\\[(?!\\s*["'\`][A-Za-z_]\\w*["'\`]\\s*\\])([^\\]]*)\\](?!\\s*=(?!=))`, "g"))) {
      if (/delete\s*$/.test(src.slice(Math.max(0, m.index! - 8), m.index))) continue;
      if (passthrough.some(([a, b]) => m.index! >= a && m.index! < b)) continue;
      dynamic.push(`${rel}: ${m[0].replace(/\s+/g, "")}`);
    }
  }
  return found;
}

/** End index (exclusive) of the bracket group opening at `open`, skipping strings and comments. */
function groupEnd(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { const n = src.indexOf("\n", i); i = n < 0 ? src.length : n; continue; }
    if (c === "/" && src[i + 1] === "*") { const n = src.indexOf("*/", i + 2); i = n < 0 ? src.length : n + 1; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { depth--; if (depth === 0) return i + 1; }
  }
  return src.length;
}

const TEST_FILE = /^test\/.+\.test\.(ts|mts)$/;

/** True when the test call starting at `m` is skipped or todo: `test.skip(`/`.todo(`, a
 *  `{ todo: ... }` option (other than literal false/undefined), or a `{ skip: ... }` option whose
 *  value is a literal `true` or string. Any other skip value (process.platform, a probed
 *  capability constant like SYMLINK_SKIP) is decided at runtime, so the test runs, and covers,
 *  where CI can. */
function isSkipped(src: string, modifier: string | undefined, afterTitle: number): boolean {
  if (/^\.(skip|todo)$/.test(modifier ?? "")) return true;
  const opts = /^\s*,\s*\{/.exec(src.slice(afterTitle));
  if (!opts) return false;
  const open = afterTitle + opts[0].length - 1;
  const obj = src.slice(open, groupEnd(src, open));
  return [...obj.matchAll(/(?<![\w$.])(skip|todo)\s*:\s*/g)].some((m) => {
    const value = optionValue(obj, m.index! + m[0].length);
    if (m[1] === "todo") return !/^(false|undefined|null)$/.test(value);
    return value === "true" || /^(["'`])[\s\S]*\1$/.test(value);
  });
}

/** The option value starting at `start`, up to a top-level `,`, `}` or newline. */
function optionValue(obj: string, start: number): string {
  let i = start;
  for (; i < obj.length; i++) {
    const c = obj[i]!;
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < obj.length && obj[i] !== c; i++) if (obj[i] === "\\") i++;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") { i = groupEnd(obj, i) - 1; continue; }
    if (c === "," || c === "}" || c === "\n") break;
  }
  return obj.slice(start, i).trim();
}

/** Bodies of the file's own functions (`function f(...) {...}`, `const f = (...) => ...`), by name. */
function helperBodies(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of src.matchAll(/(?:function\s+([\w$]+)\s*\(|(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?\()/g)) {
    const paramsEnd = groupEnd(src, d.index! + d[0].length - 1);
    let body = "";
    if (d[1]) {
      // Skip `{...}` groups that belong to a return type annotation (`): { out: string } {`).
      let open = src.indexOf("{", paramsEnd);
      while (open >= 0 && /^\s*[{|&[>]/.test(src.slice(groupEnd(src, open)))) open = src.indexOf("{", groupEnd(src, open));
      if (open >= 0) body = src.slice(open, groupEnd(src, open));
    } else {
      const arrow = /^\s*(?::[^\n]*?)?=>\s*/.exec(src.slice(paramsEnd));
      if (!arrow) continue;
      const start = paramsEnd + arrow[0].length;
      const open = src.slice(start).search(/[({]/);
      if (open >= 0) body = src.slice(start, groupEnd(src, start + open));
    }
    const name = (d[1] ?? d[2])!;
    out.set(name, `${out.get(name) ?? ""}\n${body}`);
  }
  return out;
}

/** Body of the test titled `title`: its own `test(...)` call, balanced parentheses, plus the bodies
 *  of same-file helpers it calls (transitively) — so `hook(root, ...)` counts for the env that
 *  hook() sets. A skipped or todo test is not coverage (see isSkipped). */
function testBody(file: string, title: string): string | null | { skipped: true } {
  const src = readFileSync(join(ROOT, file), "utf8");
  const m = [...src.matchAll(/^\s*(?:test|it)(\.\w+)?\(\s*(["'`])((?:\\.|(?!\2).)*)\2/gm)].find((x) => x[3] === title);
  if (!m) return null;
  if (isSkipped(src, m[1], m.index! + m[0].length)) return { skipped: true };
  const helpers = helperBodies(src);
  const parts = [src.slice(m.index!, groupEnd(src, src.indexOf("(", m.index!)))];
  const seen = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    for (const [name, body] of helpers) {
      if (seen.has(name) || !new RegExp(`(?<![\\w$.])${escRe(name)}\\s*\\(`).test(parts[i]!)) continue;
      seen.add(name);
      parts.push(body);
    }
  }
  return parts.join("\n");
}

/** Drop // and block comments (string-aware enough: skips quoted text) so a comment cannot satisfy the gate. */
function stripComments(src: string): string {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => (str ? m : " "));
}

/** The name must appear as a string literal, an object key, or an env assignment, outside comments.
 *  A delete (`delete process.env.X`, `delete env["X"]`) only clears the variable and does not count. */
function setsOrNamesVar(body: string, name: string): boolean {
  const n = escRe(name);
  const code = stripComments(body).replace(new RegExp(`\\bdelete\\s+[\\w$.]+\\??\\.?(?:\\[\\s*["'\`]${n}["'\`]\\s*\\]|\\.${n}\\b)`, "g"), " ");
  return [
    new RegExp(`["'\`]${n}["'\`]`),
    new RegExp(`(?<![\\w.])${n}\\s*:`),
    new RegExp(`\\benv\\??\\.${n}\\s*=(?!=)`),
  ].some((re) => re.test(code));
}

test("env surface: every environment variable src reads is registered, and nothing stale is", () => {
  const discovered = discoverEnvReads();
  const missing = [...discovered.keys()].filter((k) => !(k in registry)).sort();
  const stale = Object.keys(registry).filter((k) => !discovered.has(k)).sort();
  assert.deepEqual(missing, [], `unregistered env reads (add to test/env-surface.json with a test): ${missing.map((k) => `${k} in ${[...discovered.get(k)!].join(",")}`).join("; ")}`);
  assert.deepEqual(stale, [], "registered variables no longer read by src (remove them)");
});

test("env surface: every dynamic env read (non-literal key, destructuring rest) is allow-listed with a reason", () => {
  const dynamic: string[] = [];
  discoverEnvReads(ROOT, dynamic);
  const seen = [...new Set(dynamic)].sort();
  const unlisted = seen.filter((d) => !(d in DYNAMIC_ALLOW));
  assert.deepEqual(unlisted, [], `dynamic env read(s) the gate cannot name — read a literal name, or add to DYNAMIC_ALLOW with a reason: ${unlisted.join("; ")}`);
  assert.deepEqual(Object.keys(DYNAMIC_ALLOW).filter((k) => !seen.includes(k)).sort(), [], "DYNAMIC_ALLOW entries no longer in src (remove them)");
  for (const [k, why] of Object.entries(DYNAMIC_ALLOW)) assert.ok(why.trim().length >= 20, `${k}: reason required`);
});

test("env surface: each entry is documented and either tested or a baseline todo", () => {
  const unused: string[] = [];
  for (const [name, entry] of Object.entries(registry)) {
    assert.ok(entry.purpose?.trim().length >= 10, `${name}: purpose required`);
    assert.ok(entry.class?.trim(), `${name}: class required`);
    const tests = entry.tests ?? [];
    if (!tests.length) {
      assert.ok(entry.todo?.trim(), `${name}: needs tests or a todo reason`);
      assert.ok(TODO_BASELINE.has(name), `${name}: new env variables must ship with a test; todo is closed to new entries`);
      continue;
    }
    assert.equal(entry.todo, undefined, `${name}: tested entries must drop their todo`);
    for (const t of tests) {
      assert.match(t.file, TEST_FILE, `${name}: ${t.file} is not a test file (test/**/*.test.ts|mts)`);
      assert.ok(existsSync(join(ROOT, t.file)), `${name}: ${t.file} missing`);
      const body = testBody(t.file, t.title);
      assert.ok(body !== null, `${name}: test "${t.title}" not found in ${t.file}`);
      if (typeof body !== "string") { unused.push(`${name}: test "${t.title}" in ${t.file} is skipped or todo; it covers nothing`); continue; }
      if (!setsOrNamesVar(body, name)) unused.push(`${name}: test "${t.title}" in ${t.file} never uses the variable as a string literal, env key or assignment (comments do not count)`);
    }
  }
  assert.deepEqual(unused, []);
});

test("env surface: discovery sees aliases, helper reads and pass-through lists but not writes", () => {
  const discovered = discoverEnvReads();
  for (const name of ["HUNCH_SYNTH_PROVIDER", "HUNCH_MCP_TOOLS", "HUNCH_RRF_K", "TMPDIR", "CI"]) assert.ok(discovered.has(name), name);
  // experimentRunner/cochange only assign these for a child; an assignment is not a read.
  for (const name of ["CLAUDE_CODE_SAFE_MODE", "FORCE_COLOR", "GIT_TERMINAL_PROMPT"]) assert.ok(!discovered.has(name), name);
  for (const name of discovered.keys()) assert.match(name, /^[A-Z]|_proxy$|^npm_config_/, `${name}: not an env name`);
  // no truncated names from regex backtracking
  for (const name of discovered.keys()) assert.ok(!/^(HUNCH_CLI_CONFI|GIT_INDEX_FIL)$/.test(name), name);
});

// Behavioural tests for variables no other test sets as a real input. Each body
// uses the variable as an env key, so the registry can point here honestly.

test("env surface: Windows lookup honors ComSpec, PATH and the Path spelling", () => {
  const exists = (p: string) => p.toLowerCase() === "c:\\tools\\tool.cmd";
  const resolve = (env: Record<string, string>) => resolveSpawnCommand(["tool", "x"], { platform: "win32", execPath: "C:\\node\\node.exe", env, exists });
  const viaPATH = resolve({ PATH: "C:\\tools", PATHEXT: ".CMD", ComSpec: "C:\\custom\\cmd.exe" });
  assert.equal(viaPATH.how, "cmd-shim");
  assert.equal(viaPATH.file, "C:\\custom\\cmd.exe");
  assert.equal(resolve({ Path: "C:\\tools", PATHEXT: ".CMD" }).how, "cmd-shim");
  assert.equal(resolve({ Path: "C:\\elsewhere", PATHEXT: ".CMD" }).how, "direct");
  assert.equal(resolve({ PATH: "C:\\tools", PATHEXT: ".CMD" }).file, "cmd.exe");
});

function runInChild(script: string, overrides: Record<string, string>): string {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return run.stdout.trim().split("\n").at(-1)!;
}
const modUrl = (rel: string) => JSON.stringify(pathToFileURL(join(ROOT, rel)).href);

test("env surface: HUNCH_MAX_PRIOR_SHIFT and HUNCH_PRIOR_SHIFT_SCALE bound how far a dead hit's rank drops", () => {
  const rank = (dead: boolean, env: Record<string, string>): string => runInChild(`
    const { HunchStore } = await import(${modUrl("src/store/hunchStore.ts")});
    const s = Object.create(HunchStore.prototype);
    s.recs = () => []; s.staleDecisionIds = () => new Set();
    s.priorMeta = (ref) => (ref === "h0" ? { dead: ${dead}, provenance: [] } : null);
    const hits = Array.from({ length: 8 }, (_, i) => ({ ref: "h" + i, kind: "symbols", title: "", snippet: "", score: 1 }));
    console.log(JSON.stringify(s.rerankByPriors(hits, 10, undefined, ".").findIndex((h) => h.ref === "h0")));
  `, env);
  assert.equal(rank(true, {}), "5", "a dead hit drops the clamp (4) plus HUNCH_DEAD_PRIOR_SHIFT (2)");
  assert.equal(rank(true, { HUNCH_DEAD_PRIOR_SHIFT: "0" }), "3", "0 restores the flat clamp");
  assert.equal(rank(true, { HUNCH_MAX_PRIOR_SHIFT: "2" }), "3");
  assert.equal(rank(false, {}), "2", "a live unconfirmed hit is shifted by the scaled prior");
  assert.equal(rank(false, { HUNCH_PRIOR_SHIFT_SCALE: "1" }), "0", "a tiny scale never moves the hit a whole position");
});

test("env surface: HUNCH_SIG_MIN_LINES sets the churn threshold for model synthesis", () => {
  const script = `
    const { isSignificant } = await import(${modUrl("src/synthesis/synthesize.ts")});
    const a = (n) => ({ addedSymbols: [], removedSymbols: [], changedSymbols: [], addedDeps: [], removedDeps: [], addedLines: n, removedLines: 0 });
    console.log(JSON.stringify([5, 13, 60].map((n) => isSignificant({ body: "" }, a(n), ["src/a.ts"]))));
  `;
  assert.equal(runInChild(script, { HUNCH_SIG_MIN_LINES: "" }), "[false,true,true]");
  assert.equal(runInChild(script, { HUNCH_SIG_MIN_LINES: "3" }), "[true,true,true]");
  assert.equal(runInChild(script, { HUNCH_SIG_MIN_LINES: "50" }), "[false,false,true]");
});
