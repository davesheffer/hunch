import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateExecutableBehaviorPolicy } from "../src/constitution/behaviorEvaluator.js";
import { canonicalHash } from "../src/constitution/canonical.js";
import {
  dependencySnapshotById,
  dependencySnapshotTreeHash,
  materializeDependencyTree,
  provisionG2BehaviorDependencySnapshotsForCommits,
} from "../src/constitution/g2BehaviorDependencies.js";
import {
  replayG2BehaviorCandidate,
  type G2BehaviorCandidate,
  type G2BehaviorCandidateReview,
} from "../src/constitution/g2BehaviorCandidates.js";
import { PolicySpecSchema } from "../src/constitution/schema.js";
import { shortHash } from "../src/core/ids.js";

test("dependency materialization preserves internal relative symlinks but rejects escaping links", {
  skip: process.platform === "win32" ? "creating test symlinks may require Windows developer mode" : false,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-dependency-symlink-"));
  try {
    const source = join(root, "source");
    const destination = join(root, "materialized");
    mkdirSync(join(source, ".bin"), { recursive: true });
    mkdirSync(join(source, "pkg"), { recursive: true });
    writeFileSync(join(source, "pkg", "tool.js"), "original\n");
    symlinkSync("../pkg/tool.js", join(source, ".bin", "tool"));
    const treeHash = dependencySnapshotTreeHash(source);

    assert.equal(materializeDependencyTree(source, destination), treeHash);
    assert.equal(readlinkSync(join(destination, ".bin", "tool")), "../pkg/tool.js");
    writeFileSync(join(destination, ".bin", "tool"), "changed only in the run\n");
    assert.equal(readFileSync(join(source, "pkg", "tool.js"), "utf8"), "original\n");

    writeFileSync(join(root, "outside.js"), "outside\n");
    symlinkSync("../outside.js", join(source, "escape"));
    assert.throws(() => dependencySnapshotTreeHash(source), /escaping symlink target/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("behavior execution cannot mutate its shared dependency snapshot and ordinary-file tampering invalidates reuse", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-dependency-isolation-"));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test Human");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "dependency-isolation-fixture",
      version: "1.0.0",
      type: "module",
    }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({
      name: "dependency-isolation-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "dependency-isolation-fixture", version: "1.0.0" } },
    }));
    writeFileSync(join(root, "src/guard.mjs"), "export function guarded(){ return true; }\n");
    const testSource = [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { writeFileSync } from "node:fs";',
      'import { guarded } from "../src/guard.mjs";',
      'test("guard remains enabled", () => {',
      '  writeFileSync(new URL("../node_modules/runner-created.js", import.meta.url), "shared cache was writable\\n");',
      '  assert.equal(guarded(), true);',
      '});',
      "",
    ].join("\n");
    writeFileSync(join(root, "test/guard.test.mjs"), testSource);
    git("add", "-A");
    git("commit", "-qm", "fixture: dependency isolation");
    const head = git("rev-parse", "HEAD");
    const legacyId = "g2deps_0000000000";
    const legacyDir = join(root, ".hunch-cache", "behavior-deps", legacyId);
    mkdirSync(join(legacyDir, "node_modules"), { recursive: true });
    writeFileSync(join(legacyDir, "manifest.json"), JSON.stringify({
      id: legacyId,
      content_hash: `sha1:${"0".repeat(40)}`,
      format_version: 1,
    }));
    const provisioned = provisionG2BehaviorDependencySnapshotsForCommits(root, [head]);
    const snapshot = provisioned.snapshots[0]!;
    assert.equal(snapshot.format_version, 2);
    assert.match(snapshot.node_modules_hash, /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(snapshot.id, legacyId, "v1 partial inventories are ignored and rebuilt as fresh v2 snapshots");
    const cachedNodeModules = join(root, ".hunch-cache", "behavior-deps", snapshot.id, "node_modules");
    const runnerMutation = join(cachedNodeModules, "runner-created.js");
    const at = "2026-07-19T00:00:00.000Z";
    const policy = PolicySpecSchema.parse({
      id: "pol_aaaaaaaaaa",
      topic: "behavior.dependency-isolation",
      ir_version: 2,
      revision: 1,
      state: "active_advisory",
      statement: "Executable behavior runs with an isolated dependency tree.",
      rationale: "One behavior test must not mutate the snapshot used by later evaluations.",
      scope: { repos: ["dependency-isolation-fixture"], paths: [], components: [] },
      assertion: {
        kind: "executable-behavior",
        test: {
          file: "test/guard.test.mjs",
          name: "guard remains enabled",
          source_commit: head,
          source_hash: canonicalHash(testSource),
        },
        runner: "node-test",
        attestation: {
          id: "g2behaviorattest_aaaaaaaaaa",
          content_hash: `sha1:${"a".repeat(40)}`,
          candidate_id: "g2behavior_aaaaaaaaaa",
          candidate_hash: `sha1:${"b".repeat(40)}`,
          replay_id: "g2behaviorreplay_aaaaaaaaaa",
          replay_hash: `sha1:${"c".repeat(40)}`,
        },
        dependency_snapshot_ids: [snapshot.id],
        timeout_ms: 30_000,
      },
      severity: "warning",
      surfaces: ["pre_commit", "ci", "mcp", "cli"],
      authority: { kind: "human", actor: "human:test", event: `approval-advisory:${at}`, at },
      evidence: ["fixture"],
      proof: null,
      reversal_conditions: [],
      supersedes: null,
      superseded_by: null,
      exception_of: null,
      valid_from: at,
      valid_to: null,
      data_class: "private",
      limitations: [],
      candidate: {
        alternatives: [], uncertainty: [], conflicts: [], incumbent: null, scope_suggestion: null, counterexamples: [],
      },
      legacy_refs: [],
      audit: [],
      created_at: at,
      updated_at: at,
      provenance: { source: "human_confirmed", confidence: 1, evidence: ["fixture"], last_verified: at },
    });

    const candidate: G2BehaviorCandidate = {
      id: "g2behavior_aaaaaaaaaa",
      commit: head,
      commit_subject: "fixture: dependency isolation",
      commit_date: "2026-07-19T00:00:00.000Z",
      statement: "guard remains enabled",
      test: { file: "test/guard.test.mjs", name: "guard remains enabled", source_hash: canonicalHash(testSource) },
      runner: { kind: "node-test", argv: ["node", "--test", "--test-name-pattern=guard remains enabled", "test/guard.test.mjs"] },
      decision_ids: ["dec_fixture"],
      source_candidate_ids: [],
      source_attestation_ids: [],
      proposed_corpus: {
        known_bad: { ref: head, expected: "failed" },
        known_good: { ref: head, expected: "passed" },
        observed: false,
      },
      grounding: "human_decision_plus_added_test",
      data_class: "private",
      authority: "none",
      writes: "none",
      proof_status: "not_run",
    };
    const reviewBody = {
      structural_review_hash: `sha1:${"d".repeat(40)}`,
      since: "1d",
      max_commits: 1,
      limit: 1,
      grounded_rejections_scanned: 0,
      candidate_commits: 1,
      behavior_candidates: 1,
      commits_without_added_tests: [],
      extraction_failures: [],
      items: [candidate],
      has_more: false,
      limitations: [],
      data_class: "private" as const,
      authority: "none" as const,
      writes: "none" as const,
      proof_status: "not_run" as const,
    };
    const reviewHash = canonicalHash(reviewBody);
    const review: G2BehaviorCandidateReview = {
      id: `g2behaviorcandidates_${shortHash(reviewHash)}`,
      content_hash: reviewHash,
      ...reviewBody,
    };

    const infoAttributes = join(root, ".git", "info", "attributes");
    writeFileSync(infoAttributes, "*.mjs ident\n");
    const unsafeEvaluation = evaluateExecutableBehaviorPolicy(root, policy, { commit: head });
    assert.equal(unsafeEvaluation.result, "error");
    assert.equal(unsafeEvaluation.behavior?.error_code, "unsafe-checkout-attributes");
    const unsafeReplay = replayG2BehaviorCandidate(root, review, candidate.id, review.content_hash);
    assert.equal(unsafeReplay.known_bad.error_code, "unsafe-checkout-attributes");
    assert.equal(unsafeReplay.known_good.error_code, "unsafe-checkout-attributes");
    rmSync(infoAttributes, { force: true });

    const evaluation = evaluateExecutableBehaviorPolicy(root, policy, { commit: head });
    assert.equal(evaluation.result, "satisfied");
    assert.equal(existsSync(runnerMutation), false, "the disposable runner must not write through into the shared cache");

    const alternateIndex = join(root, ".git", "alternate-index");
    const alternateEnv = { ...process.env, GIT_INDEX_FILE: alternateIndex };
    execFileSync("git", ["read-tree", head], { cwd: root, env: alternateEnv, stdio: "ignore" });
    writeFileSync(join(root, "src/guard.mjs"), "export function guarded(){ return false; }\n");
    execFileSync("git", ["add", "src/guard.mjs"], { cwd: root, env: alternateEnv, stdio: "ignore" });
    const alternateIndexBefore = readFileSync(alternateIndex);
    const previousIndex = process.env.GIT_INDEX_FILE;
    let alternateStagedEvaluation: ReturnType<typeof evaluateExecutableBehaviorPolicy>;
    try {
      process.env.GIT_INDEX_FILE = alternateIndex;
      alternateStagedEvaluation = evaluateExecutableBehaviorPolicy(root, policy, { workspace: "staged" });
    } finally {
      if (previousIndex == null) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previousIndex;
    }
    assert.equal(alternateStagedEvaluation.result, "violated", "staged evaluation must read the exact invocation index");
    assert.deepEqual(readFileSync(alternateIndex), alternateIndexBefore, "worktree creation must not reuse or mutate the invocation index");
    assert.equal(git("diff", "--cached", "--name-only"), "", "the real index remains untouched");
    writeFileSync(join(root, "src/guard.mjs"), "export function guarded(){ return true; }\n");

    const replacementSource = [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'test("guard remains enabled", () => assert.fail("replace ref source executed"));',
      "",
    ].join("\n");
    writeFileSync(join(root, "test/guard.test.mjs"), replacementSource);
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "replacement-only-fixture",
      version: "9.9.9",
      type: "module",
    }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({
      name: "replacement-only-fixture",
      version: "9.9.9",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "replacement-only-fixture", version: "9.9.9" } },
    }));
    git("add", "test/guard.test.mjs", "package.json", "package-lock.json");
    git("commit", "-qm", "fixture: replacement source");
    const replacement = git("rev-parse", "HEAD");
    git("replace", head, replacement);
    const replaceResistantEvaluation = evaluateExecutableBehaviorPolicy(root, policy, { commit: head });
    assert.equal(replaceResistantEvaluation.result, "satisfied", "pinned source and dependency reads must ignore Git replace refs");
    const replaceResistantReplay = replayG2BehaviorCandidate(root, review, candidate.id, review.content_hash);
    assert.equal(replaceResistantReplay.known_good.result, "passed", "G2 source transplant must ignore Git replace refs");
    git("replace", "-d", head);
    assert.equal(existsSync(runnerMutation), false, "replace-ref evaluation must still leave the shared cache immutable");

    writeFileSync(join(cachedNodeModules, "ordinary-tamper.js"), "tampered\n");
    assert.equal(
      dependencySnapshotById(root, snapshot.id),
      null,
      "every regular file in node_modules must be bound by the snapshot manifest",
    );
    const evaluationAfterTamper = evaluateExecutableBehaviorPolicy(root, policy, { commit: head });
    assert.equal(evaluationAfterTamper.result, "error");
    assert.equal(evaluationAfterTamper.behavior?.error_code, "dependency-snapshot-unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
