import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeOverlayTree } from "../src/core/overlaySafety.js";

// safeOverlayTree stopped re-resolving every entry with realpathSync (it only
// re-lstat'ed ancestors). These pin the containment contract that change must
// keep: any link, at any depth, still fails the whole tree.

function overlay(): { base: string; root: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), "hunch-overlay-tree-"));
  const root = join(base, "overlay");
  const outside = join(base, "outside");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".hunch", "decisions"), { recursive: true });
  mkdirSync(join(root, "docs", "deep", "er"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, ".gitattributes"), "*.json merge=hunch\n");
  writeFileSync(join(root, ".hunch", "decisions", "dec_1.json"), "{}");
  writeFileSync(join(root, "docs", "deep", "er", "note.md"), "x");
  writeFileSync(join(outside, "secret.json"), "{}");
  return { base, root, outside };
}

test("safeOverlayTree accepts an ordinary nested tree", () => {
  const f = overlay();
  try {
    assert.equal(safeOverlayTree(f.root), true);
  } finally { cleanupDir(f.base); }
});

test("safeOverlayTree rejects a directory link to outside at any depth", () => {
  for (const parent of [".hunch", join("docs", "deep", "er")]) {
    const f = overlay();
    try {
      symlinkSync(f.outside, join(f.root, parent, "escape"), process.platform === "win32" ? "junction" : "dir");
      assert.equal(safeOverlayTree(f.root), false, `link under ${parent}`);
    } finally { cleanupDir(f.base); }
  }
});

test("safeOverlayTree rejects a file symlink when the host can create one", (t) => {
  const f = overlay();
  try {
    try {
      symlinkSync(join(f.outside, "secret.json"), join(f.root, ".hunch", "decisions", "dec_2.json"), "file");
    } catch {
      t.skip("host cannot create file symlinks (unprivileged Windows)");
      return;
    }
    assert.equal(safeOverlayTree(f.root), false);
  } finally { cleanupDir(f.base); }
});

test("safeOverlayTree rejects a hard-linked top-level attributes file", () => {
  const f = overlay();
  try {
    linkSync(join(f.root, ".gitattributes"), join(f.base, "attrs-alias"));
    assert.equal(safeOverlayTree(f.root), false);
  } finally { cleanupDir(f.base); }
});

test("safeOverlayTree rejects a linked .git directory", () => {
  const f = overlay();
  try {
    cleanupDir(join(f.root, ".git"));
    symlinkSync(f.outside, join(f.root, ".git"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(safeOverlayTree(f.root), false);
  } finally { cleanupDir(f.base); }
});
