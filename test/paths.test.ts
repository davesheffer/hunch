import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { isRepoFile, realpathNorm, repoRelativeTarget } from "../src/core/paths.js";
import { SYMLINK_SKIP } from "./helpers.js";

// Direct unit tests of `repoRelativeTarget`'s edge cases — the shared normalizer
// the CLI and the correction module now use.

test("repoRelativeTarget: a plain in-repo absolute path rewrites to repo-relative", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-paths-"));
  try {
    assert.equal(repoRelativeTarget(join(root, "src", "foo.ts"), root), "src/foo.ts");
  } finally {
    cleanupDir(root);
  }
});

test("repoRelativeTarget: a path outside root passes through unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-paths-"));
  const outside = mkdtempSync(join(tmpdir(), "hunch-paths-outside-"));
  try {
    const target = join(outside, "elsewhere.ts");
    assert.equal(repoRelativeTarget(target, root), target.replace(/\\/g, "/"));
  } finally {
    cleanupDir(root);
    cleanupDir(outside);
  }
});

test("repoRelativeTarget: the root path itself has no repo-relative form — passes through unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-paths-"));
  try {
    // An empty relative result must be refused: a blank scope would mean a repo-wide rule.
    assert.equal(repoRelativeTarget(root, root), root.replace(/\\/g, "/"));
  } finally {
    cleanupDir(root);
  }
});

test("repoRelativeTarget: a relative glob passes through untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-paths-"));
  try {
    assert.equal(repoRelativeTarget("src/**", root), "src/**");
    assert.equal(repoRelativeTarget("./src/auth/**", root), "src/auth/**");
  } finally {
    cleanupDir(root);
  }
});

test("repoRelativeTarget: a Windows drive-letter path rewrites correctly against a Windows-style root", () => {
  // Neither path exists on a POSIX host, so both resolve through the fallback
  // ancestor walk; both are normalized before the walk so their offset still
  // comes out right.
  assert.equal(repoRelativeTarget("C:\\Users\\dev\\repo\\src\\foo.ts", "C:\\Users\\dev\\repo"), "src/foo.ts");
});

test("repoRelativeTarget: a target arriving via a symlinked root still resolves (dec_e0a36efbf5)", { skip: SYMLINK_SKIP }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-paths-symlink-"));
  try {
    // Models macOS /var vs /private/var: the same directory reached by two spellings.
    const realRoot = join(base, "real-repo");
    const linkRoot = join(base, "linked-repo");
    mkdirSync(join(realRoot, "src"), { recursive: true });
    writeFileSync(join(realRoot, "src", "session.ts"), "export const s = 1;\n");
    symlinkSync(realRoot, linkRoot);
    assert.equal(repoRelativeTarget(join(linkRoot, "src", "session.ts"), realRoot), "src/session.ts");
  } finally {
    cleanupDir(base);
  }
});

/** `isRepoFile` — the LAST-RESORT half of "is this a real path", consulted only
 *  after the index misses (issue #334). Deliberately narrow: repo-relative
 *  regular files only. */

test("isRepoFile: a real regular file inside root is true; a directory, a missing path, an escape and an absolute path are all false (issue #334)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-isrepofile-"));
  try {
    mkdirSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "empty.ts"), "// only a comment\n");
    writeFileSync(join(root, "a", "empty.ts"), "export function f(){ return 1; }\n");

    assert.equal(isRepoFile(root, "empty.ts"), true, "a regular file at the root");
    assert.equal(isRepoFile(root, "a/empty.ts"), true, "a regular file in a subdir");
    // A DIRECTORY must be false — directory targets keep flowing to structure()'s dir tier.
    assert.equal(isRepoFile(root, "a"), false, "a directory is not a file");
    assert.equal(isRepoFile(root, "nope.ts"), false, "a missing path");
    assert.equal(isRepoFile(root, ""), false, "the empty target");
    // Escaping the root is rejected rather than resolved.
    assert.equal(isRepoFile(root, "../outside.ts"), false, "a '..' escape");
    assert.equal(isRepoFile(root, ".."), false, "the parent directory itself");
    // The caller has already run repoRelativeTarget, so anything still absolute is outside the repo.
    assert.equal(isRepoFile(root, join(root, "empty.ts")), false, "an absolute path");
    assert.equal(isRepoFile(root, "C:/win/empty.ts"), false, "a Windows drive letter");
  } finally {
    cleanupDir(root);
  }
});

test("isRepoFile: an in-repo symlink pointing OUTSIDE the root is false — statSync follows links, so lexical containment alone is an existence oracle", { skip: SYMLINK_SKIP }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-isrepofile-symlink-"));
  try {
    const root = join(base, "repo");
    const outside = join(base, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.ts"), "export const secret = 1;\n");
    symlinkSync(outside, join(root, "link"));
    // "link/secret.ts" is lexically inside root and statSync says it's a file, but
    // the real target is outside — answering true would leak one bit about a path
    // the caller can't see.
    assert.equal(isRepoFile(root, "link/secret.ts"), false, "a symlinked dir escaping the root");
  } finally {
    cleanupDir(base);
  }
});

test("isRepoFile: a symlink to another file INSIDE the root stays true", { skip: SYMLINK_SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-isrepofile-inlink-"));
  try {
    mkdirSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "a", "real.ts"), "export function f(){ return 1; }\n");
    symlinkSync(join(root, "a", "real.ts"), join(root, "alias.ts"));
    assert.equal(isRepoFile(root, "alias.ts"), true, "the real target is still in the repo");
  } finally {
    cleanupDir(root);
  }
});

test("realpathNorm: a deep non-existent path walks up to the filesystem root and comes back unchanged", () => {
  const fsRoot = parse(process.cwd()).root;
  const deep = join(fsRoot, `hunch-missing-${process.pid}-${Date.now()}`, "a", "b", "c", "d.ts");
  // Every ancestor below the filesystem root is missing, so the walk must reach
  // the root, resolve it, and re-append the whole missing tail without throwing.
  assert.equal(realpathNorm(deep), deep);
  assert.equal(realpathNorm(fsRoot), realpathSync.native(fsRoot), "the root itself resolves and terminates");
  assert.equal(realpathNorm(realpathNorm(deep)), deep, "idempotent on its own output");
});

test("realpathNorm: missing segments under an existing dir are re-appended to its real path", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-paths-"));
  try {
    assert.equal(realpathNorm(join(root, "x", "y", "z.ts")), join(realpathSync.native(root), "x", "y", "z.ts"));
  } finally {
    cleanupDir(root);
  }
});
