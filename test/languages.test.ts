import { test } from "node:test";
import assert from "node:assert/strict";
import { LANGUAGES, CODE_EXTENSIONS, languageFor } from "../src/extractors/languages.js";

test("LANGUAGES has typescript entries covering both grammars (plain + tsx)", () => {
  const ts = LANGUAGES.filter((l) => l.id === "typescript");
  assert.ok(ts.length >= 2, "expected a plain-TS entry and a TSX entry");
});

test("CODE_EXTENSIONS matches the existing TS/JS/Python extension list", () => {
  assert.deepEqual(
    [...CODE_EXTENSIONS].sort(),
    [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx", ".py", ".pyi"].sort(),
  );
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
