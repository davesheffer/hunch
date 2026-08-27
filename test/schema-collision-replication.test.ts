import assert from "node:assert/strict";
import test from "node:test";
import {
  COLLISION_TRAJECTORIES,
  buildCollisionPackets,
  collisionAssignment,
  collisionConditionOrder,
  collisionDryRunSummary,
  loadCollisionFixtures,
  pairedCollisionScore,
  scoreCollisionCondition,
  validateCollisionFixtures,
  type CollisionAnswer,
  type CollisionCondition,
  type CollisionConditionScore,
} from "../bench/external/run-schema-collision-replication.js";

test("targeted fixtures are hash-bound pre-merge snapshots with five later updates", () => {
  const fixtures = loadCollisionFixtures();
  assert.equal(fixtures.length, 6);
  assert.doesNotThrow(() => validateCollisionFixtures(fixtures));
  for (const fixture of fixtures) {
    assert.equal(fixture.updates.length, 5);
    assert.ok(fixture.source_snapshot.includes(`schema_namespace=${fixture.production_schema_namespace}`));
    assert.ok(fixture.source_snapshot.includes(`prototype_schema_namespace=${fixture.prototype_schema_namespace}`));
  }
});

test("eighteen isolated trajectories assign exactly three sessions per case", () => {
  const fixtures = loadCollisionFixtures();
  const assignments = Array.from({ length: COLLISION_TRAJECTORIES }, (_, index) => collisionAssignment(index + 1, fixtures));
  for (const fixture of fixtures) {
    assert.equal(assignments.filter((assignment) => assignment.fixture.case_id === fixture.case_id).length, 3);
  }
  assert.deepEqual(assignments.slice(0, 6).map((assignment) => assignment.caseReplicate), Array(6).fill(1));
  assert.deepEqual(assignments.slice(12).map((assignment) => assignment.caseReplicate), Array(6).fill(3));
});

test("targeted packets preserve baseline/additive separation and authoritative rescue", () => {
  const fixture = loadCollisionFixtures()[0]!;
  const packets = buildCollisionPackets(fixture, "schema_namespace=merged/prototype");
  assert.equal(packets.baseline, `PRE-MERGE MEMORY\n${fixture.source_snapshot}`);
  assert.ok(fixture.updates.every((update) => packets.additive.includes(update)));
  assert.ok(!packets.rewritten.includes(fixture.source_snapshot));
  assert.ok(packets.rescue.includes(`production_schema_namespace=${fixture.production_schema_namespace}`));
  assert.ok(packets.rescue.includes(`prototype_schema_namespace=${fixture.prototype_schema_namespace}`));
});

test("targeted scorer distinguishes exact harm, semantic merge signature, win, and rescue", () => {
  const fixture = loadCollisionFixtures()[0]!;
  const exact: CollisionAnswer = {
    production_schema_namespace: fixture.production_schema_namespace,
    prototype_schema_namespace: fixture.prototype_schema_namespace,
  };
  const merged: CollisionAnswer = {
    production_schema_namespace: `${fixture.production_schema_namespace}/prototype`,
    prototype_schema_namespace: fixture.prototype_schema_namespace,
  };
  const scores = Object.fromEntries([
    ["baseline", scoreCollisionCondition(fixture, "baseline", exact)],
    ["additive", scoreCollisionCondition(fixture, "additive", exact)],
    ["rewritten", scoreCollisionCondition(fixture, "rewritten", merged)],
    ["rescue", scoreCollisionCondition(fixture, "rescue", exact)],
  ]) as Record<CollisionCondition, CollisionConditionScore>;
  assert.equal(scores.rewritten.semantic_merge_signature, true);
  assert.deepEqual(pairedCollisionScore(scores), {
    harm: true,
    win: false,
    rescued_harm: true,
    semantic_merge_harm: true,
  });
});

test("targeted condition order rotates without changing the four arms", () => {
  assert.deepEqual(collisionConditionOrder(1), ["baseline", "additive", "rewritten", "rescue"]);
  assert.deepEqual(collisionConditionOrder(2), ["additive", "rewritten", "rescue", "baseline"]);
  assert.deepEqual(collisionConditionOrder(3), ["rewritten", "rescue", "baseline", "additive"]);
  assert.deepEqual(collisionConditionOrder(4), ["rescue", "baseline", "additive", "rewritten"]);
});

test("targeted dry run plans nine calls per isolated trajectory with no model call", () => {
  const summary = collisionDryRunSummary(7);
  assert.equal(summary.valid, true);
  assert.equal(summary.no_model_calls_made, true);
  assert.equal(summary.protocol_version, 5);
  assert.equal(summary.trajectory_index, 7);
  assert.equal(summary.independent_trajectories, 18);
  assert.equal(summary.planned_calls_per_trajectory, 9);
});
