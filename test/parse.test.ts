import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { realpathSync, renameSync } from "node:fs";
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

test("native tree-sitter addons load only from per-process temp copies", () => {
  const require = createRequire(import.meta.url);
  const bindings = Object.keys(require.cache)
    .filter((path) => /tree-sitter(?:-typescript)?\.node$/.test(path))
    .sort();
  assert.equal(bindings.length, 2, `expected core and TypeScript native bindings, got: ${bindings.join(", ")}`);
  const processCopyPrefix = join(realpathSync(tmpdir()), `hunch-tree-sitter-${process.pid}-`);
  for (const binding of bindings) {
    assert.ok(realpathSync(binding).startsWith(processCopyPrefix), `installed native binding remains loaded: ${binding}`);
  }
});

test("native tree-sitter isolation fails closed when an installed addon was preloaded", () => {
  const packageUrl = pathToFileURL(join(process.cwd(), "package.json")).href;
  const parseUrl = pathToFileURL(join(process.cwd(), "src/extractors/parse.ts")).href;
  const script = `
    import { createRequire } from "node:module";
    const require = createRequire(${JSON.stringify(packageUrl)});
    require("tree-sitter");
    try {
      await import(${JSON.stringify(parseUrl)});
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

test("attributeCalls maps callee to enclosing symbol (keyed by stable byte offset)", () => {
  const p = parseSource("f.ts", SRC)!;
  const attr = attributeCalls(p); // Map<startByte, Set<callee>>
  const sb = (name: string) => p.symbols.find((s) => s.name === name)!.startByte;
  assert.ok(attr.get(sb("verifySession"))?.has("jwtDecode"));
  assert.ok(attr.get(sb("helper"))?.has("verifySession"));
  assert.ok(attr.get(sb("run"))?.has("helper"));
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
  const attr = attributeCalls(p); // Map<startByte, Map<callee, memberOnly>>
  const sb = p.symbols.find((s) => s.name === "f")!.startByte;
  const callees = attr.get(sb) ?? new Map<string, boolean>();
  assert.ok(!callees.has("map") && !callees.has("filter") && !callees.has("push"), "no builtin-method edges");
});

const PY_SRC = `
import os
from .jwt import decode_token
import external_pkg

def verify_session(token):
    id = decode_token(token)
    return id

class Service:
    def run(self):
        return verify_session("x")

async def async_helper():
    return verify_session("y")
`;

test("parseSource extracts Python symbols, imports, calls", () => {
  const p = parseSource("src/auth/session.py", PY_SRC)!;
  assert.ok(p, "python file did not parse");
  const names = p.symbols.map((s) => s.name).sort();
  assert.deepEqual(names, ["async_helper", "run", "verify_session", "Service"].sort());
  const kindOf = (n: string) => p.symbols.find((s) => s.name === n)!.kind;
  assert.equal(kindOf("verify_session"), "function");
  assert.equal(kindOf("async_helper"), "function");
  assert.equal(kindOf("Service"), "class");
  assert.equal(kindOf("run"), "method");
  assert.deepEqual(p.imports.sort(), [".jwt", "external_pkg", "os"].sort());
  assert.ok(p.calls.some((c) => c.callee === "decode_token"));
});

test("attributeCalls resolves Python calls to their enclosing symbol", () => {
  const p = parseSource("f.py", PY_SRC)!;
  const attr = attributeCalls(p);
  const sb = (name: string) => p.symbols.find((s) => s.name === name)!.startByte;
  assert.ok(attr.get(sb("verify_session"))?.has("decode_token"));
  assert.ok(attr.get(sb("run"))?.has("verify_session"));
  assert.ok(attr.get(sb("async_helper"))?.has("verify_session"));
});

test("Python builtin dict/list/str methods do NOT become call edges", () => {
  const src = `def f(xs):\n    return xs.get("k").strip().append(1)\n\ndef g():\n    pass\n`;
  const p = parseSource("m.py", src)!;
  const attr = attributeCalls(p);
  const sb = p.symbols.find((s) => s.name === "f")!.startByte;
  const callees = attr.get(sb) ?? new Map<string, boolean>();
  assert.ok(!callees.has("get") && !callees.has("strip") && !callees.has("append"), "no builtin-method edges");
});

test("parses a >=32KB Python file without throwing", () => {
  const big = "def f0():\n    return 0\n" + "x = 1\n".repeat(6000); // well over 32 KB
  assert.ok(big.length > 32768);
  const p = parseSource("big.py", big);
  assert.ok(p, "did not return null/throw on a large Python file");
  assert.ok(p!.symbols.some((s) => s.name === "f0"));
});

const PY_DECORATED_SRC = `
class Base:
    @classmethod
    def create(cls):
        return cls()

    @property
    def value(self):
        return self._value

    @staticmethod
    def util():
        return 1

    @some.dotted.decorator
    def custom(self):
        return 1

    @some_decorator(arg=1)
    def with_args(self):
        return 1

    def plain(self):
        return 1
`;

test("decorated Python methods (@classmethod/@property/@staticmethod/dotted/with-args) still classify as kind \"method\" (regression: Finding 1)", () => {
  const p = parseSource("src/models/base.py", PY_DECORATED_SRC)!;
  assert.ok(p, "python file did not parse");
  const kindOf = (n: string) => p.symbols.find((s) => s.name === n)?.kind;
  for (const name of ["create", "value", "util", "custom", "with_args", "plain"]) {
    assert.equal(kindOf(name), "method", `${name} should classify as "method", got "${kindOf(name)}"`);
  }
  // exactly one symbol per definition — no duplicate from the general fn.def pattern
  const names = p.symbols.map((s) => s.name);
  assert.equal(names.filter((n) => n === "create").length, 1, "no duplicate symbol for a decorated method");
});
