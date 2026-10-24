import test from "node:test";
import assert from "node:assert/strict";
import { analyzeDiff } from "../src/extractors/diff.js";

/** A unified diff that adds a new file with the given lines. */
function addDiff(file: string, lines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    "",
  ].join("\n");
}

/** A unified diff that modifies a file: removed lines, then added lines. */
function modifyDiff(file: string, removed: string[], added: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    "",
  ].join("\n");
}

test("adding a markdown ADR counts toward addedLines (prose churn, issue #12)", () => {
  const a = analyzeDiff(addDiff("docs/adr/0001-use-sqlite.md", ["# Use SQLite", "", "Accepted."]));
  assert.deepEqual(a.filesAdded, ["docs/adr/0001-use-sqlite.md"]);
  assert.equal(a.addedLines, 3);
});

test("declaration and import extraction stay code-only for prose", () => {
  const a = analyzeDiff(addDiff("docs/notes.md", ["function helper() {}", "import x from 'left-pad';"]));
  assert.deepEqual(a.addedSymbols, []);
  assert.deepEqual(a.addedDeps, []);
});

test("modifying a markdown file counts removed and added lines", () => {
  const a = analyzeDiff(modifyDiff("docs/adr/0002.md", ["old line"], ["new line", "another line"]));
  assert.deepEqual(a.filesModified, ["docs/adr/0002.md"]);
  assert.equal(a.removedLines, 1);
  assert.equal(a.addedLines, 2);
});

test("a pure markdown rename is recorded", () => {
  const diff = [
    "diff --git a/docs/old.md b/docs/new.md",
    "similarity index 100%",
    "rename from docs/old.md",
    "rename to docs/new.md",
    "",
  ].join("\n");
  assert.deepEqual(analyzeDiff(diff).filesRenamed, [{ from: "docs/old.md", to: "docs/new.md" }]);
});

test("deleting a markdown file is recorded with its removed lines", () => {
  const diff = [
    "diff --git a/docs/gone.md b/docs/gone.md",
    "deleted file mode 100644",
    "--- a/docs/gone.md",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-first",
    "-second",
    "",
  ].join("\n");
  const a = analyzeDiff(diff);
  assert.deepEqual(a.filesDeleted, ["docs/gone.md"]);
  assert.equal(a.removedLines, 2);
});

test("an added SVG is neither code nor prose and is ignored", () => {
  const a = analyzeDiff(addDiff("assets/logo.svg", ["<svg></svg>"]));
  assert.deepEqual(a.filesAdded, []);
  assert.equal(a.addedLines, 0);
});

test("python import regex: added `from x import(y)` and bare `from x import` yield dependency x", () => {
  for (const line of ["from x import(y)", "from x import"]) {
    const a = analyzeDiff(addDiff("src/mod.py", [line]));
    assert.deepEqual(a.addedDeps, ["x"], line);
  }
});

test("python import regex: malformed module paths yield no dependency", () => {
  for (const line of ["import os.", "import a..b", "import a.1x", "from a..b import c", "from 1abc import x"]) {
    const a = analyzeDiff(addDiff("src/mod.py", [line]));
    assert.deepEqual(a.addedDeps, [], line);
  }
});
