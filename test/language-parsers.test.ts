/**
 * Language parser coverage gate.
 *
 * Every LanguageSpec in the registry must appear in EXPECTED_GRAMMARS below, and
 * every grammar must have a realistic multi-construct fixture that is indexed
 * through the real CLI (`hunch index`) on a temp git repo. A new language (or a
 * new extension on an existing one) fails this file until it is tested here.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { hunchPaths } from "../src/core/paths.js";
import type { Edge, Symbol as HunchSymbol } from "../src/core/types.js";
import { CODE_EXTENSIONS, LANGUAGES } from "../src/extractors/languages.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";

/** grammarKey -> [language id, extensions]. Adding a LanguageSpec (or an extension)
 *  without adding a fixture + entry here fails the registry gate. */
const EXPECTED_GRAMMARS: Record<string, { id: string; extensions: string[] }> = {
  ts: { id: "typescript", extensions: [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"] },
  tsx: { id: "typescript", extensions: [".tsx", ".jsx"] },
  python: { id: "python", extensions: [".py", ".pyi"] },
  go: { id: "go", extensions: [".go"] },
  php: { id: "php", extensions: [".php"] },
  yaml: { id: "yaml", extensions: [".yml", ".yaml", ".tpl"] },
};

/** grammarKeys with an end-to-end fixture in this file. */
const TESTED_GRAMMARS = new Set<string>();

test("registry gate: every LanguageSpec is listed and tested here", () => {
  const actual = Object.fromEntries(LANGUAGES.map((spec) => [spec.grammarKey, { id: spec.id, extensions: [...spec.extensions] }]));
  assert.deepEqual(actual, EXPECTED_GRAMMARS,
    "LanguageSpec registry changed: add a CLI fixture for the new grammar/extension to test/language-parsers.test.ts");
  assert.equal(LANGUAGES.length, Object.keys(EXPECTED_GRAMMARS).length, "duplicate grammarKey in the registry");
  assert.deepEqual([...CODE_EXTENSIONS].sort(), Object.values(EXPECTED_GRAMMARS).flatMap((g) => g.extensions).sort());
});

interface Indexed {
  root: string;
  status: number;
  output: string;
  symbols: HunchSymbol[];
  edges: Edge[];
  sym(name: string, file: string): HunchSymbol;
  has(name: string, file: string): boolean;
  calls(from: [string, string], to: [string, string]): boolean;
  dependents(name: string, file: string): Array<{ id: string; depth: number; via: string }>;
}

/** Write `files` into a fresh git repo, commit, run the real `hunch index` CLI and load the graph. */
function indexFixture(t: { after(fn: () => void): void }, prefix: string, files: Record<string, string>): Indexed {
  const root = tempDir(`hunch-lang-${prefix}-`);
  t.after(() => cleanupDir(root));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  git("add", "-A");
  git("-c", "core.hooksPath=", "commit", "-qm", "fixture");
  const run = spawnSync(process.execPath, hunchCliArgs("index", "--no-auto-commit"), {
    cwd: root, encoding: "utf8", env: isolatedCliEnv({ HUNCH_PRIVATE_DIR: "", NO_COLOR: "1" }), timeout: 120_000,
  });
  const store = new HunchStore(hunchPaths(root));
  try {
    const symbols = store.json.loadAll("symbols") as HunchSymbol[];
    const edges = store.json.loadAll("edges") as Edge[];
    const depsCache = new Map<string, Array<{ id: string; depth: number; via: string }>>();
    const find = (name: string, file: string) => symbols.find((s) => s.name === name && s.file === file);
    const sym = (name: string, file: string) => {
      const found = find(name, file);
      assert.ok(found, `missing symbol ${name} @ ${file}; have ${symbols.filter((s) => s.file === file).map((s) => `${s.kind}:${s.name}`).join(", ")}`);
      return found;
    };
    for (const s of symbols) depsCache.set(s.id, store.getDependents(s.id));
    return {
      root, status: run.status ?? -1, output: `${run.stdout}${run.stderr}`, symbols, edges, sym,
      has: (name, file) => Boolean(find(name, file)),
      calls: (from, to) => {
        const a = sym(...from), b = sym(...to);
        return edges.some((e) => e.from === a.id && e.to === b.id && e.type === "calls") || a.calls.includes(b.id);
      },
      dependents: (name, file) => depsCache.get(sym(name, file).id) ?? [],
    };
  } finally {
    store.close();
  }
}


const fileDependents = (g: Indexed, name: string, file: string) =>
  new Set(g.dependents(name, file).map((d) => g.symbols.find((s) => s.id === d.id)?.file).filter(Boolean));

function kinds(g: Indexed, file: string, expected: Record<string, string>): void {
  for (const [name, kind] of Object.entries(expected)) assert.equal(g.sym(name, file).kind, kind, `${name} @ ${file}`);
}
/** The malformed fixture is skipped (counted, not fatal) and contributes no code symbols. */
function malformedSkipped(g: Indexed, file: string): void {
  assert.match(g.output, /1 file\(s\) could not be parsed \(skipped\)/);
  assert.ok(!g.symbols.some((s) => s.file === file && s.kind !== "file"), `${file} produced symbols`);
}

// ---------------------------------------------------------------- TypeScript (.ts/.js/.mjs/.cjs)
test("typescript: classes, generators, arrows, every import form, cross-file dependents, malformed file", (t) => {
  TESTED_GRAMMARS.add("ts");
  const g = indexFixture(t, "ts", {
    "src/util.ts": `export function helper(x: number): number { return x * 2; }
export const arrow = (a: number) => helper(a);
export function* sequence(limit: number) { for (let i = 0; i < limit; i++) yield i; }
export class Base { protected greet(): string { return "hi"; } }
export interface Shape { area(): number; }
export type Id = string;
export default function defaultFn(): number { return helper(0); }
`,
    "src/service.ts": `import defaultFn, { helper, Base } from "./util";
import * as U from "./util";
import type { Shape, Id } from "./util";
export class Service extends Base implements Shape {
  area(): number { return helper(3); }
  async run(id: Id): Promise<number> {
    this.greet();
    return U.arrow(2) + defaultFn();
  }
  static make(): Service { return new Service(); }
}
export async function main(): Promise<void> {
  const s = Service.make();
  await s.run("x");
  for (const n of U.sequence(3)) helper(n);
}
`,
    "src/legacy.js": `import { helper } from "./util";
export function jsCaller() { return helper(5); }
`,
    "src/lazy.mjs": `export async function lazyLoad() { const m = await import("./util"); return m.helper(1); }
`,
    "src/common.cjs": `const util = require("./util");
function cjsCaller() { return util.helper(7); }
module.exports = { cjsCaller };
`,
    "src/broken.ts": "export function (\n",
  });
  assert.equal(g.status, 0, g.output);
  const U = "src/util.ts", S = "src/service.ts";
  assert.equal(g.sym("helper", U).kind, "function");
  assert.equal(g.sym("arrow", U).kind, "function");
  assert.equal(g.sym("sequence", U).kind, "function");
  assert.equal(g.sym("Base", U).kind, "class");
  assert.equal(g.sym("greet", U).kind, "method");
  assert.equal(g.sym("Shape", U).kind, "interface");
  assert.equal(g.sym("Id", U).kind, "type");
  assert.equal(g.sym("defaultFn", U).kind, "function");
  assert.equal(g.sym("Service", S).kind, "class");
  for (const m of ["area", "run", "make"]) assert.equal(g.sym(m, S).kind, "method");
  assert.equal(g.sym("main", S).kind, "function");
  assert.equal(g.sym("jsCaller", "src/legacy.js").kind, "function");
  assert.equal(g.sym("lazyLoad", "src/lazy.mjs").kind, "function");
  assert.equal(g.sym("cjsCaller", "src/common.cjs").kind, "function");
  assert.ok(g.calls(["arrow", U], ["helper", U]), "same-file arrow -> function");
  assert.ok(g.calls(["defaultFn", U], ["helper", U]), "same-file call");
  assert.ok(g.calls(["area", S], ["helper", U]), "named import call");
  assert.ok(g.calls(["run", S], ["defaultFn", U]), "default import call");
  assert.ok(g.calls(["make", S], ["Service", S]), "constructor call");
  assert.ok(g.calls(["run", S], ["greet", U]), "inherited this.method() call");
  assert.ok(g.calls(["main", S], ["make", S]) && g.calls(["main", S], ["run", S]), "static + instance method calls");
  assert.ok(g.calls(["jsCaller", "src/legacy.js"], ["helper", U]), ".js file import call");
  // cross-file dependents: helper is depended on from every importing file
  const helperDeps = fileDependents(g, "helper", U);
  for (const f of [S, "src/legacy.js"]) assert.ok(helperDeps.has(f), `helper dependents include ${f}: ${[...helperDeps]}`);
  malformedSkipped(g, "src/broken.ts");
});

// `ns.fn()` through a module-object binding resolves only inside the bound module,
// so the member gate no longer hides namespace / dynamic-import / require() calls.
test("typescript: namespace, dynamic-import and require member calls resolve cross-file", (t) => {
  const g = indexFixture(t, "ts-ns", {
    "src/util.ts": "export function helper(x: number) { return x; }\n",
    "src/ns.ts": "import * as U from \"./util\";\nexport function viaNs() { return U.helper(1); }\n",
    "src/lazy.mjs": "export async function lazyLoad() { const m = await import(\"./util\"); return m.helper(1); }\n",
    "src/common.cjs": "const util = require(\"./util\");\nfunction cjsCaller() { return util.helper(7); }\nmodule.exports = { cjsCaller };\n",
  });
  assert.equal(g.status, 0, g.output);
  assert.ok(g.calls(["viaNs", "src/ns.ts"], ["helper", "src/util.ts"]), "namespace import member call");
  assert.ok(g.calls(["lazyLoad", "src/lazy.mjs"], ["helper", "src/util.ts"]), "dynamic import member call");
  assert.ok(g.calls(["cjsCaller", "src/common.cjs"], ["helper", "src/util.ts"]), "require() member call");
});

// A module binding exposes exports, not class methods: `U.helper()` binds to the
// exported `helper`, never to a same-named `Foo.helper` in that module. (A sole
// method match is still reached by the general member gate, which allows
// `obj.method()` into imported files, so that case is not asserted here.)
test("typescript: namespace member call ignores same-named class methods in the module", (t) => {
  const g = indexFixture(t, "ts-ns-method", {
    "src/util.ts": "export class Foo { helper(x: number) { return x; } }\nexport function helper(x: number) { return x; }\n",
    "src/ns.ts": "import * as U from \"./util\";\nexport function viaNs() { return U.helper(1); }\n",
  });
  assert.equal(g.status, 0, g.output);
  const helpers = g.symbols.filter((s) => s.name === "helper" && s.file === "src/util.ts");
  const fn = helpers.find((s) => s.kind !== "method"), method = helpers.find((s) => s.kind === "method");
  assert.ok(fn && method, `fixture: function + method helper; have ${helpers.map((s) => s.kind).join(", ")}`);
  const callee = (id: string) => g.edges.some((e) => e.from === g.sym("viaNs", "src/ns.ts").id && e.to === id && e.type === "calls");
  assert.ok(callee(fn.id), "U.helper() -> exported helper");
  assert.ok(!callee(method.id), "no edge from U.helper() to Foo.helper");
});

test("commonjs: require-bound member call reaches an object-literal export despite a same-named helper elsewhere", (t) => {
  const g = indexFixture(t, "cjs-objlit", {
    "src/util.cjs": "module.exports = { helper() { return 1; } };\n",
    "src/other.cjs": "function helper() { return 2; }\nmodule.exports = { helper };\n",
    "src/caller.cjs": "const u = require(\"./util.cjs\");\nconst o = require(\"./other.cjs\");\nfunction run() { return u.helper() + o.helper(); }\nmodule.exports = { run };\n",
  });
  assert.equal(g.status, 0, g.output);
  const run = g.sym("run", "src/caller.cjs").id;
  const target = (file: string) => g.symbols.find((s) => s.name === "helper" && s.file === file)!.id;
  const callee = (id: string) => g.edges.some((e) => e.from === run && e.to === id && e.type === "calls");
  assert.ok(callee(target("src/util.cjs")), "u.helper() -> util.cjs object-literal helper");
  assert.ok(callee(target("src/other.cjs")), "o.helper() -> other.cjs helper");
});

// ---------------------------------------------------------------- TSX / JSX
test("tsx: components, hooks, class components, JSX props, every import form, malformed JSX", (t) => {
  TESTED_GRAMMARS.add("tsx");
  const g = indexFixture(t, "tsx", {
    "ui/useCounter.tsx": `import { useState, useCallback } from "react";
export function useCounter(initial = 0) {
  const [count, setCount] = useState(initial);
  const increment = useCallback(() => setCount((c) => c + 1), []);
  return { count, increment };
}
export const useDoubled = (n: number) => { const { count } = useCounter(n); return count * 2; };
`,
    "ui/Button.tsx": `import type { ReactNode } from "react";
export interface ButtonProps { label: ReactNode; onClick?: () => void; }
export type Variant = "primary" | "ghost";
export const Button = ({ label, onClick }: ButtonProps) => <button className="btn" onClick={onClick}>{label}</button>;
export function formatLabel(text: string): string { return text.toUpperCase(); }
`,
    "ui/App.tsx": `import React from "react";
import * as Buttons from "./Button";
import { Button, formatLabel } from "./Button";
import { useCounter } from "./useCounter";
export default function App(): JSX.Element {
  const { count, increment } = useCounter(1);
  const label = formatLabel("add");
  return (
    <main>
      <h1>{count} &amp; more</h1>
      <Button label={label} onClick={increment} />
      {count > 2 && <Buttons.Button label="reset" />}
    </main>
  );
}
export class LegacyPanel extends React.Component<{ title: string }> {
  handleClick = () => { this.setState({}); };
  render() { return <section onClick={this.handleClick}><App /></section>; }
}
`,
    "ui/Widget.jsx": `import { Button, formatLabel } from "./Button";
export function Widget({ name }) { return <Button label={formatLabel(name)} />; }
`,
    "ui/Partial.tsx": "export const Partial = () => <div><span>{unclosed</div>;\n",
  });
  assert.equal(g.status, 0, g.output);
  kinds(g, "ui/useCounter.tsx", { useCounter: "function", useDoubled: "function" });
  kinds(g, "ui/Button.tsx", { ButtonProps: "interface", Variant: "type", Button: "function", formatLabel: "function" });
  kinds(g, "ui/App.tsx", { App: "function", LegacyPanel: "class", render: "method" });
  kinds(g, "ui/Widget.jsx", { Widget: "function" });
  assert.ok(g.calls(["useDoubled", "ui/useCounter.tsx"], ["useCounter", "ui/useCounter.tsx"]), "hook -> hook, same file");
  assert.ok(g.calls(["App", "ui/App.tsx"], ["useCounter", "ui/useCounter.tsx"]), "component -> imported hook");
  assert.ok(g.calls(["App", "ui/App.tsx"], ["formatLabel", "ui/Button.tsx"]), "component -> named import");
  assert.ok(g.calls(["Widget", "ui/Widget.jsx"], ["formatLabel", "ui/Button.tsx"]), ".jsx -> named import");
  assert.ok(g.edges.some((e) => e.type === "imports" && e.reason.includes("ui/App.tsx imports external package react")), "external package import edge");
  const deps = fileDependents(g, "formatLabel", "ui/Button.tsx");
  for (const f of ["ui/App.tsx", "ui/Widget.jsx"]) assert.ok(deps.has(f), `formatLabel dependents include ${f}`);
  malformedSkipped(g, "ui/Partial.tsx");
});

// JSX element usage (<Button />, <ns.Button />) is a call to the component;
// intrinsic lowercase tags are not. Class-field arrows are method symbols.
test("tsx: JSX element usage creates component edges; class-field arrows are symbols", (t) => {
  const g = indexFixture(t, "tsx-jsx", {
    "ui/Button.tsx": "export const Button = () => <button />;\n",
    "ui/App.tsx": "import { Button } from \"./Button\";\nexport function App() { return <Button />; }\nexport class Panel { onClick = () => 1; }\n",
    "ui/Ns.tsx": "import * as B from \"./Button\";\nexport function Ns() { return <B.Button><button /></B.Button>; }\n",
  });
  assert.equal(g.status, 0, g.output);
  assert.ok(g.calls(["App", "ui/App.tsx"], ["Button", "ui/Button.tsx"]), "JSX usage -> component");
  assert.ok(g.calls(["Ns", "ui/Ns.tsx"], ["Button", "ui/Button.tsx"]), "namespaced JSX usage -> component");
  assert.equal(g.edges.filter((e) => e.from === g.sym("Ns", "ui/Ns.tsx").id && e.type === "calls").length, 1, "one edge, none to intrinsic tags");
  assert.equal(g.sym("onClick", "ui/App.tsx").kind, "method", "class-field arrow symbol");
});

// ---------------------------------------------------------------- Python
test("python: classes, nested defs, decorators, async, generators, every import form, malformed file", (t) => {
  TESTED_GRAMMARS.add("python");
  const g = indexFixture(t, "py", {
    "pkg/__init__.py": "",
    "pkg/models.py": `import os
import json as j
from typing import Optional


def decorator(fn):
    return fn


class Base:
    def save(self) -> None:
        j.dumps({"path": os.getcwd()})


class User(Base):
    """A user."""

    @property
    def name(self) -> str:
        return "u"

    @staticmethod
    def make() -> "User":
        return User()

    @classmethod
    def from_dict(cls, data: dict) -> "User":
        return cls.make()

    async def fetch(self) -> Optional[str]:
        return await self.load()

    async def load(self) -> str:
        return "x"

    def iterate(self):
        yield from range(3)

    class Meta:
        def inner(self):
            return 1


def helper(x):
    def nested(y):
        return y * 2
    return nested(x)


@decorator
def decorated():
    return helper(1)


async def agen():
    yield 1
`,
    "pkg/service.py": `from .models import User, helper
from . import models as m
import pkg.models
from pkg.models import decorated as deco


def run():
    user = User.make()
    user.save()
    m.helper(2)
    deco()
    return helper(1)


class Service:
    @staticmethod
    def go():
        return run()

    def __init__(self):
        self.user = User()
`,
    "app.py": `from pkg.service import Service, run


def main():
    Service().go()
    run()


if __name__ == "__main__":
    main()
`,
    "pkg/stubs.pyi": "def stubbed(x: int) -> int: ...\nclass Stub:\n    def method(self) -> None: ...\n",
    "pkg/broken.py": "def oops(:\n    pass\n",
  });
  assert.equal(g.status, 0, g.output);
  const M = "pkg/models.py", S = "pkg/service.py";
  kinds(g, M, {
    decorator: "function", Base: "class", save: "method", User: "class", name: "method", make: "method",
    from_dict: "method", fetch: "method", load: "method", iterate: "method", Meta: "class", inner: "method",
    helper: "function", nested: "function", decorated: "function", agen: "function",
  });
  kinds(g, S, { run: "function", Service: "class", go: "method", __init__: "method" });
  kinds(g, "app.py", { main: "function" });
  kinds(g, "pkg/stubs.pyi", { stubbed: "function", Stub: "class", method: "method" });
  assert.ok(g.calls(["helper", M], ["nested", M]), "nested def call");
  assert.ok(g.calls(["decorated", M], ["helper", M]), "decorated fn body call");
  assert.ok(g.calls(["fetch", M], ["load", M]), "async self.method() call");
  assert.ok(g.calls(["from_dict", M], ["make", M]), "classmethod cls.make()");
  assert.ok(g.calls(["make", M], ["User", M]), "constructor call");
  assert.ok(g.calls(["run", S], ["make", M]), "relative-import Class.staticmethod()");
  assert.ok(g.calls(["run", S], ["save", M]), "instance method call cross-file");
  assert.ok(g.calls(["run", S], ["helper", M]), "relative from-import call");
  assert.ok(g.calls(["__init__", S], ["User", M]), "constructor in __init__");
  assert.ok(g.calls(["main", "app.py"], ["run", S]) && g.calls(["main", "app.py"], ["Service", S]), "absolute from-import");
  assert.ok(g.calls(["main", "app.py"], ["go", S]), "chained method call");
  for (const pkg of ["os", "json", "typing"]) {
    assert.ok(g.edges.some((e) => e.type === "imports" && e.reason === `pkg/models.py imports external package ${pkg}`), `external import ${pkg}`);
  }
  assert.ok(g.edges.some((e) => e.type === "depends_on" && e.reason === "app.py imports pkg/service.py"), "cross-component depends_on");
  const deps = fileDependents(g, "helper", M);
  for (const f of [S, "app.py"]) assert.ok(deps.has(f), `helper transitive dependents include ${f}: ${[...deps]}`);
  malformedSkipped(g, "pkg/broken.py");
});

// Known gaps: module-attribute calls (`m.helper()`) to a top-level function in another
// file are dropped by the member gate; aliased from-imports (`decorated as deco`) are not followed.
test("python: module-attribute and aliased-import calls resolve cross-file", { todo: "indexer member gate drops m.fn(); `from x import a as b` alias not mapped" }, (t) => {
  const g = indexFixture(t, "py-alias", {
    "pkg/__init__.py": "",
    "pkg/models.py": "def helper():\n    return 1\n",
    "pkg/service.py": "from . import models as m\nfrom .models import helper as h\n\ndef viaModule():\n    return m.helper()\n\ndef viaAlias():\n    return h()\n",
  });
  assert.equal(g.status, 0, g.output);
  assert.ok(g.calls(["viaModule", "pkg/service.py"], ["helper", "pkg/models.py"]), "module attribute call");
  assert.ok(g.calls(["viaAlias", "pkg/service.py"], ["helper", "pkg/models.py"]), "aliased import call");
});

// ---------------------------------------------------------------- Go
test("go: structs, interfaces, methods, aliases, grouped/aliased imports, malformed file", (t) => {
  TESTED_GRAMMARS.add("go");
  const g = indexFixture(t, "go", {
    "go.mod": "module example.com/app\n\ngo 1.22\n",
    "geo/shape.go": `package geo

import "math"

type Shape interface {
	Area() float64
}

type Rect struct{ W, H float64 }

type Meters = float64

type Kind int

func (r Rect) Area() float64 { return r.W * r.H }

func (r *Rect) Scale(f float64) { r.W *= f; r.H *= f }

func NewRect(w, h float64) Rect { return Rect{W: w, H: h} }

func Diagonal(r Rect) float64 { return math.Sqrt(square(r.W) + square(r.H)) }

func square(x float64) float64 { return x * x }
`,
    "main.go": `package main

import (
	"fmt"
	g "example.com/app/geo"
	_ "embed"
)

func main() {
	r := g.NewRect(1, 2)
	r.Scale(2)
	fmt.Println(r.Area(), g.Diagonal(r))
	helper()
}

func helper() {}
`,
    "broken.go": "package main\nfunc (\n",
  });
  assert.equal(g.status, 0, g.output);
  const G = "geo/shape.go";
  kinds(g, G, { Shape: "interface", Rect: "class", Meters: "type", Kind: "type", Area: "method", Scale: "method", NewRect: "function", Diagonal: "function", square: "function" });
  kinds(g, "main.go", { main: "function", helper: "function" });
  assert.ok(g.calls(["Diagonal", G], ["square", G]), "same-package call");
  assert.ok(g.calls(["main", "main.go"], ["helper", "main.go"]), "same-file call");
  assert.ok(g.calls(["main", "main.go"], ["Area", G]) && g.calls(["main", "main.go"], ["Scale", G]), "method calls across packages");
  assert.ok(g.edges.some((e) => e.type === "depends_on" && e.reason === "main.go imports geo/shape.go"), "aliased module import resolves via go.mod");
  for (const pkg of ["fmt", "embed"]) assert.ok(g.edges.some((e) => e.type === "imports" && e.reason === `main.go imports external package ${pkg}`), `grouped import ${pkg}`);
  assert.ok(fileDependents(g, "Area", G).has("main.go"));
  malformedSkipped(g, "broken.go");
});

// Known gap: package-qualified calls (`g.NewRect()`) are selector expressions, so the
// member gate drops every cross-package FUNCTION call - the dominant Go call form.
test("go: package-qualified function calls resolve cross-package", { todo: "indexer member gate drops pkg.Func() to non-method symbols in other files" }, (t) => {
  const g = indexFixture(t, "go-pkg", {
    "go.mod": "module example.com/app\n\ngo 1.22\n",
    "geo/geo.go": "package geo\n\nfunc NewRect() int { return 1 }\n",
    "main.go": "package main\n\nimport g \"example.com/app/geo\"\n\nfunc main() { g.NewRect() }\n",
  });
  assert.equal(g.status, 0, g.output);
  assert.ok(g.calls(["main", "main.go"], ["NewRect", "geo/geo.go"]));
});

// ---------------------------------------------------------------- PHP
test("php: namespaces, classes, interfaces, traits, enums, functions, use/require, malformed file", (t) => {
  TESTED_GRAMMARS.add("php");
  const g = indexFixture(t, "php", {
    "composer.json": JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } } }),
    "src/Contracts/Runner.php": "<?php\nnamespace App\\Contracts;\ninterface Runner { public function run(): void; }\n",
    "src/Support/Logs.php": "<?php\nnamespace App\\Support;\ntrait Logs { public function log(string $m): void {} }\n",
    "src/Status.php": "<?php\nnamespace App;\nenum Status: string { case On = 'on'; case Off = 'off'; }\n",
    "src/Helper.php": "<?php\nnamespace App;\nclass Helper { public function execute(): void {} public static function build(): self { return new self(); } }\nfunction format_name(string $n): string { return $n; }\n",
    "src/Worker.php": `<?php
namespace App;
use App\\Contracts\\Runner;
use App\\Support\\Logs;
class Worker implements Runner {
  use Logs;
  public function run(): void {
    $helper = Helper::build();
    $helper->execute();
    $this->log('ran');
  }
}
`,
    "bootstrap.php": "<?php\nrequire_once __DIR__ . '/src/Helper.php';\nfunction boot(): void { (new App\\Worker())->run(); }\n",
    "broken.php": "<?php function (\n",
  });
  assert.equal(g.status, 0, g.output);
  kinds(g, "src/Contracts/Runner.php", { Runner: "interface", run: "method" });
  kinds(g, "src/Support/Logs.php", { Logs: "trait", log: "method" });
  kinds(g, "src/Status.php", { Status: "enum" });
  kinds(g, "src/Helper.php", { Helper: "class", execute: "method", build: "method", format_name: "function" });
  kinds(g, "src/Worker.php", { Worker: "class", run: "method" });
  kinds(g, "bootstrap.php", { boot: "function" });
  assert.ok(g.calls(["run", "src/Worker.php"], ["build", "src/Helper.php"]), "static call");
  assert.ok(g.calls(["run", "src/Worker.php"], ["execute", "src/Helper.php"]), "instance call");
  assert.ok(g.calls(["run", "src/Worker.php"], ["log", "src/Support/Logs.php"]), "trait method call");
  assert.ok(g.calls(["boot", "bootstrap.php"], ["Worker", "src/Worker.php"]), "qualified new");
  const rel = (from: [string, string], to: [string, string]) => g.edges.some((e) => e.type === "implements" && e.from === g.sym(...from).id && e.to === g.sym(...to).id);
  assert.ok(rel(["Worker", "src/Worker.php"], ["Runner", "src/Contracts/Runner.php"]), "implements via use");
  assert.ok(rel(["Worker", "src/Worker.php"], ["Logs", "src/Support/Logs.php"]), "uses trait");
  assert.ok(g.edges.some((e) => e.type === "depends_on" && e.reason === "bootstrap.php imports src/Helper.php"), "require_once resolves");
  assert.ok(fileDependents(g, "execute", "src/Helper.php").has("bootstrap.php"), "transitive dependents across files");
  malformedSkipped(g, "broken.php");
});

// ---------------------------------------------------------------- YAML / Helm
test("yaml: anchors, aliases, flow anchors, helm templates and .tpl helpers, malformed file", (t) => {
  TESTED_GRAMMARS.add("yaml");
  const g = indexFixture(t, "yaml", {
    "config/base.yaml": `defaults: &defaults
  retries: 3
  timeout: 30
limits: &limits {cpu: 1, memory: 512Mi}
service:
  <<: *defaults
  resources: *limits
worker:
  <<: *defaults
`,
    ".github/workflows/ci.yml": "name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ github.sha }}\n",
    "chart/Chart.yaml": "apiVersion: v2\nname: demo\nversion: 0.1.0\n",
    "chart/templates/deployment.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ include \"demo.fullname\" . }}\nspec:\n  replicas: {{ .Values.replicas }}\n",
    "chart/templates/_helpers.tpl": "{{- define \"demo.fullname\" -}}\n{{ .Release.Name }}-demo\n{{- end -}}\n",
    "config/broken.yaml": "key: [unclosed\n  - : :\n",
  });
  assert.equal(g.status, 0, g.output);
  kinds(g, "config/base.yaml", { defaults: "variable", limits: "variable", "base.yaml": "file" });
  kinds(g, "chart/templates/_helpers.tpl", { "demo.fullname": "variable" });
  for (const f of [".github/workflows/ci.yml", "chart/Chart.yaml", "chart/templates/deployment.yaml"]) assert.ok(g.symbols.some((s) => s.file === f && s.kind === "file"), f);
  const refs = (from: [string, string], to: [string, string]) => g.edges.some((e) => e.type === "references" && e.from === g.sym(...from).id && e.to === g.sym(...to).id);
  assert.ok(refs(["base.yaml", "config/base.yaml"], ["defaults", "config/base.yaml"]), "merge-key alias");
  assert.ok(refs(["base.yaml", "config/base.yaml"], ["limits", "config/base.yaml"]), "flow anchor alias");
  assert.ok(refs(["deployment.yaml", "chart/templates/deployment.yaml"], ["demo.fullname", "chart/templates/_helpers.tpl"]), "helm include -> define");
  assert.ok(!g.edges.some((e) => e.type === "calls"), "YAML never emits call edges");
  malformedSkipped(g, "config/broken.yaml");
});

test("every registered grammar has a CLI fixture in this file", () => {
  // node:test runs top-level tests in declaration order, so every fixture above has run.
  assert.deepEqual([...TESTED_GRAMMARS].sort(), Object.keys(EXPECTED_GRAMMARS).sort());
});
