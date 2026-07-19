import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LEGACY_MATRIX_COMMIT,
  LEGACY_MATRIX_TAG,
  LEGACY_MATRIX_TARBALL,
  MATRIX_PERFORMANCE_LIMITS,
  buildMatrixReceipt,
} from "../tooling/matrix-release-verification.mjs";
import {
  RELEASE_GATES,
  RELEASE_CLEAN_STATUS_ARGS,
  RELEASE_TEST_COVERAGE,
  buildVerifiedRollback,
  buildReleaseReceipt,
  executeReleasePlan,
  gateEnvironment,
  npmDistTagForVersion,
  releaseTestManifest,
  selectPreviousVersion,
  validateReleaseContext,
  verifyReleaseReceipt,
} from "../tooling/release-gate.mjs";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, stable(entry)]));
  }
  return value;
}

function rehashReceipt(receipt: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, content_hash: _hash, ...body } = receipt;
  const contentHash = `sha256:${createHash("sha256").update(JSON.stringify(stable(body))).digest("hex")}`;
  return {
    id: `release_${contentHash.slice("sha256:".length, "sha256:".length + 12)}`,
    content_hash: contentHash,
    ...body,
  };
}

function passingMatrixReceipt(candidateClean = true) {
  return buildMatrixReceipt({
    source: {
      candidate_commit: "a".repeat(40),
      candidate_clean: candidateClean,
      legacy_tag: LEGACY_MATRIX_TAG,
      legacy_commit: LEGACY_MATRIX_COMMIT,
    },
    packages: {
      legacy: {
        version: "1.8.3",
        sha256: LEGACY_MATRIX_TARBALL.sha256,
        shasum: LEGACY_MATRIX_TARBALL.shasum,
        integrity: LEGACY_MATRIX_TARBALL.integrity,
        install_mode: "isolated_tarball",
      },
      candidate: { version: "1.9.0", sha256: `sha256:${"2".repeat(64)}`, install_mode: "isolated_tarball" },
    },
    compatibility: {
      sequence: ["candidate", "legacy", "candidate"],
      candidate_record_read_by_legacy: true,
      candidate_record_bytes_preserved_by_legacy_write: true,
      legacy_record_read_after_upgrade: true,
      upgrade_record_published: true,
      candidate_policy_bytes_preserved_by_legacy_write: true,
      candidate_policy_origin_preserved_by_legacy_write: true,
      candidate_policy_activation_gate_preserved_by_legacy_write: true,
      candidate_policy_state_preserved_by_legacy_attack: true,
      candidate_policy_authority_preserved_by_legacy_attack: true,
      attack_clone_policy_bytes_preserved: true,
      attack_clone_policy_state_preserved: true,
      attack_clone_policy_authority_preserved: true,
      legacy_current_proof_approval_refused: true,
      legacy_reproof_activation_refused: true,
    },
    crash_recovery: {
      injected: true,
      commit_seam_reached: true,
      process_killed: true,
      dead_owner_lock_reclaimed: true,
      interrupted_record_recovered: true,
      recovery_record_published: true,
      overlay_operationally_clean: true,
      overlay_memory_tree_clean: true,
      only_expected_clone_local_capabilities_untracked: true,
    },
    soak: {
      actors: 3,
      rounds: 1,
      unique_writes_expected: 3,
      unique_writes_observed: 3,
      collision_writers: 3,
      collision_records_observed: 1,
      all_commands_succeeded: true,
      all_clones_converged: true,
      all_overlays_clean: true,
      all_overlay_memory_trees_clean: true,
      only_expected_clone_local_capabilities_untracked: true,
      one_canonical_remote_branch: true,
    },
    privacy: {
      sentinel_in_code_history: false,
      private_runtime_artifacts_in_code_remote: false,
      private_runtime_artifacts_in_code_remote_history: false,
      private_runtime_artifacts_in_memory_remote: false,
      private_runtime_artifacts_in_memory_remote_history: false,
    },
    isolation: {
      guarded_network_surfaces_disabled: true,
      guarded_network_surfaces: ["git", "node", "npm"],
      node_network_guard_verified: true,
      git_protocols_limited_to_file: true,
      npm_offline: true,
      credentials_inherited: false,
      dependency_lock_equivalent: true,
      dependency_lock_hash: `sha256:${"3".repeat(64)}`,
      dependency_tree_source: "candidate-npm-ci-with-identical-lock",
      legacy_source: "pinned_local_tag",
      candidate_source: "packed_exact_commit",
    },
    performance: {
      compatibility_ms: 1_000,
      crash_recovery_ms: 1_000,
      soak_ms: 3_000,
      total_ms: 6_000,
      soak_write_ops: 6,
      soak_write_ops_per_second: 2,
      limits: MATRIX_PERFORMANCE_LIMITS,
    },
  });
}

test("Phase 2O release gate is fail-closed, content-addressed, and publish-neutral", () => {
  const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
  const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(releaseWorkflow, /tags: \["v\[0-9\]\*"\]/,
    "VS Code extension tags never trigger an npm package release");
  assert.match(releaseWorkflow, /spawnSync\("npm", \["publish", tarballPath[\s\S]*"--provenance"[\s\S]*"--tag", distTag/,
    "every publication names its dist-tag and provenance explicitly");
  assert.match(releaseWorkflow, /npm publication verification failed closed/,
    "the release stays red until npm serves exact registry integrity and provenance evidence");
  assert.match(ciWorkflow, /node-version: \[22, 24\]/,
    "the exact release gate runs on both supported release runtimes before tagging");
  assert.match(ciWorkflow, /os: \[windows-latest, macos-latest\]/,
    "the real Matrix safety path runs on both non-Linux platforms");

  assert.deepEqual(RELEASE_GATES.map((gate) => gate.id), [
    "typecheck",
    "test",
    "core-build",
    "matrix-release-verification",
    "vscode-install",
    "vscode-build",
    "repository-index",
    "architectural-conformance",
    "clean-install-rehearsal",
    "production-dependency-audit",
  ]);
  assert.deepEqual(Object.keys(RELEASE_TEST_COVERAGE), [
    "legacy_receipt_compatibility",
    "compiler_golden_set",
    "evaluator_fixture_matrix",
    "adapter_certification",
    "private_leak_suite",
    "replay_isolation",
    "proof_version_invalidation",
    "g2_readiness",
    "g3_readiness",
    "md1_correction_bridge",
    "correction_retry_durability",
    "overlay_publication_safety",
    "safe_recursive_scanning",
    "destructive_action_safety",
    "cross_locale_determinism",
    "atomic_json_persistence",
    "release_pipeline_contract",
    "matrix_release_resilience",
  ]);
  assert.deepEqual(RELEASE_CLEAN_STATUS_ARGS, ["status", "--porcelain", "--untracked-files=all"],
    "candidate readiness must include untracked implementation and test files");
  assert.ok(RELEASE_TEST_COVERAGE.md1_correction_bridge.includes("test/md1-e2e.test.ts"),
    "the release receipt binds the joined public/private MD-1a black-box journey");
  assert.ok(RELEASE_TEST_COVERAGE.private_leak_suite.includes("test/md1-e2e.test.ts"),
    "the release receipt binds cross-adapter exact-zero private isolation");
  assert.ok(RELEASE_TEST_COVERAGE.overlay_publication_safety.includes("test/team-matrix-e2e.test.ts"),
    "the release receipt binds the joined three-clone team Matrix journey");
  assert.ok(RELEASE_TEST_COVERAGE.replay_isolation.includes("test/dependency-snapshot-isolation.test.ts"),
    "the release receipt binds immutable dependency materialization and cache-tamper refusal");
  assert.deepEqual(RELEASE_TEST_COVERAGE.destructive_action_safety,
    ["test/compact.test.ts", "test/revert-move-safety.test.ts"],
    "the release receipt binds both additive compaction and commit-revert safety");
  assert.deepEqual(RELEASE_TEST_COVERAGE.cross_locale_determinism,
    ["test/canonical-locale.test.ts"],
    "the release receipt binds locale-free canonical and raw-source hashes");
  assert.deepEqual(RELEASE_TEST_COVERAGE.atomic_json_persistence,
    ["src/core/io.ts", "test/io.test.ts", "test/migrate.test.ts"],
    "the release receipt binds atomic replacement and migration regressions");
  assert.ok(RELEASE_TEST_COVERAGE.release_pipeline_contract.includes(".github/workflows/release.yml"));
  assert.ok(RELEASE_TEST_COVERAGE.release_pipeline_contract.includes("test/workflow-release-contract.test.ts"),
    "the receipt binds the workflow contract that guards trusted publication");
  assert.ok(RELEASE_TEST_COVERAGE.release_pipeline_contract.includes(".github/workflows/vscode-marketplace.yml"));
  assert.ok(RELEASE_TEST_COVERAGE.release_pipeline_contract.includes("test/vscode-marketplace-workflow.test.ts"));
  assert.ok(RELEASE_TEST_COVERAGE.release_pipeline_contract.includes("tooling/vscode-publish-tools/package-lock.json"),
    "the receipt binds the reviewed transitive publisher-tool closure");
  assert.deepEqual(RELEASE_TEST_COVERAGE.matrix_release_resilience,
    ["test/matrix-release-verification.test.ts", "test/team-matrix-e2e.test.ts", "tooling/matrix-release-verification.mjs"],
    "the release receipt binds pinned-version compatibility, crash recovery, and concurrent convergence");
  assert.deepEqual(RELEASE_TEST_COVERAGE.md1_correction_bridge.slice(-2),
    ["test/md1-benchmark.test.ts", "tooling/md1-benchmark.mjs"],
    "the release receipt binds both the executable MD-1a benchmark and its real-CLI smoke test");

  assert.throws(
    () => validateReleaseContext({ packageVersion: "1.8.0", tag: "v1.7.0", clean: true, allowDirty: false }),
    /tag v1\.7\.0 does not match package version 1\.8\.0/,
  );
  assert.throws(
    () => validateReleaseContext({ packageVersion: "1.8.0", tag: "v1.8.0", clean: false, allowDirty: false }),
    /working tree is dirty.*untracked files/,
  );
  assert.throws(
    () => validateReleaseContext({ packageVersion: "1.8.0", tag: "v1.8.0", tagCommitMatches: false, clean: true, allowDirty: false }),
    /does not point to HEAD/,
  );
  assert.equal(selectPreviousVersion("1.9.0", ["1.8.3", "1.9.0-rc.1", "1.9.0"]), "1.8.3",
    "an unpublished Git tag cannot become the rollback target");
  assert.equal(selectPreviousVersion("1.9.0-rc.0", ["1.8.3", "1.9.0-beta.2"]), "1.8.3",
    "rollback always targets a prior stable publication, never another prerelease");
  assert.deepEqual(
    buildVerifiedRollback("@davesheffer/hunch", "1.9.0", ["1.8.3", "1.9.0-rc.0"]),
    {
      previous_version: "1.8.3",
      command: "npm install -g @davesheffer/hunch@1.8.3",
      emergency_demotion: "hunch policy demote <id> --actor <human> --reason <reason>",
      verified: true,
      source: "npm-registry",
      registry: "https://registry.npmjs.org/",
      published_versions_hash: "sha256:064e34c84f7a3f00a2540abf995d049e5e51eaf1d2eee4a49fa96473e6e000b5",
    },
  );
  assert.equal(npmDistTagForVersion("1.9.0-rc.0"), "next");
  assert.equal(npmDistTagForVersion("1.9.0"), "latest");
  assert.equal(npmDistTagForVersion("1.9.0+build.7"), "latest");
  assert.throws(() => npmDistTagForVersion("v1.9.0"), /not valid semver/);
  assert.throws(() => npmDistTagForVersion("01.9.0"), /not valid semver/);
  assert.throws(() => npmDistTagForVersion("1.9.0-01"), /not valid semver/);
  assert.throws(
    () => buildVerifiedRollback("@davesheffer/hunch", "1.9.0", ["1.9.0"]),
    /no published stable rollback exists/,
  );

  const calls: string[] = [];
  const results = executeReleasePlan(RELEASE_GATES, (gate) => {
    calls.push(gate.id);
    return gate.id === "core-build" ? { exitCode: 7 } : { exitCode: 0 };
  });
  assert.deepEqual(calls, ["typecheck", "test", "core-build"], "a failed prerequisite prevents every later gate and publish");
  assert.deepEqual(results.map((result) => result.status), ["passed", "passed", "failed"]);
  assert.equal(gateEnvironment("test", { HUNCH_PRIVATE_DIR: "fixture-overlay" }, "empty-overlay").HUNCH_PRIVATE_DIR, "fixture-overlay");
  assert.equal(gateEnvironment("repository-index", { HUNCH_PRIVATE_DIR: "fixture-overlay" }, "empty-overlay").HUNCH_PRIVATE_DIR, "empty-overlay");
  assert.equal(gateEnvironment("architectural-conformance", { HUNCH_PRIVATE_DIR: "fixture-overlay" }, "empty-overlay").HUNCH_PRIVATE_DIR, "empty-overlay");

  const input = {
    package: { name: "@davesheffer/hunch", version: "1.9.0" },
    source: {
      commit: "a".repeat(40), clean: true, tag: "v1.9.0",
      tag_matches_version: true, tag_commit_matches: true,
    },
    environment: { node: "v22.0.0", platform: "linux", arch: "x64" },
    gates: RELEASE_GATES.map((gate) => ({ id: gate.id, command: gate.command, status: "passed" as const, exit_code: 0 })),
    context_errors: [],
    test_manifest: releaseTestManifest(),
    rehearsal: {
      package: {
        name: "@davesheffer/hunch", version: "1.9.0",
        shasum: "b".repeat(40), integrity: "sha512-Zml4dHVyZQ==", clean_install: true,
      },
      proofs: { p3: 5, authority_grants: 0 },
      isolation: {
        clean_home: true,
        network_proxies_unreachable_during_proof: true,
        repository_hooks_executed: false,
        active_worktrees_after_run: 1,
        transient_sessions_after_run: 0,
        clean_installed_cli_corpus_roundtrip: true,
      },
      privacy: { private_sentinel_in_public_home: false, private_sentinel_preserved_in_private_home: true },
      public_receipts: [],
    },
    matrix: passingMatrixReceipt(),
    rollback: {
      previous_version: "1.7.0",
      command: "npm install -g @davesheffer/hunch@1.7.0",
      emergency_demotion: "hunch policy demote <id> --actor <human> --reason <reason>",
      verified: true,
      source: "npm-registry",
      registry: "https://registry.npmjs.org/",
      published_versions_hash: `sha256:${"c".repeat(64)}`,
    },
  };
  const receipt = buildReleaseReceipt(input);
  assert.equal(receipt.result, "passed");
  assert.equal(receipt.candidate_ready, true);
  assert.equal(receipt.publish_ready, true);
  assert.equal(verifyReleaseReceipt(receipt), true);
  assert.deepEqual(buildReleaseReceipt(input), receipt, "identical release evidence produces an identical receipt");
  assert.equal(verifyReleaseReceipt({ ...receipt, publish_ready: false }), false, "receipt tampering is visible");
  const forged = rehashReceipt({
    ...receipt,
    package: { name: "evil", version: "9.9.9" },
    result: "passed",
    candidate_ready: true,
    publish_ready: true,
  });
  assert.equal(verifyReleaseReceipt(forged), false,
    "a content-consistent receipt is still rejected when its claimed result contradicts release semantics");

  const unverifiedRollback = buildReleaseReceipt({
    ...input,
    rollback: { ...input.rollback, verified: false },
  });
  assert.equal(unverifiedRollback.result, "failed");
  assert.equal(unverifiedRollback.candidate_ready, false, "a release without a registry-proven rollback cannot ship");
  assert.equal(verifyReleaseReceipt(unverifiedRollback), true,
    "authentic failed evidence remains content-addressed and inspectable");

  const movedTag = buildReleaseReceipt({
    ...input,
    source: { ...input.source, tag_commit_matches: false },
  });
  assert.equal(movedTag.publish_ready, false, "a matching tag name cannot publish when it points away from the receipt commit");

  const missingRehearsal = buildReleaseReceipt({ ...input, rehearsal: null });
  assert.equal(missingRehearsal.result, "failed", "clean-install proof is mandatory release evidence");

  const dirty = buildReleaseReceipt({
    ...input,
    source: { ...input.source, clean: false, tag: null, tag_matches_version: null, tag_commit_matches: null },
    matrix: passingMatrixReceipt(false),
  });
  assert.equal(dirty.result, "passed");
  assert.equal(dirty.candidate_ready, false);
  assert.equal(dirty.publish_ready, false);
});
