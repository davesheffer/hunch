import { cleanupDir } from "./fixtures.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Hunch DNA CLI test",
  GIT_AUTHOR_EMAIL: "hunch-dna-cli@example.test",
  GIT_COMMITTER_NAME: "Hunch DNA CLI test",
  GIT_COMMITTER_EMAIL: "hunch-dna-cli@example.test",
};

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [
    join(import.meta.dirname, "../node_modules/tsx/dist/cli.mjs"),
    join(import.meta.dirname, "../src/cli/dna.ts"),
    ...args,
  ], { cwd: root, encoding: "utf8", env });
}

test("Project DNA CLI exposes sealed profile, context, match, and drift", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-project-dna-cli-"));
  t.after(() => cleanupDir(root));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "CONTRIBUTING.md"), "Behavior changes must include tests. Keep changes focused. Explain why the change is needed in the pull request.\n");
  writeFileSync(join(root, "value.txt"), "0\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fix: initialize mutation runner");
  for (let index = 1; index <= 6; index++) {
    writeFileSync(join(root, "value.txt"), `${index}\n`);
    git(root, "add", "value.txt");
    git(root, "commit", "-qm", `fix: update mutation runner ${index}`);
  }
  const before = git(root, "rev-parse", "HEAD");

  const profileRun = run(root, "--revision", before, "--json");
  assert.equal(profileRun.status, 0, profileRun.stderr);
  const profile = JSON.parse(profileRun.stdout) as { schema: string; profile_id: string; repository_id: string; repository_revision: string };
  assert.equal(profile.schema, "hunch.project-dna/1");
  assert.match(profile.profile_id, /^pdna_[a-f0-9]{24}$/);
  assert.match(profile.repository_id, /^pdnar_[a-f0-9]{24}$/);
  assert.equal(profile.repository_revision, before);

  const contextRun = run(root, "context", "--revision", before, "--traits", "3");
  assert.equal(contextRun.status, 0, contextRun.stderr);
  assert.match(contextRun.stdout, /PROJECT DNA/);
  assert.match(contextRun.stdout, /advisory/i);

  const matchRun = run(root, "match", "--kind", "commit", "--title", "fix: handle mutation timeout", "--revision", before, "--json");
  assert.equal(matchRun.status, 0, matchRun.stderr);
  const match = JSON.parse(matchRun.stdout) as { schema: string; score: number | null };
  assert.equal(match.schema, "hunch.project-dna-match/1");
  assert.equal(match.score, 100);

  writeFileSync(join(root, "CONTRIBUTING.md"), "Behavior changes must include tests. Keep changes focused. Backward compatibility is required.\n");
  git(root, "add", "CONTRIBUTING.md");
  git(root, "commit", "-qm", "docs: clarify compatibility policy");
  const after = git(root, "rev-parse", "HEAD");

  const diffRun = run(root, "diff", before, after, "--json");
  assert.equal(diffRun.status, 0, diffRun.stderr);
  const delta = JSON.parse(diffRun.stdout) as { schema: string; changed: boolean };
  assert.equal(delta.schema, "hunch.project-dna-delta/1");
  assert.equal(delta.changed, true);
});
