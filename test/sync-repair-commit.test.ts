import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision } from "../src/core/types.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { ensureGitignore } from "../src/integrations/gitignore.js";

const projectRoot = process.cwd();
const tsx = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
const cli = join(projectRoot, "src/cli/index.ts");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commitCount(root: string): number {
  return Number(git(root, "rev-list", "--count", "HEAD"));
}

function renamedBindingFixture(): { root: string; decisionFile: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-sync-repair-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Human");
  mkdirSync(join(root, "src"), { recursive: true });
  ensureGitignore(root);
  writeFileSync(join(root, "src/old.ts"), "export function stableApi() { return 1; }\n");
  git(root, "add", ".gitignore", "src/old.ts");
  git(root, "commit", "-qm", "feat: add stable api");

  const decision: Decision = {
    id: "dec_rename_binding",
    title: "Keep the stable API binding current",
    topic: "stable-api-binding",
    status: "accepted",
    context: "The API moved without changing its contract.",
    decision: "Track the implementation by its exact file binding.",
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: ["src/old.ts"],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: null,
    valid_from: "2020-01-01T00:00:00.000Z",
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: ["fixture"] },
    date: "2020-01-01T00:00:00.000Z",
  };
  const store = new HunchStore(hunchPaths(root));
  store.json.put("decisions", decision);
  store.reindex();
  store.close();
  const decisionFile = join(root, ".hunch/decisions/dec_rename_binding.json");
  git(root, "add", ".hunch/decisions/dec_rename_binding.json");
  git(root, "commit", "-qm", "hunch: record stable api binding");

  git(root, "mv", "src/old.ts", "src/new.ts");
  git(root, "commit", "-qm", "refactor: move stable api implementation");
  return {
    root,
    decisionFile,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runCli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: root,
    env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
    encoding: "utf8",
  });
}

test("sync --no-commit applies rename repair without creating a hidden repair commit", () => {
  const fixture = renamedBindingFixture();
  try {
    const before = commitCount(fixture.root);
    const run = runCli(fixture.root, "sync", "HEAD", "--quiet", "--no-commit");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(commitCount(fixture.root), before, "--no-commit suppresses repair and capture commits alike");
    const repaired = JSON.parse(readFileSync(fixture.decisionFile, "utf8")) as Decision;
    assert.deepEqual(repaired.related_files, ["src/new.ts"], "repair still updates memory on disk");
  } finally {
    fixture.cleanup();
  }
});

test("normal sync folds rename repair and capture into one memory commit", () => {
  const fixture = renamedBindingFixture();
  try {
    const before = commitCount(fixture.root);
    const run = runCli(fixture.root, "sync", "HEAD", "--quiet", "--force");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(commitCount(fixture.root) - before, 1, "one sync creates at most one public memory commit");
    const committed = git(fixture.root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD");
    assert.match(committed, /^\.hunch\/decisions\/dec_rename_binding\.json$/m);
    assert.match(committed, /^\.hunch\/decisions\/dec_[a-f0-9]+\.json$/m, "the synthesized capture shares the repair commit");
    assert.equal(git(fixture.root, "status", "--porcelain"), "");
  } finally {
    fixture.cleanup();
  }
});

test("standalone repair --apply still auto-commits the repair move", () => {
  const fixture = renamedBindingFixture();
  try {
    const before = commitCount(fixture.root);
    const run = runCli(fixture.root, "repair", "HEAD", "--apply");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(commitCount(fixture.root) - before, 1);
    assert.match(git(fixture.root, "log", "-1", "--format=%s"), /^hunch: repair 1 binding\(s\) after rename/);
    const repaired = JSON.parse(readFileSync(fixture.decisionFile, "utf8")) as Decision;
    assert.deepEqual(repaired.related_files, ["src/new.ts"]);
  } finally {
    fixture.cleanup();
  }
});
