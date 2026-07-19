import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_MATRIX_COMMIT,
  LEGACY_MATRIX_TAG,
  LEGACY_MATRIX_TARBALL,
  MATRIX_PERFORMANCE_LIMITS,
  MATRIX_RELEASE_SCHEMA,
  assertDependencyLockProjection,
  assertLegacyMatrixTarball,
  buildMatrixReceipt,
  expectedInstalledDependencyPackages,
  installedDependencyProjection,
  parseMatrixReleaseArgs,
  verifyMatrixReceipt,
} from "../tooling/matrix-release-verification.mjs";

function passingEvidence() {
  return {
    source: {
      candidate_commit: "c".repeat(40),
      candidate_clean: true,
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
      candidate: {
        version: "1.9.0",
        sha256: `sha256:${"2".repeat(64)}`,
        install_mode: "isolated_tarball",
      },
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
      actors: 6,
      rounds: 3,
      unique_writes_expected: 18,
      unique_writes_observed: 18,
      collision_writers: 6,
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
      soak_ms: 6_000,
      total_ms: 9_000,
      soak_write_ops: 24,
      soak_write_ops_per_second: 4,
      limits: MATRIX_PERFORMANCE_LIMITS,
    },
  } as const;
}

test("Matrix release receipt is fail-closed, content-addressed, and binds the pinned npm-latest baseline", () => {
  assert.equal(MATRIX_RELEASE_SCHEMA, "hunch.matrix.release.v1");
  assert.equal(LEGACY_MATRIX_TAG, "v1.8.3");
  assert.equal(LEGACY_MATRIX_COMMIT, "abf2b40f1d67076e2526000f9336b792add06983");
  assert.deepEqual(LEGACY_MATRIX_TARBALL, {
    sha256: "sha256:c781eaa71db40d4f4ea03de4272f794d62e470917bfe29f687e7fea557ddebb9",
    shasum: "7d01e409aa1a6533a9d1bae0c63ecd2377def410",
    integrity: "sha512-ZNC6n84g+DFmTx/3YBz7ZzeLETvqB7gr0z9PJtQXMdOv3lbXaiWZ2Od+K3j5WdjQqPF6UF/rGWfaKddLH8d+Lw==",
  }, "the offline downgrade lane is pinned to the exact public npm package bytes");
  assert.deepEqual(MATRIX_PERFORMANCE_LIMITS, {
    compatibility_ms: 240_000,
    crash_recovery_ms: 240_000,
    soak_ms: 900_000,
    total_ms: 1_200_000,
  });
  assert.equal(Object.isFrozen(MATRIX_PERFORMANCE_LIMITS), true,
    "the release deadline cannot be mutated by a caller");

  const receipt = buildMatrixReceipt(passingEvidence());
  assert.equal(receipt.result, "passed");
  assert.equal(receipt.release_ready, true);
  assert.equal(verifyMatrixReceipt(receipt), true);
  assert.match(receipt.content_hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(buildMatrixReceipt(passingEvidence()), receipt,
    "identical deterministic evidence must produce an identical receipt");

  assert.equal(verifyMatrixReceipt({
    ...receipt,
    soak: { ...receipt.soak, unique_writes_observed: 17 },
  }), false, "a dropped concurrent write invalidates the receipt");
  assert.equal(verifyMatrixReceipt({
    ...receipt,
    crash_recovery: { ...receipt.crash_recovery, interrupted_record_recovered: false },
  }), false, "an unrecovered crash write invalidates the receipt");
  assert.equal(verifyMatrixReceipt({
    ...receipt,
    source: { ...receipt.source, legacy_commit: "f".repeat(40) },
  }), false, "a moved or replaced legacy tag invalidates the receipt");
  assert.equal(verifyMatrixReceipt({
    ...receipt,
    packages: { ...receipt.packages, candidate: { ...receipt.packages.candidate, version: "1.8.3" } },
  }), false, "the candidate must be newer than the compatibility baseline");
  assert.equal(verifyMatrixReceipt({
    ...receipt,
    privacy: { ...receipt.privacy, sentinel_in_code_history: true },
  }), false, "a public-code leak invalidates the receipt");
  assert.equal(verifyMatrixReceipt({
    ...receipt,
    compatibility: { ...receipt.compatibility, legacy_reproof_activation_refused: false },
  }), false, "a legacy client that can re-prove and activate current policy semantics invalidates the receipt");
  assert.equal(verifyMatrixReceipt({
    ...receipt,
    performance: { ...receipt.performance, total_ms: MATRIX_PERFORMANCE_LIMITS.total_ms + 1 },
  }), false, "a Matrix run beyond the hard release deadline invalidates the receipt");
  assert.equal(verifyMatrixReceipt({
    ...receipt,
    performance: { ...receipt.performance, soak_write_ops_per_second: 4.001 },
  }), false, "invented throughput invalidates the receipt");
});

test("every safety claim is required independently and authentic failed receipts stay inspectable", () => {
  const expectedTrue = {
    compatibility: [
      "candidate_record_read_by_legacy",
      "candidate_record_bytes_preserved_by_legacy_write",
      "legacy_record_read_after_upgrade",
      "upgrade_record_published",
      "candidate_policy_bytes_preserved_by_legacy_write",
      "candidate_policy_origin_preserved_by_legacy_write",
      "candidate_policy_activation_gate_preserved_by_legacy_write",
      "candidate_policy_state_preserved_by_legacy_attack",
      "candidate_policy_authority_preserved_by_legacy_attack",
      "attack_clone_policy_bytes_preserved",
      "attack_clone_policy_state_preserved",
      "attack_clone_policy_authority_preserved",
      "legacy_current_proof_approval_refused",
      "legacy_reproof_activation_refused",
    ],
    crash_recovery: [
      "injected",
      "commit_seam_reached",
      "process_killed",
      "dead_owner_lock_reclaimed",
      "interrupted_record_recovered",
      "recovery_record_published",
      "overlay_operationally_clean",
      "overlay_memory_tree_clean",
      "only_expected_clone_local_capabilities_untracked",
    ],
    soak: [
      "all_commands_succeeded",
      "all_clones_converged",
      "all_overlays_clean",
      "all_overlay_memory_trees_clean",
      "only_expected_clone_local_capabilities_untracked",
      "one_canonical_remote_branch",
    ],
    isolation: [
      "guarded_network_surfaces_disabled",
      "node_network_guard_verified",
      "git_protocols_limited_to_file",
      "npm_offline",
      "dependency_lock_equivalent",
    ],
  } as const;

  for (const [section, fields] of Object.entries(expectedTrue)) {
    for (const field of fields) {
      const evidence: any = structuredClone(passingEvidence());
      evidence[section][field] = false;
      const receipt = buildMatrixReceipt(evidence);
      assert.equal(receipt.result, "failed", `${section}.${field} must be release-blocking`);
      assert.equal(receipt.release_ready, false, `${section}.${field} cannot authorize release`);
      assert.equal(verifyMatrixReceipt(receipt), true,
        `the authentic failed receipt for ${section}.${field} must remain verifiable`);
    }
  }

  for (const [section, field] of [
    ["privacy", "sentinel_in_code_history"],
    ["privacy", "private_runtime_artifacts_in_code_remote"],
    ["privacy", "private_runtime_artifacts_in_code_remote_history"],
    ["privacy", "private_runtime_artifacts_in_memory_remote"],
    ["privacy", "private_runtime_artifacts_in_memory_remote_history"],
    ["isolation", "credentials_inherited"],
  ] as const) {
    const evidence: any = structuredClone(passingEvidence());
    evidence[section][field] = true;
    assert.equal(buildMatrixReceipt(evidence).result, "failed", `${section}.${field} must remain false`);
  }

  const overclaim: any = structuredClone(passingEvidence());
  overclaim.isolation.external_network_disabled = true;
  assert.equal(buildMatrixReceipt(overclaim).result, "failed",
    "the receipt must reject the unproved blanket external-network claim");
});

test("legacy package bytes and dependency semantics fail closed before installation", () => {
  assert.doesNotThrow(() => assertLegacyMatrixTarball(LEGACY_MATRIX_TARBALL));

  for (const [field, replacement] of [
    ["sha256", `sha256:${"0".repeat(64)}`],
    ["shasum", "0".repeat(40)],
    ["integrity", `sha512-${Buffer.alloc(64).toString("base64")}`],
  ] as const) {
    assert.throws(
      () => assertLegacyMatrixTarball({ ...LEGACY_MATRIX_TARBALL, [field]: replacement }),
      new RegExp(`legacy npm tarball ${field} mismatch`),
      `a rebuilt legacy package with a different ${field} must be rejected`,
    );

    const evidence: any = structuredClone(passingEvidence());
    evidence.packages.legacy[field] = replacement;
    assert.equal(buildMatrixReceipt(evidence).result, "failed",
      `a receipt with a different legacy ${field} must not authorize release`);
  }

  const legacyProjection = {
    lockfileVersion: 3,
    packages: { "node_modules/example": { version: "1.0.0" } },
  };
  const matchingProjection = assertDependencyLockProjection(legacyProjection, {
    packages: { "node_modules/example": { version: "1.0.0" } },
    lockfileVersion: 3,
  });
  assert.equal(matchingProjection.equivalent, true);
  assert.match(matchingProjection.hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(
    matchingProjection,
    assertDependencyLockProjection(legacyProjection, structuredClone(legacyProjection)),
    "object key order must not create false lock drift",
  );
  assert.throws(
    () => assertDependencyLockProjection(legacyProjection, {
      ...legacyProjection,
      packages: { "node_modules/example": { version: "2.0.0" } },
    }),
    /dependency lock projection drift/,
    "dependency drift between the legacy and candidate sources must fail closed",
  );
});

test("installed dependency proof excludes only incompatible optional platform packages", () => {
  const required = { version: "1.0.0" };
  const compatibleOptional = {
    version: "1.0.0",
    optional: true,
    os: [process.platform],
    cpu: [process.arch],
  };
  const projected = expectedInstalledDependencyPackages({
    "": { name: "candidate" },
    "node_modules/required": required,
    "node_modules/compatible": compatibleOptional,
    "node_modules/other-os": { version: "1.0.0", optional: true, os: ["hunch-other-os"] },
    "node_modules/excluded-os": { version: "1.0.0", optional: true, os: [`!${process.platform}`] },
    "node_modules/other-cpu": { version: "1.0.0", optional: true, cpu: ["hunch-other-cpu"] },
    "node_modules/required-other-os": { version: "1.0.0", os: ["hunch-other-os"] },
  });

  assert.deepEqual(projected, {
    "node_modules/required": required,
    "node_modules/compatible": compatibleOptional,
    "node_modules/required-other-os": { version: "1.0.0", os: ["hunch-other-os"] },
  });

  const installed = installedDependencyProjection(process.cwd());
  assert.deepEqual(installed.installed, installed.expected,
    "a fresh npm ci tree must match the platform-normalized candidate lock exactly");
});

test("Matrix verifier bounds its scale inputs and keeps dirty runs publish-neutral", () => {
  assert.deepEqual(parseMatrixReleaseArgs(["--actors", "8", "--rounds", "4", "--allow-dirty"]), {
    actors: 8,
    rounds: 4,
    output: ".hunch-cache/release/matrix-release.json",
    allowDirty: true,
    keepTemp: false,
    help: false,
  });
  assert.throws(() => parseMatrixReleaseArgs(["--actors", "2"]), /--actors must be between 3 and 20/);
  assert.throws(() => parseMatrixReleaseArgs(["--rounds", "11"]), /--rounds must be between 1 and 10/);
  assert.throws(() => parseMatrixReleaseArgs(["--unknown"]), /unknown Matrix verifier argument/);
  assert.throws(() => parseMatrixReleaseArgs(["--legacy-tag", "v1.8.5"]), /must be supplied together/);
  assert.throws(() => parseMatrixReleaseArgs([
    "--legacy-tag", "v1.8.5", "--legacy-commit", "short",
  ]), /full hexadecimal object id/);
  assert.throws(() => parseMatrixReleaseArgs([
    "--legacy-tag", "v1.8.5", "--legacy-commit", "A".repeat(40),
  ]), /requires --legacy-sha256, --legacy-shasum, and --legacy-integrity/);
  assert.deepEqual(parseMatrixReleaseArgs([
    "--legacy-tag", "v1.8.5",
    "--legacy-commit", "A".repeat(40),
    "--legacy-sha256", `sha256:${"4".repeat(64)}`,
    "--legacy-shasum", "5".repeat(40),
    "--legacy-integrity", `sha512-${Buffer.alloc(64, 6).toString("base64")}`,
  ]), {
    actors: 8,
    rounds: 4,
    output: ".hunch-cache/release/matrix-release.json",
    allowDirty: false,
    keepTemp: false,
    help: false,
    legacyTag: "v1.8.5",
    legacyCommit: "a".repeat(40),
    legacySha256: `sha256:${"4".repeat(64)}`,
    legacyShasum: "5".repeat(40),
    legacyIntegrity: `sha512-${Buffer.alloc(64, 6).toString("base64")}`,
  });

  const dirty = buildMatrixReceipt({
    ...passingEvidence(),
    source: { ...passingEvidence().source, candidate_clean: false },
  });
  assert.equal(dirty.result, "passed", "behavioral evidence remains inspectable during development");
  assert.equal(dirty.release_ready, false, "dirty source can never authorize a release");
  assert.equal(verifyMatrixReceipt(dirty), true);

  const alternateEvidence = {
    ...passingEvidence(),
    source: {
      ...passingEvidence().source,
      legacy_tag: "v1.8.5",
      legacy_commit: "a".repeat(40),
    },
    packages: {
      ...passingEvidence().packages,
      legacy: {
        ...passingEvidence().packages.legacy,
        version: "1.8.5",
        sha256: `sha256:${"4".repeat(64)}`,
        shasum: "5".repeat(40),
        integrity: `sha512-${Buffer.alloc(64, 6).toString("base64")}`,
      },
    },
  };
  const alternateOptions = {
    legacyTag: "v1.8.5",
    legacyCommit: "a".repeat(40),
    legacySha256: `sha256:${"4".repeat(64)}`,
    legacyShasum: "5".repeat(40),
    legacyIntegrity: `sha512-${Buffer.alloc(64, 6).toString("base64")}`,
  };
  const alternate = buildMatrixReceipt(alternateEvidence, alternateOptions);
  assert.equal(alternate.result, "passed");
  assert.equal(verifyMatrixReceipt(alternate), false,
    "a non-default rollback receipt requires the caller's exact expected baseline");
  assert.equal(verifyMatrixReceipt(alternate, alternateOptions), true);
});
