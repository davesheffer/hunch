import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseSource, attributeCalls } from "../src/extractors/parse.js";

const SRC = `
import { jwtDecode } from "./jwt.js";
import bare from "external";
export function verifySession(token: string): string | null {
  const id = jwtDecode(token);
  return id;
}
export const helper = (x: number) => verifySession(String(x));
class Service { run() { return helper(1); } }
interface Shape { a: number }
type Alias = string;
`;

test("parseSource extracts symbols, imports, calls", () => {
  const p = parseSource("src/auth/session.ts", SRC)!;
  assert.equal(p.parseable, true);
  const names = p.symbols.map((s) => s.name).sort();
  assert.deepEqual(names, ["Alias", "Service", "Shape", "helper", "run", "verifySession"].sort());
  assert.deepEqual(p.imports.sort(), ["./jwt.js", "external"].sort());
  assert.ok(p.calls.some((c) => c.callee === "jwtDecode"));
});

test("native tree-sitter addons load only from the per-user content-addressed copy cache", () => {
  // Load them here rather than relying on an earlier test having parsed: the
  // addons arrive on FIRST PARSE, so run alone this case would otherwise find
  // an empty require cache and fail for the wrong reason.
  assert.equal(parseSource("isolation-probe.ts", "export const probe: number = 1")?.parseable, true);
  const require = createRequire(import.meta.url);
  const bindings = Object.keys(require.cache)
    .filter((path) => /(?:^|[\\/])(?:tree-sitter|tree-sitter-typescript|tree-sitter-python)\.node$|tree-sitter-yaml\.node$/.test(path))
    .sort();
  assert.equal(bindings.length, 4, `expected core, TypeScript, Python and YAML bindings, got: ${bindings.join(", ")}`);
  const cachePrefix = join(realpathSync(tmpdir()), "hunch-tree-sitter-cache-");
  for (const binding of bindings) {
    assert.ok(realpathSync(binding).startsWith(cachePrefix), `installed native binding remains loaded: ${binding}`);
  }
});

test("native tree-sitter isolation fails closed when an installed addon was preloaded", () => {
  const packageUrl = pathToFileURL(join(process.cwd(), "package.json")).href;
  const parseUrl = pathToFileURL(join(process.cwd(), "src/extractors/parse.ts")).href;
  const script = `
    import { createRequire } from "node:module";
    const require = createRequire(${JSON.stringify(packageUrl)});
    require("tree-sitter");
    // The addons load on FIRST PARSE, not at import, so the isolation guard
    // fires there: importing the module must stay cheap for every CLI command.
    const { parseSource } = await import(${JSON.stringify(parseUrl)});
    try {
      parseSource("fixture.ts", "export const answer: number = 42");
      process.exitCode = 2;
    } catch (error) {
      console.log(error.message);
      if (!/loaded before Hunch/.test(error.message)) process.exitCode = 3;
    }
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /tree-sitter native addon was loaded before Hunch could isolate it/);
});

if (process.platform === "win32") {
  test("Windows installed tree-sitter binaries remain replaceable while parser process is active", async () => {
    const parseUrl = pathToFileURL(join(process.cwd(), "src/extractors/parse.ts")).href;
    const script = `
      const { parseSource } = await import(${JSON.stringify(parseUrl)});
      if (!parseSource("fixture.ts", "export const answer: number = 42")) process.exit(2);
      console.log("ready");
      process.stdin.resume();
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const childExit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`parser child did not become ready: ${stderr || stdout}`)), 15_000);
        const ready = (chunk: string) => {
          if (!chunk.includes("ready")) return;
          clearTimeout(timeout);
          child.stdout.off("data", ready);
          resolve();
        };
        child.stdout.on("data", ready);
        child.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`parser child exited before replacement check (${code}): ${stderr || stdout}`));
        });
      });

      const require = createRequire(import.meta.url);
      const nodeGypBuild = require("node-gyp-build") as { path(root: string): string };
      for (const packageName of ["tree-sitter", "tree-sitter-typescript"]) {
        const packageRoot = dirname(require.resolve(`${packageName}/package.json`));
        const installed = nodeGypBuild.path(packageRoot);
        const moved = `${installed}.hunch-replace-test`;
        let needsRestore = false;
        try {
          renameSync(installed, moved);
          needsRestore = true;
          renameSync(moved, installed);
          needsRestore = false;
        } finally {
          if (needsRestore) renameSync(moved, installed);
        }
      }
    } finally {
      child.stdin.end();
      if (child.exitCode === null) child.kill();
      await childExit;
    }
  });
}

test("parseSource reports syntax-error trees without inventing a clean parse", () => {
  const parsed = parseSource("broken.ts", "export function broken( {")!;
  assert.equal(parsed.parseable, false);
});

// ES2018 lets a TAGGED template carry an invalid escape (`String.raw`C:\Users\x``).
// tree-sitter-javascript never implemented that relaxation, so it emits an ERROR
// node — and because `conform` is fail-CLOSED on scan completeness, one such file
// used to reject the architectural-conformance scan for the WHOLE repo. Windows
// paths in tests are exactly where String.raw is idiomatic (fnd_62239a8621).
const BS = String.fromCharCode(92);
const TICK = String.fromCharCode(96);
const tagged = (body: string) => `const s = String.raw${TICK}${body}${TICK};`;

test("an invalid escape in a TAGGED template does not fail the scan (fnd_62239a8621)", () => {
  for (const body of [`C:${BS}Users${BS}x`, `${BS}u12`, `${BS}u{zz}`, `${BS}u{`]) {
    const parsed = parseSource("probe.ts", tagged(body))!;
    assert.equal(parsed.parseable, true, `String.raw with ${JSON.stringify(body)} must stay parseable`);
  }
});

test("the same escape in an UNTAGGED template is a real syntax error and still fails", () => {
  // Outside a tagged template ES gives no relaxation, so tree-sitter is RIGHT here.
  // The grammar hangs a tagged template_string off a call_expression and an untagged
  // one off its consumer; that pair is the whole discriminator, so pin both sides.
  const parsed = parseSource("probe.ts", `const s = ${TICK}C:${BS}x${TICK};`)!;
  assert.equal(parsed.parseable, false);
});

test("a genuine syntax error BESIDE a tolerated one still fails the scan", () => {
  const parsed = parseSource("probe.ts", `${tagged(BS + "x")} function f( { return 1 }`)!;
  assert.equal(parsed.parseable, false, "tolerating the template must not blanket-forgive the file");
});

test("symbols after a tolerated template are still extracted", () => {
  const parsed = parseSource("probe.ts", `${tagged("C:" + BS + "x")}\nexport function after() { return helper(); }`)!;
  const after = parsed.symbols.find((s) => s.name === "after");
  assert.ok(after, "the symbol following the template must survive");
  // The def node starts at `function`, NOT at the `export` keyword.
  assert.equal(after.bodyText, "function after() { return helper(); }");
});

test("Hunch can completely parse its VS Code graph adapter", () => {
  const source = readFileSync(new URL("../vscode-extension/src/hunchData.ts", import.meta.url), "utf8");
  assert.equal(source.includes("\0"), false, "raw NUL bytes are accepted by TypeScript but rejected by tree-sitter");
  const parsed = parseSource("vscode-extension/src/hunchData.ts", source);
  assert.ok(parsed, "the adapter must have a supported parser");
  assert.equal(parsed.parseable, true, "the adapter must remain usable by strict semantic scans");
});

test("escaped NUL regexes and encoded JSX entities keep strict scans complete", () => {
  const regexSource = String.raw`export const forbidden = /[\u0000\r\n]/;`;
  const jsxSource = String.raw`export const Label = () => <span>Environment &amp; event evidence</span>;`;
  assert.equal(parseSource("regex.ts", regexSource)?.parseable, true);
  assert.equal(parseSource("label.tsx", jsxSource)?.parseable, true);
});

test("bare ampersands in JSX text keep strict scans complete", () => {
  for (const source of [
    "export const Label = () => <span>Research & Development</span>;",
    "export const Pair = () => <span>{a} & {b}</span>;",
    "export const Localized = () => <span>Été & 日本語</span>;",
    "export const Leading = () => <span>&foo</span>;",
    "export const Repeated = () => <span>me & you & them</span>;",
  ]) {
    assert.equal(parseSource("label.tsx", source)?.parseable, true, source);
  }
});

test("ampersand recovery preserves original captured text", () => {
  const parsed = parseSource("label.tsx", `import value from "pkg&variant";
export const Label = () => <span>me & you & them</span>;`)!;
  assert.deepEqual(parsed.imports, ["pkg&variant"]);
  assert.match(parsed.symbols.find((symbol) => symbol.name === "Label")?.bodyText ?? "", /me & you & them/);
});

test("real JSX errors beside bare ampersands still fail strict scans", () => {
  for (const source of [
    "export const Label = () => <span>Research & Development</span>; function broken( {",
    "export const Label = () => <span>{a & }</span>;",
    "export const Label = () => <span>hello }</span>;",
    "export const Label = () => <span>hello & <broken</span>;",
    "export const Label = () => <span>me & you & them</span>; function broken( {",
  ]) {
    assert.equal(parseSource("label.tsx", source)?.parseable, false, source);
  }
});

test("attributeCalls maps a callee to its enclosing symbol, keyed by stable symbol index", () => {
  const p = parseSource("f.ts", SRC)!;
  const attr = attributeCalls(p);
  const calleesOf = (name: string) => attr.get(p.symbols.findIndex((s) => s.name === name));
  assert.ok(calleesOf("verifySession")?.has("jwtDecode"));
  assert.ok(calleesOf("helper")?.has("verifySession"));
  assert.ok(calleesOf("run")?.has("helper"));
});

test("non-code files return null", () => {
  assert.equal(parseSource("readme.md", "# hi"), null);
});

test("parses files >= 32 KB without throwing (regression: critical bufferSize bug)", () => {
  const big = "export function f0(){ return 0; }\n" + "const x=1;\n".repeat(5000); // ~55 KB
  assert.ok(big.length > 32768);
  const p = parseSource("big.ts", big);
  assert.ok(p, "did not return null/throw on a 55 KB file");
  assert.ok(p!.symbols.some((s) => s.name === "f0"), "still extracts symbols from a large file");
});

test("builtin method calls (.map/.push/...) do NOT become call edges (regression #4)", () => {
  const src = `function f(xs){ return xs.map(g).filter(h).push(1); }\nfunction g(){} function h(){}`;
  const p = parseSource("m.ts", src)!;
  const attr = attributeCalls(p);
  const index = p.symbols.findIndex((s) => s.name === "f");
  const callees = attr.get(index) ?? new Map<string, boolean>();
  assert.ok(!callees.has("map") && !callees.has("filter") && !callees.has("push"), "no builtin-method edges");
});

const PY_SRC = `import os
from .jwt import decode_token
import external_pkg

def verify_session(token):
    return decode_token(token)

class Service:
    def run(self):
        return verify_session("x")

async def async_helper():
    return verify_session("y")
`;

test("parseSource extracts Python symbols, imports, calls", () => {
  const p = parseSource("src/auth/session.py", PY_SRC)!;
  assert.ok(p, "python file did not parse");
  assert.equal(p.parseable, true);
  assert.deepEqual(p.symbols.map((s) => s.name).sort(), ["Service", "async_helper", "run", "verify_session"].sort());
  const kindOf = (n: string) => p.symbols.find((s) => s.name === n)!.kind;
  assert.equal(kindOf("verify_session"), "function");
  assert.equal(kindOf("async_helper"), "function");
  assert.equal(kindOf("Service"), "class");
  assert.equal(kindOf("run"), "method");
  assert.deepEqual([...p.imports].sort(), [".jwt", "external_pkg", "os"]);
  assert.ok(p.calls.some((c) => c.callee === "decode_token"));
});

test("attributeCalls resolves Python calls to their enclosing symbol", () => {
  const p = parseSource("f.py", PY_SRC)!;
  const attr = attributeCalls(p);
  const calleesOf = (name: string) => attr.get(p.symbols.findIndex((s) => s.name === name));
  assert.ok(calleesOf("verify_session")?.has("decode_token"));
  assert.ok(calleesOf("run")?.has("verify_session"));
  assert.ok(calleesOf("async_helper")?.has("verify_session"));
});

test("Python builtin dict/str/list member calls do NOT become call edges", () => {
  const src = "def f(d, xs):\n    d.get('a')\n    'x'.strip()\n    xs.append(1)\n";
  const p = parseSource("m.py", src)!;
  const attr = attributeCalls(p);
  const callees = attr.get(p.symbols.findIndex((s) => s.name === "f"));
  assert.ok(!callees || callees.size === 0, "no builtin-method edges");
});

test("Python sources larger than 32 KB parse", () => {
  const big = "def first_fn():\n    return 1\n" + "x = 1\n".repeat(8000);
  assert.ok(big.length > 32768);
  const p = parseSource("big.py", big);
  assert.ok(p, "did not return null on a >32 KB python file");
  assert.ok(p!.symbols.some((s) => s.name === "first_fn"));
});

test("decorated Python methods classify as methods exactly once", () => {
  const src = [
    "import functools",
    "class Model:",
    "    @classmethod",
    "    def create(cls):",
    "        return cls()",
    "    @property",
    "    def size(self):",
    "        return 1",
    "    @staticmethod",
    "    def util():",
    "        return 2",
    "    @functools.cache",
    "    def cached(self):",
    "        return 3",
    "    @retry(times=3)",
    "    def flaky(self):",
    "        return 4",
    "    def plain(self):",
    "        return 5",
    "",
  ].join("\n");
  const p = parseSource("model.py", src)!;
  for (const name of ["create", "size", "util", "cached", "flaky", "plain"]) {
    const matches = p.symbols.filter((s) => s.name === name);
    assert.equal(matches.length, 1, `${name} appears exactly once`);
    assert.equal(matches[0]!.kind, "method", `${name} is a method`);
  }
});

const GO_SRC = `package auth

import (
	"fmt"
	"example.com/mod/internal/jwt"
)

func VerifySession(token string) string {
	id := jwt.DecodeToken(token)
	fmt.Println(id)
	return id
}

type Service struct {
	name string
}

func (s *Service) Run() string {
	return VerifySession("x")
}

type Handler interface {
	Handle() error
}

type UserID = string
`;

test("parseSource extracts Go symbols, imports, calls", () => {
  const p = parseSource("src/auth/session.go", GO_SRC)!;
  assert.ok(p, "go file did not parse");
  assert.ok(p.parseable, "go file should be parseable");
  const names = p.symbols.map((s) => s.name).sort();
  assert.deepEqual(names, ["Handler", "Run", "Service", "UserID", "VerifySession"].sort());
  const kindOf = (n: string) => p.symbols.find((s) => s.name === n)!.kind;
  assert.equal(kindOf("VerifySession"), "function");
  assert.equal(kindOf("Run"), "method");
  assert.equal(kindOf("Service"), "class");
  assert.equal(kindOf("Handler"), "interface");
  assert.equal(kindOf("UserID"), "type");
  assert.deepEqual(p.imports.sort(), ["example.com/mod/internal/jwt", "fmt"].sort());
  assert.ok(p.calls.some((c) => c.callee === "DecodeToken" && c.member), "package-qualified call captured as member");
  assert.ok(p.calls.some((c) => c.callee === "VerifySession" && !c.member), "direct call captured");
});

test("attributeCalls resolves Go calls to their enclosing symbol", () => {
  const p = parseSource("f.go", GO_SRC)!;
  const attr = attributeCalls(p);
  const calleesOf = (name: string) => attr.get(p.symbols.findIndex((s) => s.name === name));
  assert.ok(calleesOf("VerifySession")?.has("DecodeToken"));
  assert.ok(calleesOf("Run")?.has("VerifySession"));
});

test("Go stdlib method/function names (Println/TrimSpace/...) do NOT become call edges", () => {
  const src = "package m\n\nfunc f(x Thing) string {\n\tx.Printf(\"y\")\n\tx.TrimSpace(\"z\")\n\treturn x.Custom()\n}\n";
  const p = parseSource("m.go", src)!;
  const attr = attributeCalls(p);
  const callees = attr.get(p.symbols.findIndex((s) => s.name === "f")) ?? new Map<string, boolean>();
  assert.ok(!callees.has("Printf") && !callees.has("TrimSpace"), "no builtin-method edges");
  assert.ok(callees.has("Custom"), "repo-specific member call survives");
});

test("a struct type_spec classifies as class, not the generic type kind (first-classification contract)", () => {
  const src = "package m\n\ntype OnlyStruct struct {\n\ta int\n}\n\ntype OnlyIface interface {\n\tA() int\n}\n\ntype Plain int\n";
  const p = parseSource("t.go", src)!;
  const kindOf = (n: string) => p.symbols.find((s) => s.name === n)?.kind;
  assert.equal(kindOf("OnlyStruct"), "class");
  assert.equal(kindOf("OnlyIface"), "interface");
  assert.equal(kindOf("Plain"), "type");
  assert.equal(p.symbols.filter((s) => s.name === "OnlyStruct").length, 1, "no duplicate from the generic type pattern");
});

const YAML_ANCHORS = `defaults: &defaults
  adapter: postgres
  host: localhost
development:
  <<: *defaults
  database: dev
test:
  <<: *defaults
  database: test
`;

test("YAML anchors become variable symbols beside a file-root symbol", () => {
  const p = parseSource("config/database.yml", YAML_ANCHORS)!;
  assert.equal(p.parseable, true);
  assert.deepEqual(p.symbols.map((s) => s.name).sort(), ["database.yml", "defaults"]);
  assert.equal(p.symbols.find((s) => s.name === "defaults")!.kind, "variable");
  assert.equal(p.symbols.find((s) => s.name === "database.yml")!.kind, "file");
});

test("a YAML alias is attributed to the file-root symbol", () => {
  const p = parseSource("config/database.yml", YAML_ANCHORS)!;
  const attr = attributeCalls(p);
  const rootIndex = p.symbols.findIndex((s) => s.kind === "file");
  assert.ok(attr.get(rootIndex)?.has("defaults"));
});

test("flow-style YAML anchors and their aliases are captured", () => {
  const p = parseSource("flow.yml", "x: &flowanchor {a: 1}\ny: *flowanchor\n")!;
  assert.ok(p.symbols.some((s) => s.name === "flowanchor" && s.kind === "variable"));
  assert.ok(p.calls.some((c) => c.callee === "flowanchor"));
});

test("an anchor-free workflow has exactly one file symbol and no calls", () => {
  const p = parseSource(".github/workflows/ci.yml", "name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n")!;
  assert.equal(p.parseable, true);
  assert.equal(p.symbols.filter((s) => s.kind === "file").length, 1);
  assert.equal(p.calls.length, 0);
});

test("a Helm-templated manifest is parseable and yields only the file symbol", () => {
  const src = `apiVersion: v1
kind: ConfigMap
metadata:
  name: app
data:
  {{- range $k, $v := .Values.config }}
  {{ $k }}: {{ $v | quote }}
  {{- end }}
`;
  const p = parseSource("charts/app/templates/configmap.yaml", src)!;
  assert.equal(p.parseable, true);
  assert.deepEqual(p.symbols.map((s) => [s.name, s.kind]), [["configmap.yaml", "file"]]);
  assert.equal(p.calls.length, 0);
});

test("Jinja-templated YAML is parseable, including a file with only {% %} tags", () => {
  const both = "{% for x in xs %}\nitem: {{ x }}\n{% endfor %}\n";
  assert.equal(parseSource("deploy.yml", both)?.parseable, true);
  const tagsOnly = "{% if prod %}\nkey: value\n  bad: [\n{% endif %}\n";
  assert.equal(parseSource("deploy.yml", tagsOnly)?.parseable, true);
});

test("genuinely broken, non-templated YAML is unparseable", () => {
  assert.equal(parseSource("broken.yml", "key: [1, 2\nother: \"unterminated\n")?.parseable, false);
});

test("a GitHub Actions ${{ }} expression is not a templating marker", () => {
  const broken = "name: ci\nenv:\n  A: ${{ secrets.A }}\n  list: [1, 2\nother: \"unterminated\n";
  assert.equal(parseSource(".github/workflows/ci.yml", broken)?.parseable, false);
  const valid = "name: ci\nenv:\n  A: ${{ secrets.A }}\n";
  const p = parseSource(".github/workflows/ci.yml", valid)!;
  assert.equal(p.parseable, true);
  assert.equal(p.symbols.length, 1);
});

test("a templated file with a real anchor keeps it, symbols ordered by start byte", () => {
  const src = "defaults: &defaults\n  a: 1\nitems:\n  {{- range .Values.x }}\n  - {{ . }}\n  {{- end }}\nref:\n  <<: *defaults\n";
  const p = parseSource("config.yaml", src)!;
  assert.equal(p.parseable, true);
  assert.deepEqual(p.symbols.map((s) => s.name).sort(), ["config.yaml", "defaults"]);
  for (let i = 1; i < p.symbols.length; i++) assert.ok(p.symbols[i - 1]!.startByte <= p.symbols[i]!.startByte);
});

test("a .tpl file is treated as templated by extension alone", () => {
  assert.equal(parseSource("templates/_helpers.tpl", "<% if foo %>\n  key: [unclosed\n<% end %>\n")?.parseable, true);
});

test("known trade-off: a plain YAML string containing {{ is treated as templated", () => {
  const src = "base: &base\n  a: 1\ntext: \"literal {{ braces\"\n";
  const p = parseSource("literal-braces.yml", src)!;
  assert.equal(p.parseable, true);
  assert.deepEqual(p.symbols.map((s) => s.name).sort(), ["base", "literal-braces.yml"]);
});

// ---- the per-user copy cache, exercised in fresh processes under a private TMPDIR ----
const PROBE = `
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { parseSource } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/extractors/parse.ts")).href)};
const parseable = parseSource("probe.ts", "export function probe(): number { return 1; }")?.parseable === true;
const bindings = Object.keys(createRequire(import.meta.url).cache).filter((p) => /tree-sitter\\.node$/.test(p)).map((p) => realpathSync(p));
console.log(JSON.stringify({ parseable, pid: process.pid, core: bindings[0] ?? null }));
`;
function probe(tmp: string): { parseable: boolean; pid: number; core: string | null } {
  const tsx = createRequire(import.meta.url).resolve("tsx");
  const run = spawnSync(process.execPath, ["--import", pathToFileURL(tsx).href, "--input-type=module", "-e", PROBE], {
    env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp }, encoding: "utf8", timeout: 60_000,
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").at(-1)!) as { parseable: boolean; pid: number; core: string | null };
}

test("a cached copy is reused by the next process, and a corrupt one is rewritten before loading", { skip: process.platform === "win32", timeout: 120_000 }, t => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "hunch-ts-cache-")));
  t.after(() => cleanupDir(tmp));
  const first = probe(tmp);
  assert.equal(first.parseable, true);
  assert.ok(first.core?.startsWith(join(tmp, "hunch-tree-sitter-cache-")), `loaded from the cache: ${first.core}`);
  const original = readFileSync(first.core!);
  const inode = statSync(first.core!).ino;
  const second = probe(tmp);
  assert.equal(second.core, first.core, "same content-addressed path");
  assert.equal(statSync(second.core!).ino, inode, "reused, not copied again");
  // A truncated copy must never be dlopen'd: it is rewritten from the source.
  writeFileSync(first.core!, original.subarray(0, 64));
  const third = probe(tmp);
  assert.equal(third.parseable, true);
  assert.equal(third.core, first.core);
  assert.ok(readFileSync(third.core!).equals(original), "the copy holds the installed bytes again");
});

test("a cache dir that is not private to the user falls back to a per-process copy", { skip: process.platform === "win32" || typeof process.getuid !== "function", timeout: 120_000 }, t => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "hunch-ts-refused-")));
  t.after(() => cleanupDir(tmp));
  const squatted = join(tmp, `hunch-tree-sitter-cache-${process.getuid!()}`);
  mkdirSync(squatted);
  chmodSync(squatted, 0o777); // world-writable: refused
  const run = probe(tmp);
  assert.equal(run.parseable, true, "parsing still works");
  assert.ok(run.core?.startsWith(join(tmp, `hunch-tree-sitter-${run.pid}-`)), `per-process copy: ${run.core}`);
  assert.deepEqual(readdirSync(squatted), [], "nothing was written into the refused dir");
});
