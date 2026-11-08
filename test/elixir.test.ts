import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { matchSymbolsTiered } from "../src/core/glob.js";
import { hunchPaths } from "../src/core/paths.js";
import {
  analyzeElixirFile,
  elixirAliasesAt,
  elixirExpandAt,
  elixirImportsIn,
  expandElixirModule,
  parseElixirDirective,
  parseElixirImportFilter,
} from "../src/extractors/elixir.js";
import { indexRepo, scanRepo } from "../src/extractors/indexer.js";
import { CODE_EXTENSIONS, languageFor } from "../src/extractors/languages.js";
import { parseSource } from "../src/extractors/parse.js";
import { HunchStore } from "../src/store/hunchStore.js";

test("Elixir files are registered code", () => {
  assert.equal(languageFor("lib/app/reason.ex")?.id, "elixir");
  assert.equal(languageFor("test/app/reason_test.exs")?.id, "elixir");
  assert.ok(CODE_EXTENSIONS.includes(".ex") && CODE_EXTENSIONS.includes(".exs"));
});

test("Elixir parse yields module and function ranges, merging clauses", () => {
  const source = `defmodule App.Reason do
  @moduledoc "redaction"
  def redact(nil), do: nil
  def redact(text) when is_binary(text) do
    scrub(text)
  end

  def zero, do: :ok
  defp scrub(text), do: String.replace(text, "x", "y")
  defmacro guarded(expr) do
    expr
  end
  defguard is_reason(term) when is_atom(term)

  defmodule Inner do
    def inner, do: 1
  end
end

defprotocol App.Proto do
  def shape(value)
end
`;
  const parsed = parseSource("lib/app/reason.ex", source);
  assert.ok(parsed);
  assert.equal(parsed.parseable, true);
  const names = parsed.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`);
  assert.deepEqual(names, [
    "class:App.Reason", "function:redact", "function:zero", "function:scrub",
    "function:guarded", "function:is_reason", "class:Inner", "function:inner",
    "interface:App.Proto", "function:shape",
  ]);
  const redact = parsed.symbols.find((symbol) => symbol.name === "redact")!;
  assert.equal(redact.loc, 4, "both clauses fold into one symbol spanning lines 3-6");
  assert.ok(redact.bodyText.startsWith("def redact(nil)") && redact.bodyText.endsWith("end"));
  const module = parsed.symbols[0]!;
  assert.equal(module.startByte, 0);
  assert.equal(module.endByte, source.indexOf("\n\ndefprotocol"));
  // `String.replace` is a remote call: it never becomes a name-only call.
  assert.ok(!parsed.calls.some((call) => call.callee === "replace"));
  assert.ok(parsed.calls.some((call) => call.callee === "scrub" && !call.member));
});

test("Elixir directive parsing covers multi-alias, as:, __MODULE__ and non-module targets", () => {
  assert.deepEqual(parseElixirDirective("alias App.Reason"), { kind: "alias", modules: [{ ref: "App.Reason", local: "Reason" }] });
  assert.deepEqual(parseElixirDirective("alias App.{Reason, Sub.Gate}"), {
    kind: "alias",
    modules: [{ ref: "App.Reason", local: "Reason" }, { ref: "App.Sub.Gate", local: "Gate" }],
  });
  assert.deepEqual(parseElixirDirective("alias App.{\n  Reason,\n  Gate # the gate\n}").modules.map((m) => m.ref), ["App.Reason", "App.Gate"]);
  assert.deepEqual(parseElixirDirective("alias App.Reason, as: R"), { kind: "alias", modules: [{ ref: "App.Reason", local: "R" }] });
  assert.deepEqual(parseElixirDirective("alias(Elixir.App.Reason)"), { kind: "alias", modules: [{ ref: "App.Reason", local: "Reason" }] });
  assert.deepEqual(parseElixirDirective("alias __MODULE__.Sub"), { kind: "alias", modules: [{ ref: "__MODULE__.Sub", local: "Sub" }] });
  assert.deepEqual(parseElixirDirective("import App.Helpers, only: [h: 1]"), { kind: "import", modules: [{ ref: "App.Helpers", local: null }] });
  assert.deepEqual(parseElixirDirective("require Logger"), { kind: "require", modules: [{ ref: "Logger", local: null }] });
  assert.deepEqual(parseElixirDirective("require App.Macros, as: M"), { kind: "require", modules: [{ ref: "App.Macros", local: "M" }] });
  assert.deepEqual(parseElixirDirective("use App.Web, :controller"), { kind: "use", modules: [{ ref: "App.Web", local: null }] });
  assert.deepEqual(parseElixirDirective("alias :ets"), { kind: "alias", modules: [] });
  assert.equal(parseElixirDirective("App.Reason"), null);
});

test("Elixir module expansion follows aliases in source order, nesting and __MODULE__", () => {
  const source = `defmodule App.Worker do
  alias App.Reason
  def first, do: Reason.a()
  alias App.Other.Reason
  alias App.Orders
  alias Orders.Line
  alias __MODULE__.State
  alias App.Other.Inner
  defmodule Inner do
    def go, do: :ok
  end
  def last, do: :ok
end
`;
  const parsed = parseSource("lib/app/worker.ex", source)!;
  const analysis = analyzeElixirFile(parsed);
  assert.deepEqual([...analysis.moduleFqn.values()], ["App.Worker", "App.Worker.Inner"]);
  // An alias takes effect from its directive onward; a later one re-binds the name.
  assert.equal(elixirAliasesAt(analysis, source.indexOf("Reason.a()")).get("Reason"), "App.Reason");
  assert.equal(elixirAliasesAt(analysis, source.indexOf("Reason.a()")).has("Line"), false);
  const end = source.indexOf("def last");
  assert.equal(elixirExpandAt(analysis, end, "Reason"), "App.Other.Reason");
  assert.equal(elixirExpandAt(analysis, end, "Line"), "App.Orders.Line");
  assert.equal(elixirExpandAt(analysis, end, "State"), "App.Worker.State");
  // A nested defmodule after `alias App.Other.Inner` re-binds `Inner` to itself.
  assert.equal(elixirExpandAt(analysis, source.indexOf("defmodule Inner"), "Inner"), "App.Other.Inner");
  assert.equal(elixirExpandAt(analysis, end, "Inner"), "App.Worker.Inner");
  assert.equal(elixirExpandAt(analysis, end, "Enum"), "Enum");
  assert.equal(elixirExpandAt(analysis, source.indexOf(":ok"), "__MODULE__"), "App.Worker.Inner");
  // The nested module sees its parent's earlier aliases.
  assert.equal(elixirExpandAt(analysis, source.indexOf("def go"), "Line"), "App.Orders.Line");
  assert.equal(expandElixirModule("__MODULE__", new Map(), null), null);
  assert.equal(expandElixirModule("Reason", new Map([["Reason", null]]), "App.Worker"), null);
});

test("Elixir aliases and imports are scoped to the module and position that declare them", () => {
  const source = `defmodule A do
  alias App.Reason
  import App.Helpers, except: [h: 1]
  def a, do: Reason.redact(1)
  import App.Late
end

defmodule B do
  import App.Other, only: [k: 1, ok?: 0]
  def b, do: Reason.redact(1)
end
`;
  const parsed = parseSource("lib/ab.ex", source)!;
  const analysis = analyzeElixirFile(parsed);
  const index = (name: string): number => parsed.symbols.findIndex((symbol) => symbol.name === name);
  assert.equal(elixirAliasesAt(analysis, source.indexOf("Reason.redact")).get("Reason"), "App.Reason");
  assert.equal(elixirAliasesAt(analysis, source.lastIndexOf("Reason.redact")).has("Reason"), false, "A's alias never reaches B");
  // `import App.Late` follows `a`: it does not reach it.
  assert.deepEqual(elixirImportsIn(analysis, index("a")).map((i) => [i.module, i.only, [...i.except]]), [["App.Helpers", null, ["h"]]]);
  assert.deepEqual(elixirImportsIn(analysis, index("b")).map((i) => [i.module, [...(i.only ?? [])], [...i.except]]),
    [["App.Other", ["k", "ok?"], []]]);
  assert.deepEqual(parseElixirImportFilter("import X, only: :functions"), { only: null, except: new Set() });
  assert.deepEqual(parseElixirImportFilter("import X, except: [{:g, 1}, h?: 0]"), { only: null, except: new Set(["g", "h?"]) });
  assert.deepEqual(analysis.remoteCalls.get(index("a")), [{ callee: "redact", module: "App.Reason" }]);
  assert.deepEqual(analysis.remoteCalls.get(index("b")), [{ callee: "redact", module: "Reason" }]);
});
const FILES: Record<string, string> = {
  "lib/app/reason.ex": `defmodule App.Reason do
  def redact(nil), do: nil
  def redact(text), do: String.trim(text)
end
`,
  "lib/app/gate.ex": `defmodule App.Gate do
  defstruct [:open]
  def check(gate), do: gate.open
end
`,
  "lib/app/worker.ex": `defmodule App.Worker do
  alias App.Reason
  def run(x) do
    x |> Reason.redact() |> finish()
  end
  defp finish(x), do: x
end
`,
  "lib/app/orchestrator.ex": `defmodule App.Orchestrator do
  alias App.{Reason, Gate}
  def plan(text, gate) do
    if Gate.check(gate), do: Reason.redact(text)
  end
end
`,
  "lib/app/struct_user.ex": `defmodule App.StructUser do
  def build, do: %App.Gate{open: true}
end
`,
  "lib/app/mapper.ex": `defmodule App.Mapper do
  def map(list), do: Enum.map(list, & &1)
  def all(list), do: describe(map(list))
  def describe(list), do: list
end
`,
  "lib/app/enum_user.ex": `defmodule App.EnumUser do
  def go(list), do: Enum.map(list, & &1)
end
`,
  "lib/app/behaviour.ex": `defmodule App.Behaviour do
  @callback act() :: :ok
end
`,
  "lib/app/impl.ex": `defmodule App.Impl do
  @behaviour App.Behaviour
  import App.Reason
  def act, do: redact("x")
end
`,
  "test/app/reason_test.exs": `defmodule App.ReasonTest do
  use ExUnit.Case
  alias App.Reason
  test "redacts" do
    assert Reason.redact(nil) == nil
  end
end
`,
};

function fixture(): { root: string; store: HunchStore } {
  const root = mkdtempSync(join(tmpdir(), "hunch-elixir-index-"));
  for (const [path, body] of Object.entries(FILES)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  return { root, store };
}

test("Elixir indexing resolves aliased remote calls, structs, behaviours and imports", () => {
  const { root, store } = fixture();
  try {
    const scan = scanRepo(store, root, { churn: false });
    assert.deepEqual(scan.issues, []);
    assert.deepEqual(scan.result.coverage.find((item) => item.language === "elixir"),
      { language: "elixir", eligible: 10, parsed: 10, skipped: 0, reasons: {} });
    const name = (id: string): string => {
      const symbol = scan.symbols.find((s) => s.id === id)!;
      return `${symbol.file}#${symbol.name}`;
    };
    const edges = new Set(scan.edges
      .filter((edge) => edge.type !== "depends_on")
      .map((edge) => `${name(edge.from)} -${edge.type}-> ${name(edge.to)}`));
    for (const expected of [
      "lib/app/worker.ex#run -calls-> lib/app/reason.ex#redact",
      "lib/app/worker.ex#run -calls-> lib/app/worker.ex#finish",
      "lib/app/worker.ex#App.Worker -references-> lib/app/reason.ex#App.Reason",
      "lib/app/orchestrator.ex#plan -calls-> lib/app/reason.ex#redact",
      "lib/app/orchestrator.ex#plan -calls-> lib/app/gate.ex#check",
      "lib/app/orchestrator.ex#App.Orchestrator -references-> lib/app/gate.ex#App.Gate",
      "lib/app/struct_user.ex#build -references-> lib/app/gate.ex#App.Gate",
      "lib/app/impl.ex#App.Impl -implements-> lib/app/behaviour.ex#App.Behaviour",
      "lib/app/impl.ex#act -calls-> lib/app/reason.ex#redact",
      "lib/app/mapper.ex#all -calls-> lib/app/mapper.ex#map",
      // A Kernel/ExUnit-looking name defined in the caller's module is the callee.
      "lib/app/mapper.ex#all -calls-> lib/app/mapper.ex#describe",
      "test/app/reason_test.exs#App.ReasonTest -calls-> lib/app/reason.ex#redact",
    ]) assert.ok(edges.has(expected), `missing ${expected}\n${[...edges].join("\n")}`);
    // `Enum.map` is a call into Enum, never into a same-named repo function.
    assert.ok(![...edges].some((edge) => edge.startsWith("lib/app/enum_user.ex")), [...edges].join("\n"));
    // Unknown modules (ExUnit.Case, String, Enum) are not invented as packages.
    assert.ok(!scan.edges.some((edge) => edge.type === "imports"));
    // Two clauses of redact are one symbol.
    assert.equal(scan.symbols.filter((symbol) => symbol.name === "redact").length, 1);
    // A qualified `Module.function` target names that function.
    assert.deepEqual(matchSymbolsTiered("App.Reason.redact", scan.symbols, false).map((s) => `${s.file}#${s.name}`),
      ["lib/app/reason.ex#redact"]);
    assert.deepEqual(matchSymbolsTiered("App.Reason", scan.symbols, false).map((s) => s.file), ["lib/app/reason.ex"]);
    assert.deepEqual(matchSymbolsTiered("App.Missing.redact", scan.symbols, false), []);
  } finally {
    store.close();
    cleanupDir(root);
  }
});

test("Elixir blast radius reaches aliased callers and the covering test", () => {
  const { root, store } = fixture();
  try {
    indexRepo(store, root, { churn: false });
    store.reindex();
    const files = new Set(store.blastRadiusFiles("lib/app/reason.ex", 2).map(({ file }) => file));
    for (const expected of ["lib/app/worker.ex", "lib/app/orchestrator.ex", "lib/app/impl.ex", "test/app/reason_test.exs"]) {
      assert.ok(files.has(expected), `blast radius missing ${expected}: ${[...files].join(", ")}`);
    }
    assert.ok(!files.has("lib/app/enum_user.ex"));
    assert.ok(!files.has("lib/app/mapper.ex"));
  } finally {
    store.close();
    cleanupDir(root);
  }
});

const SCOPING_FILES: Record<string, string> = {
  "lib/app/reason.ex": "defmodule App.Reason do\n  def redact(x), do: x\nend\n",
  "lib/reason_top.ex": "defmodule Reason do\n  def redact(x), do: x\nend\n",
  "lib/app/server.ex": `defmodule App.Server do
  defp helper, do: :outer
  defmodule State do
    defp helper, do: :inner
    def new, do: helper()
  end
  def new(opts), do: {opts, helper()}
end
`,
  "lib/app/caller.ex": "defmodule App.Caller do\n  def go, do: App.Server.State.new()\nend\n",
  "lib/app/three.ex": "defmodule App.Three do\n  def f(0), do: 0\n  def f(1), do: 1\n  def f(n), do: f(n - 1)\nend\n",
  "lib/app/typed.ex": "defmodule App.Typed do\n  def result, do: :ok\nend\n",
  "lib/app/spec.ex": `defmodule App.Spec do
  import App.Typed
  @callback fetch(id()) :: result()
  @spec run(id()) :: result()
  def run(x), do: x
  def id, do: 1
end
`,
  "lib/ab.ex": `defmodule App.A do
  alias App.Reason
  def a, do: Reason.redact(1)
end

defmodule App.B do
  def b, do: Reason.redact(2)
end
`,
  "lib/app/late.ex": `defmodule App.Late do
  def early, do: Reason.redact(1)
  alias App.Reason
end
`,
  "lib/app/helpers.ex": "defmodule App.Helpers do\n  def h(x), do: x\n  def k(x), do: x\nend\n",
  "lib/app/except.ex": "defmodule App.Except do\n  import App.Helpers, except: [h: 1]\n  def go, do: h(1)\nend\n",
  "lib/app/only.ex": "defmodule App.Only do\n  import App.Helpers, only: [h: 1]\n  def go, do: {h(1), k(2)}\nend\n",
  "lib/app/outer.ex": `defmodule App.Outer do
  def x, do: 1
  defmodule __MODULE__.Sub do
    def y, do: 2
  end
end
`,
  "lib/app/outer_caller.ex": `defmodule App.OuterCaller do
  def go, do: {App.Outer.x(), App.Outer.Sub.y()}
  def wrong, do: App.Outer.y()
end
`,
};

test("Elixir scoping: nested clauses, typespecs, per-module aliases and import filters", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-elixir-scope-"));
  for (const [path, body] of Object.entries(SCOPING_FILES)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  try {
    const scan = scanRepo(store, root, { churn: false });
    assert.deepEqual(scan.issues, []);
    const sym = (file: string, body: string) => {
      const found = scan.symbols.filter((s) => s.file === file);
      const parsedBodies = parseSource(file, SCOPING_FILES[file]!)!.symbols;
      const index = parsedBodies.findIndex((s) => s.bodyText.startsWith(body));
      assert.ok(index >= 0, `no symbol starting ${body} in ${file}`);
      const match = found.filter((s) => s.name === parsedBodies[index]!.name);
      const nth = parsedBodies.slice(0, index).filter((s) => s.name === parsedBodies[index]!.name).length;
      return match[nth]!.id;
    };
    const calls = (from: string, to: string) => scan.edges.some((e) => e.type === "calls" && e.from === from && e.to === to);
    const S = "lib/app/server.ex";
    // A nested module's last `new` never merges with the parent's next `new`.
    assert.equal(scan.symbols.filter((s) => s.file === S && s.name === "new").length, 2);
    const stateNew = sym(S, "def new, do"), serverNew = sym(S, "def new(opts)");
    assert.ok(calls(sym("lib/app/caller.ex", "def go"), stateNew), "Caller.go -> State.new");
    assert.ok(calls(stateNew, sym(S, "defp helper, do: :inner")), "State.new -> State.helper");
    assert.ok(calls(serverNew, sym(S, "defp helper, do: :outer")), "Server.new -> Server.helper");
    assert.ok(!calls(stateNew, sym(S, "defp helper, do: :outer")));
    // Three clauses are one function.
    assert.equal(scan.symbols.filter((s) => s.file === "lib/app/three.ex" && s.name === "f").length, 1);
    // Typespec and callback bodies are not calls.
    const specIds = new Set(scan.symbols.filter((s) => s.file === "lib/app/spec.ex").map((s) => s.id));
    assert.deepEqual(scan.edges.filter((e) => e.type === "calls" && specIds.has(e.from)), []);
    // An alias in App.A never reaches App.B: B's `Reason` is the top-level Reason.
    const appRedact = sym("lib/app/reason.ex", "def redact"), topRedact = sym("lib/reason_top.ex", "def redact");
    assert.ok(calls(sym("lib/ab.ex", "def a"), appRedact), "A.a -> App.Reason.redact");
    assert.ok(calls(sym("lib/ab.ex", "def b"), topRedact), "B.b -> Reason.redact");
    assert.ok(!calls(sym("lib/ab.ex", "def b"), appRedact), "no edge through another module's alias");
    // A use before the alias still names the top-level module, as the compiler reads it.
    assert.ok(calls(sym("lib/app/late.ex", "def early"), topRedact), "use before alias -> Reason.redact");
    assert.ok(!calls(sym("lib/app/late.ex", "def early"), appRedact));
    // import except:/only: filters.
    const h = sym("lib/app/helpers.ex", "def h"), k = sym("lib/app/helpers.ex", "def k");
    assert.ok(!calls(sym("lib/app/except.ex", "def go"), h), "except: [h: 1] hides h");
    assert.ok(calls(sym("lib/app/only.ex", "def go"), h), "only: [h: 1] admits h");
    assert.ok(!calls(sym("lib/app/only.ex", "def go"), k), "only: [h: 1] hides k");
    // `defmodule __MODULE__.Sub` is App.Outer.Sub; its functions are not App.Outer's.
    const x = sym("lib/app/outer.ex", "def x"), y = sym("lib/app/outer.ex", "def y");
    assert.ok(calls(sym("lib/app/outer_caller.ex", "def go"), x), "App.Outer.x()");
    assert.ok(calls(sym("lib/app/outer_caller.ex", "def go"), y), "App.Outer.Sub.y()");
    assert.ok(!calls(sym("lib/app/outer_caller.ex", "def wrong"), y), "App.Outer.y() does not exist");
  } finally {
    store.close();
    cleanupDir(root);
  }
});
