import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stagedFiles, workingDiff, workingFiles } from "../src/extractors/git.js";
import { SYMLINK_SKIP } from "./helpers.js";

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

test("working change surface includes staged, unstaged, and untracked files", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-working-diff-"));
  try {
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@hunch.local"]);
    git(root, ["config", "user.name", "Hunch test"]);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "tracked.ts"), "export const before = 1;\n");
    git(root, ["add", "."]); git(root, ["commit", "-m", "seed"]);

    writeFileSync(join(root, "src", "tracked.ts"), "export const after = 2;\n");
    writeFileSync(join(root, "src", "new.ts"), "export function introduced(){ return true; }\n");

    assert.deepEqual(workingFiles(root), ["src/new.ts", "src/tracked.ts"]);
    const diff = workingDiff(root);
    assert.match(diff, /export const after = 2/);
    assert.match(diff, /src\/new\.ts/);
    assert.match(diff, /export function introduced/);
  } finally {
    cleanupDir(root);
  }
});

test("non-ASCII paths enumerate as literal UTF-8, never octal-quoted (issue #50)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-quotepath-"));
  try {
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@hunch.local"]);
    git(root, ["config", "user.name", "Hunch test"]);
    // Deliberately NOT setting core.quotePath=false in the repo config — the
    // enumerators must pin it per-invocation, or git's default octal-quotes the
    // path ("src/caf\\303\\251.ts") and it silently evades every constraint
    // scope and metric keyed on the real path.
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "café.ts"), "export const brew = 1;\n");
    writeFileSync(join(root, "src", "plain.ts"), "export const plain = 1;\n");
    git(root, ["add", "."]); git(root, ["commit", "-m", "seed"]);

    writeFileSync(join(root, "src", "café.ts"), "export const brew = 2;\n");
    const files = workingFiles(root);
    assert.ok(files.includes("src/café.ts"), `expected the literal UTF-8 path, got: ${JSON.stringify(files)}`);
    assert.ok(!files.some((f) => f.includes("\\303") || f.startsWith('"')), "no octal-quoted spellings");

    const staged = stagedFilesAfterAdd(root);
    assert.ok(staged.includes("src/café.ts"), `staged enumeration too, got: ${JSON.stringify(staged)}`);
  } finally {
    cleanupDir(root);
  }
});

function stagedFilesAfterAdd(root: string): string[] {
  git(root, ["add", "."]);
  return stagedFiles(root);
}

test("workingDiff reports an untracked symlink path without reading its external target", { skip: SYMLINK_SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-working-symlink-root-"));
  const outside = mkdtempSync(join(tmpdir(), "hunch-working-symlink-outside-"));
  try {
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@hunch.local"]);
    git(root, ["config", "user.name", "Hunch test"]);
    writeFileSync(join(root, "seed.ts"), "export const seed = true;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "seed"]);
    const outsideFile = join(outside, "secret.ts");
    const secret = "export const EXTERNAL_SECRET_MUST_NOT_APPEAR = true;\n";
    writeFileSync(outsideFile, secret);
    symlinkSync(outsideFile, join(root, "linked.ts"));

    assert.deepEqual(workingFiles(root), ["linked.ts"]);
    const diff = workingDiff(root);
    assert.doesNotMatch(diff, /EXTERNAL_SECRET_MUST_NOT_APPEAR/);
    assert.equal(diff, "", "a symlink has scope visibility but contributes no synthetic source bytes");
  } finally {
    cleanupDir(root);
    cleanupDir(outside);
  }
});
