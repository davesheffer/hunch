import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { gitCommonDir, isLinkedWorktree, currentBranch, commitAndPushHunch, pullHunchStatus, stableRepositoryName } from "../src/extractors/git.js";
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

test("stableRepositoryName is remote-name, checkout-name, worktree, and shallow-history agnostic", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-stable-repo-"));
  const remote = join(base, "canonical-source.git");
  const alternateRemote = join(base, "secondary-source.git");
  const seed = join(base, "seed");
  const full = join(base, "arbitrarily-named-full-clone");
  const shallow = join(base, "unrelated-shallow-directory-name");
  const linked = join(base, "linked-worktree-with-another-name");
  try {
    mkdirSync(seed, { recursive: true });
    g(base, "init", "--bare", "-q", "-b", "main", remote);
    g(base, "init", "--bare", "-q", "-b", "main", alternateRemote);
    g(seed, "init", "-q", "-b", "main");
    g(seed, "config", "user.email", "t@example.com");
    g(seed, "config", "user.name", "T");
    writeFileSync(join(seed, "f.txt"), "one\n");
    g(seed, "add", "f.txt");
    g(seed, "commit", "-qm", "first");
    writeFileSync(join(seed, "f.txt"), "two\n");
    g(seed, "commit", "-qam", "second");
    g(seed, "remote", "add", "publish", remote);
    g(seed, "push", "-q", "-u", "publish", "main");

    g(base, "clone", "-q", remote, full);
    // Git ignores --depth for a plain local path, so use file:// to exercise a
    // real shallow clone while still keeping this test completely offline.
    g(base, "clone", "-q", "--depth=1", pathToFileURL(remote).href, shallow);
    g(full, "remote", "rename", "origin", "upstream-renamed");
    g(shallow, "remote", "rename", "origin", "mirror-renamed");
    g(full, "remote", "add", "last-alias", alternateRemote);
    g(shallow, "remote", "add", "first-alias", pathToFileURL(alternateRemote).href);
    g(full, "worktree", "add", "-q", "-b", "linked-test", linked);

    assert.equal(execFileSync("git", ["-C", full, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      execFileSync("git", ["-C", shallow, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      "the fixtures point at the same HEAD");
    assert.equal(execFileSync("git", ["-C", full, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim(), "2");
    assert.equal(execFileSync("git", ["-C", shallow, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim(), "1",
      "the shallow fixture really lacks the root commit");

    const identity = stableRepositoryName(full);
    assert.match(identity, /^git-remote:sha256:[a-f0-9]{64}$/);
    assert.equal(stableRepositoryName(shallow), identity, "history depth and clone directory do not change the label");
    assert.equal(stableRepositoryName(linked), identity, "a linked worktree reuses the same label");
    assert.doesNotMatch(identity, /canonical-source|secondary-source|hunch-stable-repo|upstream|mirror|alias/,
      "the artifact label never exposes a remote path or remote alias");
  } finally {
    try { g(full, "worktree", "remove", "--force", linked); } catch { /* best-effort */ }
    rmSync(base, { recursive: true, force: true });
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
    const hunchDir = join(root, ".hunch");
    mkdirSync(hunchDir, { recursive: true });
    // normal path: never throws
    assert.doesNotThrow(() => commitAndPushHunch(hunchDir, "hunch: test", { push: false }));
    // held lock: pre-create the lock dir → the call must skip cleanly, not throw
    mkdirSync(join(hunchDir, ".hunch-commit.lock"), { recursive: true });
    assert.doesNotThrow(() => commitAndPushHunch(hunchDir, "hunch: test 2", { push: false }));
    assert.ok(existsSync(join(hunchDir, ".hunch-commit.lock")), "a live held lock is left intact (owner releases it)");
  } finally {
    cleanup();
  }
});

test("commit lock ownership preserves a live old owner and immediately recovers a dead owner", () => {
  const { root, cleanup } = tempRepo();
  try {
    const hunchDir = join(root, ".hunch");
    const lock = join(hunchDir, ".hunch-commit.lock");
    mkdirSync(join(hunchDir, "decisions"), { recursive: true });
    mkdirSync(join(lock, `owner-${process.pid}`), { recursive: true });
    const old = new Date(Date.now() - 30 * 60_000);
    utimesSync(lock, old, old);

    assert.equal(pullHunchStatus(hunchDir), "busy");
    assert.ok(existsSync(lock), "mtime alone never reclaims a demonstrably live owner");

    rmSync(lock, { recursive: true, force: true });
    mkdirSync(join(lock, "owner-2147483647"), { recursive: true });
    writeFileSync(join(hunchDir, "decisions", "dec_dead_owner.json"),
      `${JSON.stringify({ id: "dec_dead_owner", title: "dead owner recovery" })}\n`);
    assert.equal(commitAndPushHunch(hunchDir, "hunch: recover dead lock owner", { push: false }), "committed");
    assert.equal(existsSync(lock), false, "the successor owns and releases the recovered lock");
    assert.match(execFileSync("git", ["-C", root, "ls-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8" }),
      /\.hunch\/decisions\/dec_dead_owner\.json/);
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
