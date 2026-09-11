import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LANGUAGES, CODE_EXTENSIONS, languageFor, isSubstantive } from "../src/extractors/languages.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
};

test("LANGUAGES has typescript entries covering both grammars (plain + tsx)", () => {
  const ts = LANGUAGES.filter((l) => l.id === "typescript");
  assert.ok(ts.length >= 2, "expected a plain-TS entry and a TSX entry");
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

test("languageFor resolves every TS/JS extension to the typescript LanguageSpec", () => {
  for (const ext of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
    const lang = languageFor(`file${ext}`);
    assert.ok(lang, `no LanguageSpec for ${ext}`);
    assert.equal(lang!.id, "typescript");
  }
});

test("languageFor returns null for a non-code file", () => {
  assert.equal(languageFor("README.md"), null);
});

test("the typescript LanguageSpec's builtinMethods includes the existing JS builtin allowlist", () => {
  const ts = LANGUAGES.find((l) => l.id === "typescript")!;
  for (const m of ["map", "filter", "push", "then", "toString"]) {
    assert.ok(ts.builtinMethods.has(m), `missing builtin method ${m}`);
  }
});

test("languageFor resolves .yml and .yaml to the yaml LanguageSpec", () => {
  for (const ext of [".yml", ".yaml"]) {
    const lang = languageFor(`file${ext}`);
    assert.ok(lang, `no LanguageSpec for ${ext}`);
    assert.equal(lang!.id, "yaml");
  }
});

test("languageFor resolves .tpl (Helm helper templates) to the yaml LanguageSpec", () => {
  const lang = languageFor("templates/_helpers.tpl");
  assert.ok(lang, "no LanguageSpec for .tpl");
  assert.equal(lang!.id, "yaml");
});

test("the yaml LanguageSpec declares its alias->anchor edges as \"references\", not \"calls\"", () => {
  const yaml = LANGUAGES.find((l) => l.id === "yaml")!;
  assert.equal(yaml.referenceEdgeType, "references");
});

test("isSubstantive is true for every parseable code file", () => {
  assert.equal(isSubstantive("src/a.ts"), true);
  assert.equal(isSubstantive("cmd/server/main.go"), true);
});

test("isSubstantive is true for markdown even though languageFor returns null", () => {
  assert.equal(languageFor("docs/adr/0012-use-postgres.md"), null);
  assert.equal(isSubstantive("docs/adr/0012-use-postgres.md"), true);
});

test("isSubstantive is false for a file that is neither parseable nor prose", () => {
  assert.equal(isSubstantive("assets/logo.svg"), false);
});

test("native grammar versions stay on the tree-sitter 0.21 peer family", () => {
  assert.equal(packageJson.dependencies["tree-sitter"], "0.21.1");
  assert.equal(packageJson.dependencies["tree-sitter-python"], "0.23.4",
    "0.23.5+ requires tree-sitter 0.22 and makes a clean npm install fail");
  assert.equal(packageJson.dependencies["@tree-sitter-grammars/tree-sitter-yaml"], "^0.6.1",
    "YAML 0.7+ requires tree-sitter 0.22 and must move only with the whole native parser matrix");
  assert.equal(packageJson.dependencies["tree-sitter-php"], "0.23.12",
    "PHP 0.24+ requires tree-sitter 0.22; 0.23.12 is the latest compatible 0.21 peer");
});
