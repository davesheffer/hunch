/**
 * Safety guard for the overlay auto-commit (bug_overlay_clobber): a Hunch memory sync is PURELY
 * additive JSON. commitAndPushHunch must REFUSE to commit any staged set that deletes files or
 * stages a non-.json file — because that means its dir resolved to a real code repo (e.g. the
 * overlay was never its own git repo), and committing/pushing there would clobber the user's code.
 * We shipped exactly that; this locks the fix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { commitAndPushHunch } from "../src/extractors/git.js";

function repo(prefix: string): { root: string; git: (...a: string[]) => string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@t.co");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  return { root, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("commitAndPushHunch REFUSES a deleting / non-memory change — never commits over a code repo", () => {
  const { root, git, cleanup } = repo("hunch-clobber-");
  try {
    // a "project repo" with real source
    writeFileSync(join(root, "app.ts"), Array.from({ length: 30 }, (_, i) => `export const x${i} = ${i};`).join("\n"));
    git("add", "-A");
    git("commit", "-qm", "code");
    const before = git("rev-list", "--count", "HEAD");

    // simulate the catastrophe: a staged DELETION of the source reaches commitAndPushHunch
    git("rm", "-q", "app.ts");
    commitAndPushHunch(root, "hunch: capture dec_x");

    assert.equal(git("rev-list", "--count", "HEAD"), before, "no new commit — the guard refused the deletion");
    assert.match(git("ls-tree", "-r", "--name-only", "HEAD"), /app\.ts/, "app.ts is still in history, not clobbered");
  } finally { cleanup(); }
});

test("commitAndPushHunch DOES commit a clean memory-only (JSON) change", () => {
  const { root, git, cleanup } = repo("hunch-overlay-");
  try {
    mkdirSync(join(root, ".hunch", "decisions"), { recursive: true });
    writeFileSync(join(root, ".hunch", "decisions", "dec_1.json"), JSON.stringify({ id: "dec_1", title: "x" }));
    commitAndPushHunch(join(root, ".hunch"), "hunch: capture dec_1");

    assert.equal(git("rev-list", "--count", "HEAD"), "1", "a memory commit was created");
    assert.match(git("ls-tree", "-r", "--name-only", "HEAD"), /decisions\/dec_1\.json/, "the JSON record was committed");
  } finally { cleanup(); }
});

test("commitAndPushHunch REFUSES even a mixed change (one JSON + one source file)", () => {
  const { root, git, cleanup } = repo("hunch-mixed-");
  try {
    git("commit", "-qm", "init", "--allow-empty");
    mkdirSync(join(root, "decisions"), { recursive: true });
    writeFileSync(join(root, "decisions", "dec_1.json"), "{}");
    writeFileSync(join(root, "rogue.ts"), "export const oops = 1;"); // a non-memory file sneaks in
    const before = git("rev-list", "--count", "HEAD");
    commitAndPushHunch(root, "hunch: capture");
    assert.equal(git("rev-list", "--count", "HEAD"), before, "mixed (non-JSON present) → refused entirely");
  } finally { cleanup(); }
});
