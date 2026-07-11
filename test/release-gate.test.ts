import assert from "node:assert/strict";
import test from "node:test";

import {
  RELEASE_GATES,
  RELEASE_TEST_COVERAGE,
  buildReleaseReceipt,
  executeReleasePlan,
  gateEnvironment,
  selectPreviousVersion,
  validateReleaseContext,
  verifyReleaseReceipt,
} from "../tooling/release-gate.mjs";

test("Phase 2O release gate is fail-closed, content-addressed, and publish-neutral", () => {
  assert.deepEqual(RELEASE_GATES.map((gate) => gate.id), [
    "typecheck",
    "test",
    "core-build",
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
  ]);

  assert.throws(
    () => validateReleaseContext({ packageVersion: "1.8.0", tag: "v1.7.0", clean: true, allowDirty: false }),
    /tag v1\.7\.0 does not match package version 1\.8\.0/,
  );
  assert.throws(
    () => validateReleaseContext({ packageVersion: "1.8.0", tag: "v1.8.0", clean: false, allowDirty: false }),
    /tracked source is dirty/,
  );
  assert.throws(
    () => validateReleaseContext({ packageVersion: "1.8.0", tag: "v1.8.0", tagCommitMatches: false, clean: true, allowDirty: false }),
    /does not point to HEAD/,
  );
  assert.equal(selectPreviousVersion("1.8.0", ["v2.0.0", "v1.8.0", "v1.7.2", "v1.7.1"]), "1.7.2");

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
    package: { name: "@davesheffer/hunch", version: "1.8.0" },
    source: { commit: "a".repeat(40), clean: true, tag: "v1.8.0", tag_matches_version: true },
    environment: { node: "v22.0.0", platform: "linux", arch: "x64" },
    gates: RELEASE_GATES.map((gate) => ({ id: gate.id, command: gate.command, status: "passed" as const, exit_code: 0 })),
    context_errors: [],
    test_manifest: { privacy: ["test/private-overlay.test.ts"], replay: ["test/constitution.test.ts"] },
    rehearsal: {
      package: { shasum: "b".repeat(40), integrity: "sha512-fixture", clean_install: true },
      proofs: { p3: 5, authority_grants: 0 },
      isolation: { active_worktrees_after_run: 1, transient_sessions_after_run: 0 },
      privacy: { private_sentinel_in_public_home: false, private_sentinel_preserved_in_private_home: true },
    },
    rollback: { previous_version: "1.7.0", command: "npm install -g @davesheffer/hunch@1.7.0", emergency_demotion: "hunch policy demote <id> --actor <human> --reason <reason>" },
  };
  const receipt = buildReleaseReceipt(input);
  assert.equal(receipt.result, "passed");
  assert.equal(receipt.candidate_ready, true);
  assert.equal(receipt.publish_ready, true);
  assert.equal(verifyReleaseReceipt(receipt), true);
  assert.deepEqual(buildReleaseReceipt(input), receipt, "identical release evidence produces an identical receipt");
  assert.equal(verifyReleaseReceipt({ ...receipt, publish_ready: false }), false, "receipt tampering is visible");

  const dirty = buildReleaseReceipt({
    ...input,
    source: { ...input.source, clean: false, tag: null, tag_matches_version: null },
  });
  assert.equal(dirty.result, "passed");
  assert.equal(dirty.candidate_ready, false);
  assert.equal(dirty.publish_ready, false);
});
