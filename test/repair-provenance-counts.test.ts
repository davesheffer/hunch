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

const queueFile = (root: string): string => join(root, ".hunch", "pending-commit-repairs.json");

/** A repo with two recorded decisions (dec_a, dec_b) and real commits their repairs can resolve to. */
function twoDecisionRepo(): { root: string; shaBNew: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-repair-counts-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Human");
  ensureGitignore(root);
  writeFileSync(join(root, "a.txt"), "x\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  writeFileSync(join(root, "b.txt"), "y\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "a commit dec_b's queued repair can resolve to");
  const shaBNew = git(root, "rev-parse", "HEAD");

  const mkDecision = (id: string, commit: string): Decision => ({
    id,
    title: `Decision ${id}`,
    topic: null,
    status: "accepted",
    context: "",
    decision: `Decision ${id}.`,
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: [`src/${id}.ts`],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [`commit:${commit}`], last_verified: "2026-01-01T00:00:00.000Z" },
    date: "2026-01-01T00:00:00.000Z",
  });

  const store = new HunchStore(hunchPaths(root));
  store.json.put("decisions", mkDecision("dec_a", "sha_a_old"));
  store.json.put("decisions", mkDecision("dec_b", "sha_b_old"));
  store.reindex();
  store.close();
  git(root, "add", ".hunch");
  git(root, "commit", "-qm", "hunch: record dec_a and dec_b");
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
    assert.match(run.stdout, /Repaired 1 commit reference/);
    assert.match(run.stdout, /2 entries left queued — the proposed replacement commit doesn't resolve in this repository: dec_a, dec_a /, "post-apply summary counts the same two entries");
  } finally {
    some.cleanup();
  }
});
