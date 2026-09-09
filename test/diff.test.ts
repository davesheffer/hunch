import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDiff } from "../src/extractors/diff.js";

function diffAddingFile(file: string, ...added: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +1,${added.length} @@`,
    ...added.map((l) => `+${l}`),
  ].join("\n");
}

test("analyzeDiff counts a new markdown file's added lines and tracks it as added (issue #12)", () => {
  const diff = diffAddingFile(
    "docs/adr/0012-use-postgres.md",
    "# Use Postgres",
    "",
    "We chose Postgres over MySQL for JSONB support.",
  );
  const a = analyzeDiff(diff);
  assert.deepEqual(a.filesAdded, ["docs/adr/0012-use-postgres.md"]);
  assert.equal(a.addedLines, 3, "markdown lines must count toward churn, not just code files");
});

test("analyzeDiff extracts no symbols/deps from markdown (prose has no declarations)", () => {
  const diff = diffAddingFile(
    "docs/adr/0012-use-postgres.md",
    "function notReallyCode() {}",
    "import fakeThing from 'nowhere';",
  );
  const a = analyzeDiff(diff);
  assert.deepEqual(a.addedSymbols, [], "declOf/importOf must stay code-only (languageFor-gated)");
  assert.deepEqual(a.addedDeps, []);
});

function diffModifyingFile(file: string, before: string[], after: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${before.length} +1,${after.length} @@`,
    ...before.map((l) => `-${l}`),
    ...after.map((l) => `+${l}`),
  ].join("\n");
}

test("analyzeDiff tracks a modified (not just new) markdown file in filesModified and both churn counters", () => {
  const diff = diffModifyingFile(
    "docs/adr/0001-use-postgres.md",
    ["We chose Postgres for JSONB support."],
    ["We chose Postgres for JSONB support and its extension ecosystem.", "Revisited 2026: still correct."],
  );
  const a = analyzeDiff(diff);
  assert.deepEqual(a.filesModified, ["docs/adr/0001-use-postgres.md"]);
  assert.equal(a.removedLines, 1);
  assert.equal(a.addedLines, 2);
});

test("analyzeDiff records a pure markdown rename (issue #12: rename tracking widened to isSubstantive)", () => {
  const diff = [
    "diff --git a/docs/old.md b/docs/new.md",
    "similarity index 100%",
    "rename from docs/old.md",
    "rename to docs/new.md",
  ].join("\n");
  const a = analyzeDiff(diff);
  assert.deepEqual(a.filesRenamed, [{ from: "docs/old.md", to: "docs/new.md" }]);
});

test("analyzeDiff tracks a deleted markdown file (issue #12: delete tracking widened to isSubstantive)", () => {
  const diff = [
    "diff --git a/docs/gone.md b/docs/gone.md",
    "deleted file mode 100644",
    "--- a/docs/gone.md",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-# Old ADR",
    "-No longer relevant.",
  ].join("\n");
  const a = analyzeDiff(diff);
  assert.deepEqual(a.filesDeleted, ["docs/gone.md"]);
  assert.equal(a.removedLines, 2);
});

test("analyzeDiff still ignores a non-code, non-prose file entirely (e.g. an SVG)", () => {
  const diff = diffAddingFile("assets/logo.svg", "<svg></svg>");
  const a = analyzeDiff(diff);
  assert.deepEqual(a.filesAdded, []);
  assert.equal(a.addedLines, 0);
});
