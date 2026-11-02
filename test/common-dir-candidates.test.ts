import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { checkoutCommonDir, commonDirCandidates, sameFilesystemEntry } from "../src/extractors/git.js";

const g = (cwd: string, ...a: string[]): void => { execFileSync("git", a, { cwd, stdio: ["ignore", "ignore", "ignore"] }); };

function tempRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-cdc-"));
  g(root, "init", "-q");
  g(root, "config", "user.email", "t@example.com");
  g(root, "config", "user.name", "T");
  writeFileSync(join(root, "f.txt"), "x");
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  return { root, cleanup: () => cleanupDir(root) };
}

const covers = (candidates: string[] | null, dir: string): boolean =>
  !!candidates && candidates.some((c) => sameFilesystemEntry(c, dir));

test("candidates cover the validated common dir of a plain checkout and a subdirectory", () => {
  const { root, cleanup } = tempRepo();
  try {
    mkdirSync(join(root, "pkg"));
    for (const cwd of [root, join(root, "pkg")]) {
      const common = checkoutCommonDir(cwd);
      assert.ok(common);
      assert.ok(covers(commonDirCandidates(cwd), common), cwd);
    }
  } finally { cleanup(); }
});

test("candidates cover a linked worktree's shared common dir", () => {
  const { root, cleanup } = tempRepo();
  const wt = `${root}-wt`;
  try {
    g(root, "worktree", "add", "-q", wt);
    const common = checkoutCommonDir(wt);
    assert.ok(common);
    assert.ok(sameFilesystemEntry(common, join(root, ".git")));
    assert.ok(covers(commonDirCandidates(wt), common));
  } finally { cleanup(); cleanupDir(wt); }
});

test("no repository yields no candidates; an unreadable layout or a git dir cwd yields null", () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-cdc-none-"));
  try {
    const none = commonDirCandidates(dir);
    assert.ok(none);
    // The temp dir may sit below an unrelated repository; none of its own entries appear.
    assert.ok(!none.some((c) => c.startsWith(dir)));
    writeFileSync(join(dir, ".git"), "not a gitfile\n");
    assert.equal(commonDirCandidates(dir), null);
  } finally { cleanupDir(dir); }
  const { root, cleanup } = tempRepo();
  try {
    assert.equal(commonDirCandidates(join(root, ".git")), null);
  } finally { cleanup(); }
});
