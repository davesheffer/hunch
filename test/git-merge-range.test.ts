import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitRepairStatus, commitsExist, mergeRangeChanges } from "../src/extractors/git.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commitFile(root: string, name: string, msg: string): string {
  writeFileSync(join(root, name), msg + "\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", msg);
  return git(root, "rev-parse", "--short", "HEAD");
}

const MISSING = "0123456789abcdef0123456789abcdef01234567";

function makeRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-merge-range-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "gc.auto", "0");
  git(root, "config", "maintenance.auto", "false");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  return { root, cleanup: () => cleanupDir(root) };
}

test("mergeRangeChanges returns one candidate per commit, oldest first", () => {
  const { root, cleanup } = makeRepo();
  try {
    commitFile(root, "a.txt", "base");
    const base = git(root, "rev-parse", "HEAD");
    const addB = commitFile(root, "b.txt", "add b");
    const addC = commitFile(root, "c.txt", "add c");
    assert.deepEqual(mergeRangeChanges(base, "HEAD", root), [
      { sha: addB, files: ["b.txt"] },
      { sha: addC, files: ["c.txt"] },
    ]);
  } finally { cleanup(); }
});

test("a deletion-only commit lists no files", () => {
  const { root, cleanup } = makeRepo();
  try {
    commitFile(root, "a.txt", "base");
    const base = git(root, "rev-parse", "HEAD");
    git(root, "rm", "-q", "a.txt");
    git(root, "commit", "-q", "-m", "remove a");
    const removeA = git(root, "rev-parse", "--short", "HEAD");
    const addB = commitFile(root, "b.txt", "add b");
    assert.deepEqual(mergeRangeChanges(base, "HEAD", root), [
      { sha: removeA, files: [] },
      { sha: addB, files: ["b.txt"] },
    ]);
  } finally { cleanup(); }
});

test("commitRepairStatus separates current, orphaned and unresolvable", () => {
  const { root, cleanup } = makeRepo();
  try {
    const base = commitFile(root, "a.txt", "base");
    git(root, "checkout", "-q", "-b", "feature");
    const feature = commitFile(root, "f.txt", "feature");
    git(root, "checkout", "-q", "main");
    assert.equal(commitRepairStatus(base, "main", root), "current");
    assert.equal(commitRepairStatus(feature, "main", root), "orphaned");
    assert.equal(commitRepairStatus(MISSING, "main", root), "unresolvable");
    assert.equal(commitRepairStatus("not-a-sha", "main", root), "unresolvable");
  } finally { cleanup(); }
});

test("commitRepairStatus treats a missing or non-directory cwd as unresolvable", () => {
  assert.equal(commitRepairStatus(MISSING, "main", "/nonexistent-dir-xyz"), "unresolvable");
  assert.equal(commitRepairStatus(MISSING, "main", "/etc/hosts"), "unresolvable");
});

test("an empty range yields no candidates", () => {
  const { root, cleanup } = makeRepo();
  try {
    commitFile(root, "a.txt", "base");
    assert.deepEqual(mergeRangeChanges("HEAD", "HEAD", root), []);
  } finally { cleanup(); }
});

test("the cap keeps the most recent commits", () => {
  const { root, cleanup } = makeRepo();
  try {
    commitFile(root, "a.txt", "base");
    const base = git(root, "rev-parse", "HEAD");
    commitFile(root, "b.txt", "add b");
    const addC = commitFile(root, "c.txt", "add c");
    assert.deepEqual(mergeRangeChanges(base, "HEAD", root, 1), [{ sha: addC, files: ["c.txt"] }]);
  } finally { cleanup(); }
});

test("commitsExist batches one check and keeps only resolvable shas", () => {
  const { root, cleanup } = makeRepo();
  try {
    assert.deepEqual(commitsExist([], root), new Set());
    const sha = commitFile(root, "a.txt", "base");
    assert.deepEqual(commitsExist([sha, MISSING, sha, "not-a-sha"], root), new Set([sha]));
  } finally { cleanup(); }
});

test("malformed multi-line input cannot desync the positional mapping", () => {
  const { root, cleanup } = makeRepo();
  try {
    const sha = commitFile(root, "a.txt", "base");
    assert.deepEqual(commitsExist([`${MISSING}\n${MISSING}`, sha], root), new Set([sha]));
  } finally { cleanup(); }
});

test("commitsExist returns null when git cannot run", () => {
  const notARepo = mkdtempSync(join(tmpdir(), "hunch-not-a-repo-"));
  try {
    assert.strictEqual(commitsExist([MISSING], notARepo), null);
  } finally {
    cleanupDir(notARepo);
  }
});
