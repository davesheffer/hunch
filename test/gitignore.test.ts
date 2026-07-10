import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGitignore } from "../src/integrations/gitignore.js";

function inTmp(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "hunch-gi-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const read = (root: string) => readFileSync(join(root, ".gitignore"), "utf8");

test("ensureGitignore creates a managed block when no .gitignore exists", () => {
  inTmp((root) => {
    assert.equal(ensureGitignore(root).action, "created");
    assert.match(read(root), /# >>> hunch/);
  });
});

test("ensureGitignore is idempotent when its own managed block is present", () => {
  inTmp((root) => {
    ensureGitignore(root);
    assert.equal(ensureGitignore(root).action, "unchanged");
    assert.equal((read(root).match(/# >>> hunch/g) ?? []).length, 1, "never a second managed block");
  });
});

test("ensureGitignore adds NO redundant block when the user already lists every entry", () => {
  inTmp((root) => {
    writeFileSync(
      join(root, ".gitignore"),
      ["node_modules/", "# Hunch derived index", ".hunch/*.sqlite", ".hunch/*.sqlite-shm", ".hunch/*.sqlite-wal", ".hunch/*.sqlite-journal", ".hunch/**/*.tmp*", ".hunch-cache/", ".hunch/local.json", ".hunch-private/", ""].join("\n"),
    );
    assert.equal(ensureGitignore(root).action, "unchanged", "all entries present → no-op");
    assert.doesNotMatch(read(root), /# >>> hunch/, "no duplicate managed block");
  });
});

test("ensureGitignore appends when at least one entry is missing", () => {
  inTmp((root) => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.hunch/*.sqlite\n"); // only 1 of 5
    assert.equal(ensureGitignore(root).action, "appended");
    assert.match(read(root), /# >>> hunch/);
  });
});
