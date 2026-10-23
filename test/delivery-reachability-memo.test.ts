import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanupDir } from "./fixtures.js";
import {
  commitReachabilityProbeCount,
  localCommitReachability,
  resetCommitReachabilityMemo,
} from "../src/core/delivery.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
}

function commit(root: string, message: string): string {
  git(root, "commit", "-q", "--allow-empty", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

test("delivery reachability: verdicts are memoized across delivery builds and follow the branch tip (#473)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-reach-memo-"));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test Human");
    const c1 = commit(root, "c1");
    const c2 = commit(root, "c2");
    git(root, "checkout", "-qb", "feature");
    const f1 = commit(root, "f1");
    git(root, "checkout", "-q", "main");

    resetCommitReachabilityMemo();
    const commits = [c1.slice(0, 7), c2, f1, "deadbeefdeadbeef"];
    const before = commitReachabilityProbeCount();
    const first = commits.map(localCommitReachability(root));
    const afterFirst = commitReachabilityProbeCount();
    assert.deepEqual(first, ["reachable", "reachable", "unreachable", "unreachable"]);
    assert.ok(afterFirst - before > commits.length, "first build probes git per commit");

    // A second delivery build re-resolves the default ref (no origin/HEAD here:
    // symbolic-ref + rev-parse main) and the tip (1); every ancestry verdict is
    // memoized, while the missing object is re-probed (a fetch could bring it in).
    const second = commits.map(localCommitReachability(root));
    assert.deepEqual(second, first);
    assert.equal(commitReachabilityProbeCount() - afterFirst, 3 + 1);
    const afterSecond = commitReachabilityProbeCount();
    assert.equal(localCommitReachability(root)("deadbeefdeadbeef"), "unreachable");
    assert.equal(commitReachabilityProbeCount() - afterSecond, 3 + 1, "missing sha is never memoized");

    // The tip moves: the feature commit becomes reachable and a new commit is judged fresh.
    git(root, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
    const c3 = commit(root, "c3");
    const third = [...commits, c3].map(localCommitReachability(root));
    assert.deepEqual(third, ["reachable", "reachable", "reachable", "unreachable", "reachable"]);
  } finally {
    resetCommitReachabilityMemo();
    cleanupDir(root);
  }
});

test("delivery reachability: a vanished default ref is re-resolved, not stuck at unknown (#473)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-reach-rename-"));
  try {
    git(root, "init", "-q", "-b", "trunk");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test Human");
    const c1 = commit(root, "c1");
    git(root, "update-ref", "refs/remotes/origin/master", c1);
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");

    resetCommitReachabilityMemo();
    assert.equal(localCommitReachability(root)(c1), "reachable");

    // Upstream renames master -> main; `fetch --prune` deletes origin/master.
    git(root, "update-ref", "refs/remotes/origin/main", c1);
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(root, "update-ref", "-d", "refs/remotes/origin/master");
    assert.equal(localCommitReachability(root)(c1), "reachable");
    assert.equal(localCommitReachability(root)(c1), "reachable");
  } finally {
    resetCommitReachabilityMemo();
    cleanupDir(root);
  }
});

test("delivery reachability: a retargeted origin/HEAD is followed even while the old ref survives (#473)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-reach-retarget-"));
  try {
    git(root, "init", "-q", "-b", "trunk");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test Human");
    const c1 = commit(root, "c1");
    const c2 = commit(root, "c2");
    git(root, "update-ref", "refs/remotes/origin/master", c1);
    git(root, "update-ref", "refs/remotes/origin/main", c2);
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");

    resetCommitReachabilityMemo();
    assert.equal(localCommitReachability(root)(c2), "unreachable");

    // origin/HEAD moves to main; origin/master is kept and still resolves.
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    assert.equal(localCommitReachability(root)(c2), "reachable");
  } finally {
    resetCommitReachabilityMemo();
    cleanupDir(root);
  }
});

test("delivery reachability: a shallow clone never memoizes verdicts (#473)", () => {
  const source = mkdtempSync(join(tmpdir(), "hunch-reach-src-"));
  const parent = mkdtempSync(join(tmpdir(), "hunch-reach-shallow-"));
  const root = join(parent, "clone");
  try {
    git(source, "init", "-q", "-b", "main");
    git(source, "config", "user.email", "test@example.com");
    git(source, "config", "user.name", "Test Human");
    commit(source, "c1");
    commit(source, "c2");
    const c3 = commit(source, "c3");
    git(parent, "clone", "-q", "--depth", "1", pathToFileURL(source).href, root);
    assert.equal(git(root, "rev-parse", "--is-shallow-repository"), "true");

    resetCommitReachabilityMemo();
    assert.equal(localCommitReachability(root)(c3), "reachable");
    const before = commitReachabilityProbeCount();
    assert.equal(localCommitReachability(root)(c3), "reachable");
    // default ref via origin/HEAD (1) + tip (1) + the commit re-probed (rev-parse + merge-base)
    assert.equal(commitReachabilityProbeCount() - before, 2 + 2, "shallow verdicts are re-probed");
    // A primed shallow build batches (cat-file + rev-list) with the same verdicts, still unmemoized.
    const primed = localCommitReachability(root);
    primed.prime([c3, "deadbeefdeadbeef"]);
    assert.deepEqual([c3, "deadbeefdeadbeef"].map((sha) => primed(sha)), ["reachable", "unreachable"]);
    const afterPrimed = commitReachabilityProbeCount();
    assert.equal(localCommitReachability(root)(c3), "reachable");
    assert.equal(commitReachabilityProbeCount() - afterPrimed, 2 + 2, "batched shallow verdicts are not memoized");
  } finally {
    resetCommitReachabilityMemo();
    cleanupDir(parent);
    cleanupDir(source);
  }
});

test("delivery reachability: unknown verdicts outside a git repo are never memoized", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-reach-nogit-"));
  try {
    resetCommitReachabilityMemo();
    assert.equal(localCommitReachability(root)("abcdef1"), "unknown");
    const before = commitReachabilityProbeCount();
    assert.equal(localCommitReachability(root)("abcdef1"), "unknown");
    assert.ok(commitReachabilityProbeCount() > before, "a later build probes git again");
  } finally {
    resetCommitReachabilityMemo();
    cleanupDir(root);
  }
});

test("delivery reachability: a primed batch gives per-commit verdicts in a constant number of git spawns (#485)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-reach-batch-"));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test Human");
    const c1 = commit(root, "c1");
    git(root, "tag", "-a", "-m", "annotated", "v1", c1);
    const tagObject = git(root, "rev-parse", "v1");
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: "blob body\n", encoding: "utf8" }).trim();
    // An unmerged feature commit, plus one orphaned by a squash merge.
    git(root, "checkout", "-qb", "feature");
    const f1 = commit(root, "f1");
    git(root, "checkout", "-q", "main");
    git(root, "checkout", "-qb", "squashed");
    const s1 = commit(root, "s1");
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--squash", "squashed");
    commit(root, "squash of s1");
    // An unrelated history that shares no root with main.
    git(root, "checkout", "-q", "--orphan", "unrelated");
    const o1 = commit(root, "o1");
    git(root, "checkout", "-q", "main");
    const mainline = Array.from({ length: 30 }, (_, i) => commit(root, `m${i}`));

    const cases = [
      c1, c1.slice(0, 7), c1.toUpperCase(), tagObject, blob, f1, s1, o1,
      "deadbeefdeadbeef", "0".repeat(40), "not-a-sha", c1, ...mainline,
    ];
    const expected = [
      "reachable", "reachable", "reachable", "reachable", "unreachable", "unreachable", "unreachable", "unreachable",
      "unreachable", "unreachable", "unreachable", "reachable", ...mainline.map(() => "reachable"),
    ];

    resetCommitReachabilityMemo();
    const perCommit = cases.map((sha) => localCommitReachability(root)(sha));
    assert.deepEqual(perCommit, expected);

    // Fresh process state, as in a new hook invocation: prime once, then look up every commit.
    resetCommitReachabilityMemo();
    const probe = localCommitReachability(root);
    probe.prime(cases);
    const before = commitReachabilityProbeCount();
    const batched = cases.map((sha) => probe(sha));
    const spent = commitReachabilityProbeCount() - before;
    assert.deepEqual(batched, perCommit, "batched verdicts match the per-commit path");
    // default ref (symbolic-ref + rev-parse main) + tip (1) + cat-file (1) + rev-list (1)
    assert.equal(spent, 3 + 1 + 1, `batched build spent ${spent} spawns for ${cases.length} commits`);

    // The same count for two commits: spawns do not grow with the number of capture commits.
    resetCommitReachabilityMemo();
    const small = localCommitReachability(root);
    small.prime([c1, f1]);
    const beforeSmall = commitReachabilityProbeCount();
    assert.deepEqual([c1, f1].map((sha) => small(sha)), ["reachable", "unreachable"]);
    assert.equal(commitReachabilityProbeCount() - beforeSmall, spent);

    // Batched ancestry verdicts feed the process memo exactly as per-commit ones do.
    const beforeMemo = commitReachabilityProbeCount();
    assert.deepEqual([c1, f1, s1].map(localCommitReachability(root)), ["reachable", "unreachable", "unreachable"]);
    assert.equal(commitReachabilityProbeCount() - beforeMemo, 3 + 2, "only s1, never primed under this memo, is probed");
  } finally {
    resetCommitReachabilityMemo();
    cleanupDir(root);
  }
});

test("delivery reachability: a timed-out batch probe primes unknown instead of 2N per-commit spawns (#485)", { skip: process.platform === "win32" ? "POSIX sh shim" : false, timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-reach-slow-"));
  const shimDir = mkdtempSync(join(tmpdir(), "hunch-reach-shim-"));
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const originalPath = process.env.PATH;
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test Human");
    const commits = Array.from({ length: 5 }, (_, i) => commit(root, `c${i}`));
    const cases = [...commits, "deadbeefdeadbeef"];

    for (const slowVerb of ["cat-file", "rev-list"]) {
      // `exec sleep` makes the shim itself the sleeper, so the 2s probe timeout kills it outright.
      writeFileSync(join(shimDir, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = "${slowVerb}" ] && exec sleep 10; done\nexec "${realGit}" "$@"\n`);
      chmodSync(join(shimDir, "git"), 0o755);
      process.env.PATH = `${shimDir}:${originalPath ?? ""}`;
      resetCommitReachabilityMemo();
      const probe = localCommitReachability(root);
      probe.prime(cases);
      const before = commitReachabilityProbeCount();
      const verdicts = cases.map((sha) => probe(sha));
      const spent = commitReachabilityProbeCount() - before;
      process.env.PATH = originalPath;
      // A slow cat-file leaves even the missing sha unjudged; a slow rev-list runs after cat-file named it missing.
      assert.deepEqual(verdicts, [...commits.map(() => "unknown"), slowVerb === "cat-file" ? "unknown" : "unreachable"], slowVerb);
      // default ref (2) + tip (1) + cat-file (1), then rev-list (1) when cat-file answered — and no per-commit fallback.
      assert.equal(spent, slowVerb === "cat-file" ? 4 : 5, `slow ${slowVerb}: ${spent} spawns for ${cases.length} commits`);
      // Unknown is never memoized: a later build with a healthy git answers.
      assert.deepEqual(commits.map(localCommitReachability(root)), commits.map(() => "reachable"));
    }
  } finally {
    process.env.PATH = originalPath;
    resetCommitReachabilityMemo();
    cleanupDir(shimDir);
    cleanupDir(root);
  }
});
