import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LANGUAGES, CODE_EXTENSIONS, languageFor, isSubstantive } from "../src/extractors/languages.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
};

test("LANGUAGES has a plain-TS entry and a TSX entry that share the typescript id", () => {
  assert.ok(LANGUAGES.filter((l) => l.id === "typescript").length >= 2);
});

test("CODE_EXTENSIONS matches the supported TS/JS/Python/Go/PHP/YAML extension list", () => {
  assert.deepEqual(
    [...CODE_EXTENSIONS].sort(),
    [".cjs", ".cts", ".go", ".js", ".jsx", ".mjs", ".mts", ".php", ".py", ".pyi", ".tpl", ".ts", ".tsx", ".yaml", ".yml"].sort(),
  );
});

test("languageFor resolves .go to the go LanguageSpec", () => {
  const lang = languageFor("cmd/server/main.go");
  assert.ok(lang, "no LanguageSpec for .go");
  assert.equal(lang!.id, "go");
});

test("languageFor resolves .php to the PHP LanguageSpec", () => {
  assert.equal(languageFor("src/Worker.php")?.id, "php");
});

test("every TS/JS extension resolves to the typescript spec", () => {
  for (const ext of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
    const lang = languageFor(`file${ext}`);
    assert.ok(lang, `no LanguageSpec for ${ext}`);
    assert.equal(lang!.id, "typescript");
  }
});

test("languageFor does not resolve markdown", () => {
  assert.equal(languageFor("README.md"), null);
});

test("the typescript spec carries the common builtin method names", () => {
  const builtins = languageFor("a.ts")!.builtinMethods;
  for (const name of ["map", "filter", "push", "then", "toString"]) assert.ok(builtins.has(name), name);
});

test("YAML extensions resolve to the yaml spec", () => {
  assert.equal(languageFor("config/app.yml")?.id, "yaml");
  assert.equal(languageFor("config/app.yaml")?.id, "yaml");
  assert.equal(languageFor("templates/_helpers.tpl")?.id, "yaml");
});

test("the yaml spec emits references edges", () => {
  assert.equal(languageFor("a.yaml")!.referenceEdgeType, "references");
});

test("isSubstantive accepts code files", () => {
  assert.equal(isSubstantive("src/a.ts"), true);
  assert.equal(isSubstantive("cmd/server/main.go"), true);
});

test("isSubstantive accepts prose that is not parseable code", () => {
  const adr = "docs/adr/0001-use-sqlite.md";
  assert.equal(languageFor(adr), null);
  assert.equal(isSubstantive(adr), true);
});

test("isSubstantive rejects non-code, non-prose files", () => {
  assert.equal(isSubstantive("assets/logo.svg"), false);
});

test("native grammar versions stay on the tree-sitter 0.21 peer family", () => {
  assert.equal(packageJson.dependencies["tree-sitter"], "0.21.1");
  assert.equal(packageJson.dependencies["tree-sitter-python"], "0.23.4",
    "0.23.5+ requires tree-sitter 0.22 and makes a clean npm install fail");
  assert.equal(packageJson.dependencies["tree-sitter-yaml"], "npm:@tree-sitter-grammars/tree-sitter-yaml@^0.6.1",
    "YAML 0.7+ requires tree-sitter 0.22 and must move only with the whole native parser matrix");
  assert.equal(packageJson.dependencies["tree-sitter-php"], "0.23.12",
    "PHP 0.24+ requires tree-sitter 0.22; 0.23.12 is the latest compatible 0.21 peer");
});
