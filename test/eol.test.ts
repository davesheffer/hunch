import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeEol, lineContent, sourceLines } from "../src/core/eol.js";

test("line scanners agree on LF, CRLF, CR, and mixed endings", () => {
  const source = "one\r\ntwo\rthree\nfour";
  assert.equal(normalizeEol(source), "one\ntwo\nthree\nfour");
  assert.deepEqual([...sourceLines(source)].map((line) => line.content), ["one", "two", "three", "four"]);
  assert.deepEqual([...sourceLines(source)].map((line) => line.start), [0, 5, 9, 15]);
  assert.equal(lineContent("one\r"), "one");
});

test("the five line scanners use the shared EOL boundary", () => {
  for (const path of [
    "core/groundingMerge.ts", "integrations/hooks.ts", "integrations/gitignore.ts",
    "core/docanchors.ts", "extractors/k8sManifest.ts",
  ]) {
    const source = readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
    assert.match(source, /from "\.\.\/core\/eol\.js"|from "\.\/eol\.js"/u, path);
    assert.doesNotMatch(source, /\.replace\(\/\\r|\\r\?/u, `${path} must use the shared EOL helpers`);
  }
});
