import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workingDiff, workingFiles } from "../src/extractors/git.js";

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
    rmSync(root, { recursive: true, force: true });
  }
});

test("workingDiff reports an untracked symlink path without reading its external target", () => {
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
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
