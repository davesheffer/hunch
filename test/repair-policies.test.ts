import { test } from "node:test";
import assert from "node:assert/strict";
import { planPolicyRepair, repairPolicySpec } from "../src/constitution/repairPolicies.js";
import type { PolicySpec } from "../src/constitution/schema.js";

const NOW = "2026-07-13T12:00:00.000Z";
const P = (over: Partial<PolicySpec> & { id: string }): PolicySpec => ({
  id: over.id, topic: "t", ir_version: 1, revision: 1, state: over.state ?? "proposed",
  statement: `s ${over.id}`, rationale: "", severity: "warning",
  scope: over.scope ?? { repos: [], paths: [], components: [] },
  assertion: over.assertion ?? { kind: "exists", subject: { selector: "symbol:foo" } },
  surfaces: ["cli", "mcp"], authority: null, evidence: [], proof: over.proof ?? null,
  reversal_conditions: [], supersedes: null, superseded_by: null, exception_of: null,
  valid_from: null, valid_to: null, data_class: "public", limitations: [],
  candidate: { alternatives: [], uncertainty: null, scope_suggestion: null },
  legacy_refs: [], audit: over.audit ?? [],
  created_at: NOW, updated_at: NOW,
  provenance: { source: "human_confirmed", confidence: 0.9, evidence: [] },
} as unknown as PolicySpec);

const RENAME = [{ before: "src/store/db.ts", after: "src/store/database.ts" }];

test("planPolicyRepair: exact scope paths and file-qualified symbol selectors heal; globs and bare selectors never", () => {
  const p = P({
    id: "pol_1",
    scope: { repos: [], paths: ["src/store/db.ts", "src/store/**"], components: [] },
    assertion: {
      kind: "not-reaches",
      subject: { selector: "symbol:src/store/db.ts:openDb" },
      relation: { edges: ["imports"], transitive: false, max_depth: 1 },
      object: { selector: "symbol:renderThing" }, // bare — no file identity
    } as never,
  });
  const rewrites = planPolicyRepair(RENAME, [p]);
  assert.equal(rewrites.length, 2);
  const healed = repairPolicySpec(p, rewrites, NOW);
  assert.deepEqual(healed.scope.paths, ["src/store/database.ts", "src/store/**"]);
  assert.equal((healed.assertion as { subject: { selector: string } }).subject.selector, "symbol:src/store/database.ts:openDb");
  assert.equal((healed.assertion as { object: { selector: string } }).object.selector, "symbol:renderThing");
  assert.equal(healed.revision, 2);
  assert.equal(healed.audit.at(-1)!.action, "repaired");
  assert.equal(healed.audit.at(-1)!.actor_kind, "system");
});

test("planPolicyRepair: executable-behavior test pins are NEVER repaired (commit-pinned; needs re-attestation)", () => {
  const p = P({
    id: "pol_b",
    scope: { repos: [], paths: ["src/store/db.ts"], components: [] },
    assertion: {
      kind: "executable-behavior",
      test: { file: "src/store/db.ts", name: "n", source_commit: "a".repeat(40), source_hash: `sha1:${"b".repeat(40)}` },
      runner: "node-test",
      attestation: {
        id: "g2behaviorattest_0123456789", content_hash: `sha1:${"c".repeat(40)}`,
        candidate_id: "g2behavior_0123456789", candidate_hash: `sha1:${"d".repeat(40)}`,
        replay_id: "g2behaviorreplay_012345678", replay_hash: `sha1:${"e".repeat(40)}`,
      },
    } as never,
  });
  const rewrites = planPolicyRepair(RENAME, [p]);
  // the scope path heals; the pinned test file does not
  assert.deepEqual(rewrites.map((r) => r.field), ["scope.paths"]);
  const healed = repairPolicySpec(p, rewrites, NOW);
  assert.equal((healed.assertion as { test: { file: string } }).test.file, "src/store/db.ts");
});

test("planPolicyRepair: superseded/retired/rejected policies keep their history as written", () => {
  for (const state of ["superseded", "retired", "rejected"] as const) {
    const p = P({ id: `pol_${state}`, state, scope: { repos: [], paths: ["src/store/db.ts"], components: [] } });
    assert.equal(planPolicyRepair(RENAME, [p]).length, 0, state);
  }
});

test("repairPolicySpec: untouched policies return the same reference", () => {
  const p = P({ id: "pol_u", scope: { repos: [], paths: ["src/other.ts"], components: [] } });
  assert.equal(repairPolicySpec(p, planPolicyRepair(RENAME, [p]), NOW), p);
});
