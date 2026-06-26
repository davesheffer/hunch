import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { commitAndPushHunch, pullHunch } from "../src/extractors/git.js";

const g = (cwd: string, ...a: string[]): void => { execFileSync("git", a, { cwd, stdio: ["ignore", "ignore", "ignore"] }); };
const cfg = (repo: string): void => { g(repo, "config", "user.email", "t@example.com"); g(repo, "config", "user.name", "T"); };
const decFiles = (hunchDir: string): string[] => { try { return readdirSync(join(hunchDir, "decisions")).sort(); } catch { return []; } };
const writeDec = (repo: string, id: string, body = "{}"): void => {
  const dir = join(repo, ".hunch", "decisions");
  mkdirSync(dir, { recursive: true }); // git doesn't track empty dirs, so the clone may lack it
  writeFileSync(join(dir, `${id}.json`), body + "\n");
};

/** A bare "GitHub" remote + two clones A and B (two machines), each a hunch-overlay repo. */
function setup(): { A: string; B: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "hunch-sync-"));
  const remote = join(base, "remote.git");
  g(base, "init", "--bare", "-b", "main", remote);
  const seed = join(base, "seed");
  mkdirSync(join(seed, ".hunch", "decisions"), { recursive: true });
  g(seed, "init", "-b", "main", "."); cfg(seed);
  writeFileSync(join(seed, ".hunch", "manifest.json"), '{"schema_version":1}\n');
  g(seed, "add", "-A"); g(seed, "commit", "-q", "-m", "seed");
  g(seed, "remote", "add", "origin", remote); g(seed, "push", "-q", "origin", "main");
  const A = join(base, "A"), B = join(base, "B");
  g(base, "clone", "-q", remote, A); cfg(A);
  g(base, "clone", "-q", remote, B); cfg(B);
  return { A, B, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("two-way sync: two clones each write a DIFFERENT decision → both converge after a sync", () => {
  const { A, B, cleanup } = setup();
  try {
    const ah = join(A, ".hunch"), bh = join(B, ".hunch");
    writeDec(A, "dec_a"); commitAndPushHunch(ah, "A: dec_a"); // A pushes dec_a
    writeDec(B, "dec_b"); commitAndPushHunch(bh, "B: dec_b"); // B pulls dec_a (clean merge), pushes BOTH
    pullHunch(ah);                                            // A pulls dec_b
    assert.deepEqual(decFiles(ah), ["dec_a.json", "dec_b.json"], "machine A converged to both records");
    assert.deepEqual(decFiles(bh), ["dec_a.json", "dec_b.json"], "machine B converged to both records");
  } finally {
    cleanup();
  }
});

test("two-way sync: push can't be rejected non-fast-forward — B's write survives A's prior push", () => {
  const { A, B, cleanup } = setup();
  try {
    const ah = join(A, ".hunch"), bh = join(B, ".hunch");
    // A pushes first; B (now behind) writes and flushes — the OLD bug was B's push rejected → B's
    // record stranded. With pull-before-push, B merges A's then pushes, so nothing is stranded.
    writeDec(A, "dec_a"); commitAndPushHunch(ah, "A: dec_a");
    writeDec(B, "dec_b"); commitAndPushHunch(bh, "B: dec_b");
    pullHunch(ah);
    assert.ok(decFiles(ah).includes("dec_b.json"), "B's record reached the remote and back to A");
    // and B is NOT left ahead/unpushed
    const sb = execFileSync("git", ["-C", bh, "status", "-sb"], { encoding: "utf8" });
    assert.ok(!/ahead/.test(sb), "B fully pushed — nothing stranded");
  } finally {
    cleanup();
  }
});

test("two-way sync: a same-file conflict aborts to a CLEAN tree (no corruption); local record is kept to retry", () => {
  const { A, B, cleanup } = setup();
  try {
    const ah = join(A, ".hunch"), bh = join(B, ".hunch");
    writeDec(A, "dec_x", '{"v":"A"}'); commitAndPushHunch(ah, "A: dec_x"); // A pushes dec_x = A
    writeDec(B, "dec_x", '{"v":"B"}'); commitAndPushHunch(bh, "B: dec_x"); // B: add/add conflict on dec_x → abort, skip push
    const status = execFileSync("git", ["-C", bh, "status", "--porcelain"], { encoding: "utf8" }).trim();
    assert.equal(status, "", "B's tree is clean after the aborted merge (no conflict markers left)");
    assert.ok(!existsSync(join(B, ".git", "MERGE_HEAD")), "no merge left in progress");
    assert.ok(existsSync(join(bh, "decisions", "dec_x.json")), "B keeps its local record (not lost — retries next write)");
  } finally {
    cleanup();
  }
});
