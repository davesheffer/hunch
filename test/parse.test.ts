import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { join } from "node:path";
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
