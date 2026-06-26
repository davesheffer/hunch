import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { gitCommonDir, isLinkedWorktree, currentBranch, commitAndPushHunch } from "../src/extractors/git.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { ensureSharedOverlayPointer } from "../src/integrations/worktree.js";
import { readFileSync } from "node:fs";

const g = (cwd: string, ...a: string[]): void => { execFileSync("git", a, { cwd, stdio: ["ignore", "ignore", "ignore"] }); };

function tempRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-wt-"));
  g(root, "init", "-q");
  g(root, "config", "user.email", "t@example.com");
  g(root, "config", "user.name", "T");
  g(root, "checkout", "-q", "-b", "main");
  writeFileSync(join(root, "f.txt"), "x");
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Write the SHARED overlay pointer at <git-common-dir>/hunch/local.json — what
 *  `hunch private` now does. The privateDir is absolute (worktrees resolve relative
 *  paths from their own root). */
function registerShared(repoRoot: string, overlayHunch: string): void {
  const common = gitCommonDir(repoRoot);
  mkdirSync(join(common, "hunch"), { recursive: true });
  writeFileSync(join(common, "hunch", "local.json"), JSON.stringify({ privateDir: overlayHunch }) + "\n");
}

test("git helpers: currentBranch / gitCommonDir / isLinkedWorktree on the main checkout", () => {
  const { root, cleanup } = tempRepo();
  try {
    assert.equal(currentBranch(root), "main");
    assert.ok(gitCommonDir(root).replace(/\/$/, "").endsWith(".git"), "common dir is the repo .git");
    assert.equal(isLinkedWorktree(root), false, "the main checkout is not a linked worktree");
  } finally {
    cleanup();
  }
});

test("P1: a linked worktree auto-discovers the overlay via the shared common-dir pointer (no per-worktree local.json)", () => {
  const { root, cleanup } = tempRepo();
  const wt = `${root}-wt`;
  const overlay = mkdtempSync(join(tmpdir(), "hunch-ovl-"));
  const overlayHunch = join(overlay, ".hunch");
  try {
    registerShared(root, overlayHunch);
    g(root, "worktree", "add", "-q", "-b", "feat", wt);

    assert.equal(isLinkedWorktree(wt), true);
    assert.equal(currentBranch(wt), "feat");
    // The worktree has NO .hunch/local.json, yet the store resolves the SAME overlay
    // from the shared git common dir — the whole point of seamless multi-worktree.
    assert.equal(existsSync(join(wt, ".hunch", "local.json")), false, "fresh worktree has no per-worktree pointer");
    const store = new HunchStore(hunchPaths(wt));
    assert.ok(store.privateDir, "overlay resolved in the worktree with zero per-worktree setup");
    assert.equal(store.privateDir, resolve(overlayHunch));
    store.close();
  } finally {
    try { g(root, "worktree", "remove", "--force", wt); } catch { /* best-effort */ }
    rmSync(wt, { recursive: true, force: true });
    rmSync(overlay, { recursive: true, force: true });
    cleanup();
  }
});

test("P1: a per-worktree local.json still wins over the shared pointer (explicit override / back-compat)", () => {
  const { root, cleanup } = tempRepo();
  const shared = mkdtempSync(join(tmpdir(), "hunch-shared-"));
  const local = mkdtempSync(join(tmpdir(), "hunch-local-"));
  try {
    registerShared(root, join(shared, ".hunch"));
    const perWorktree = join(hunchPaths(root).hunch, "local.json");
    mkdirSync(hunchPaths(root).hunch, { recursive: true });
    writeFileSync(perWorktree, JSON.stringify({ privateDir: join(local, ".hunch") }) + "\n");

    const store = new HunchStore(hunchPaths(root));
    assert.equal(store.privateDir, resolve(join(local, ".hunch")), "per-worktree pointer takes precedence");
    store.close();
  } finally {
    rmSync(shared, { recursive: true, force: true });
    rmSync(local, { recursive: true, force: true });
    cleanup();
  }
});

test("P3: commitAndPushHunch never throws, and a held lock makes it a no-op (skip, not crash)", () => {
  const { root, cleanup } = tempRepo();
  try {
    // normal path: never throws
    assert.doesNotThrow(() => commitAndPushHunch(root, "hunch: test"));
    // held lock: pre-create the lock dir → the call must skip cleanly, not throw
    mkdirSync(join(root, ".hunch-commit.lock"), { recursive: true });
    assert.doesNotThrow(() => commitAndPushHunch(root, "hunch: test 2"));
    assert.ok(existsSync(join(root, ".hunch-commit.lock")), "a live held lock is left intact (owner releases it)");
  } finally {
    cleanup();
  }
});

test("ensureSharedOverlayPointer: registers an absolute pointer at the common dir; idempotent; a later worktree resolves it", () => {
  const { root, cleanup } = tempRepo();
  const overlay = join(mkdtempSync(join(tmpdir(), "hunch-ovl-")), ".hunch");
  try {
    assert.equal(ensureSharedOverlayPointer(root, overlay, true), true, "writes the shared pointer");
    const file = join(gitCommonDir(root), "hunch", "local.json");
    const v = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(v.privateDir, resolve(overlay), "stored ABSOLUTE so worktrees resolve it");
    assert.equal(v.autoCommit, true);

    // idempotent: a second call returns true and doesn't churn the content
    const before = readFileSync(file, "utf8");
    assert.equal(ensureSharedOverlayPointer(root, overlay, true), true);
    assert.equal(readFileSync(file, "utf8"), before, "no rewrite when already current");

    // a fresh worktree (no per-worktree pointer) now resolves the overlay
    const wt = `${root}-wt2`;
    g(root, "worktree", "add", "-q", "-b", "feat2", wt);
    const store = new HunchStore(hunchPaths(wt));
    assert.equal(store.privateDir, resolve(overlay));
    store.close();
    g(root, "worktree", "remove", "--force", wt);
    rmSync(wt, { recursive: true, force: true });
  } finally {
    rmSync(overlay, { recursive: true, force: true });
    cleanup();
  }
});

test("ensureSharedOverlayPointer: no overlay configured → no-op (returns false, writes nothing)", () => {
  const { root, cleanup } = tempRepo();
  try {
    assert.equal(ensureSharedOverlayPointer(root, undefined, false), false);
    assert.equal(existsSync(join(gitCommonDir(root), "hunch", "local.json")), false);
  } finally {
    cleanup();
  }
});
