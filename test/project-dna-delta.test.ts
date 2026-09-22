import { cleanupDir } from "./fixtures.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverProjectDna } from "../src/core/projectDna.js";
import { assertProjectDnaDelta, diffProjectDna } from "../src/core/projectDnaDelta.js";

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Hunch DNA drift test",
  GIT_AUTHOR_EMAIL: "hunch-dna-drift@example.test",
  GIT_COMMITTER_NAME: "Hunch DNA drift test",
  GIT_COMMITTER_EMAIL: "hunch-dna-drift@example.test",
};

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("DNA drift is an immutable profile delta rather than an in-place rewrite", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-project-dna-delta-"));
  t.after(() => cleanupDir(root));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "value.txt"), "0\n");
  git(root, "add", "value.txt");
  git(root, "commit", "-qm", "initial baseline");
  for (let index = 1; index <= 5; index++) {
    writeFileSync(join(root, "value.txt"), `${index}\n`);
    git(root, "add", "value.txt");
    git(root, "commit", "-qm", `Plain subject ${index}.`);
  }
  const before = discoverProjectDna(root);

  writeFileSync(join(root, "CONTRIBUTING.md"), "Behavior changes must include tests. Keep pull requests small and focused.\n");
  git(root, "add", "CONTRIBUTING.md");
  git(root, "commit", "-qm", "fix: add contribution contract");
  for (let index = 1; index <= 12; index++) {
    writeFileSync(join(root, "value.txt"), `next-${index}\n`);
    git(root, "add", "value.txt");
    git(root, "commit", "-qm", `fix: update mutation behavior ${index}`);
  }
  const after = discoverProjectDna(root);
  const delta = diffProjectDna(before, after);

  assert.notEqual(before.profile_id, after.profile_id);
  assert.equal(delta.from_profile_id, before.profile_id);
  assert.equal(delta.repository_id, before.repository_id);
  assert.equal(delta.to_profile_id, after.profile_id);
  assert.equal(delta.changed, true);
  assert.equal(delta.changes.some((change) => change.key === "review.tests_expected" && change.kind === "added"), true);
  assert.doesNotThrow(() => assertProjectDnaDelta(delta));

  const repeat = diffProjectDna(before, after);
  assert.deepEqual(repeat, delta, "same sealed profiles produce the same delta");

  const none = diffProjectDna(after, after);
  assert.equal(none.changed, false);
  assert.deepEqual(none.changes, []);
});
