import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision } from "../src/core/types.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { commitRepairReviewHash } from "../src/core/commitrepair.js";
import { readActivePendingRepairs, withheldRewrites } from "../src/core/repairqueue.js";
import { ensureGitignore } from "../src/integrations/gitignore.js";

const projectRoot = process.cwd();
const tsx = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
const cli = join(projectRoot, "src/cli/index.ts");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** Run `repair-provenance --apply` the reviewed way: pass the queue's review hash as --expect. */
function applyReviewed(root: string) {
  const queued = readActivePendingRepairs(root);
  return spawnSync(process.execPath, [tsx, cli, "repair-provenance", "--apply", "--expect", commitRepairReviewHash(queued, withheldRewrites(root, queued))], {
    cwd: root,
    env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
    encoding: "utf8",
  });
}

function queueFile(root: string): string {
  return join(root, ".hunch", "pending-commit-repairs.json");
}

/** Two accepted decisions (dec_a, dec_b) whose recorded commits are gone from this repo. */
function twoDecisionRepo(): { root: string; shaBNew: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-repair-counts-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Human");
  git(root, "config", "commit.gpgsign", "false");
  ensureGitignore(root);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "initial");
  writeFileSync(join(root, "b.ts"), "export const b = 2;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "second");
  const shaBNew = git(root, "rev-parse", "HEAD");
  const stamp = "2026-01-01T00:00:00.000Z";
  const record = (id: string, commit: string, file: string): Decision => ({
    id, title: `counts fixture ${id}`, topic: null, status: "accepted",
    context: "", decision: `keep ${file} stable`, consequences: [], alternatives_rejected: [], rejected_tripwires: [],
    related_components: [], related_files: [file], supersedes: null, superseded_by: null, caused_by_bug: null,
    commit, valid_from: stamp, valid_to: null, retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [`commit:${commit}`], last_verified: stamp },
    date: stamp,
  });
  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.put("decisions", record("dec_a", "sha_a_old", "a.ts"));
    store.json.put("decisions", record("dec_b", "sha_b_old", "b.ts"));
    store.reindex();
  } finally {
    store.close();
  }
  git(root, "add", "-A");
  git(root, "commit", "-qm", "record decisions");
  return { root, shaBNew, cleanup: () => cleanupDir(root) };
}

test("repair-provenance --apply counts same-id withheld entries per entry in BOTH the 'nothing applied' and the post-apply 'left queued' summaries", () => {
  const ghostA = "0123456789abcdef0123456789abcdef01234567";
  const ghostB = "fedcba9876543210fedcba9876543210fedcba98";

  // Nothing applied: two withheld entries sharing dec_a are two entries, not one.
  const nothing = twoDecisionRepo();
  try {
    writeFileSync(queueFile(nothing.root), JSON.stringify([
      { id: "dec_a", from: "sha_a_old", to: ghostA },
      { id: "dec_a", from: "sha_a_old", to: ghostB },
    ], null, 2) + "\n");
    const run = applyReviewed(nothing.root);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /entries whose proposed replacement commits don't resolve in this repository: dec_a, dec_a\./, "two same-id withheld entries are reported as two entries");
    assert.doesNotMatch(run.stdout, /an entry whose proposed replacement commit doesn't/);
    assert.equal((JSON.parse(readFileSync(queueFile(nothing.root), "utf8")) as unknown[]).length, 2, "both stay queued");
  } finally {
    nothing.cleanup();
  }

  // Something applied: the same two withheld entries are counted the same way.
  const some = twoDecisionRepo();
  try {
    writeFileSync(queueFile(some.root), JSON.stringify([
      { id: "dec_a", from: "sha_a_old", to: ghostA },
      { id: "dec_a", from: "sha_a_old", to: ghostB },
      { id: "dec_b", from: "sha_b_old", to: some.shaBNew },
    ], null, 2) + "\n");
    const run = applyReviewed(some.root);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Repaired 1 commit reference/, "only the dec_b entry is applied");
    assert.match(run.stdout, /2 entries left queued — the proposed replacement commit doesn't resolve in this repository: dec_a, dec_a /, "post-apply summary counts the same two entries");
  } finally {
    some.cleanup();
  }
});
