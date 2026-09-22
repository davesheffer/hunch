import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyRepository } from "../src/constitution/repository.js";
import { PolicySpecSchema } from "../src/constitution/schema.js";
import { SYMLINK_SKIP } from "./helpers.js";

const NOW = "2026-09-13T00:00:00.000Z";

function policy() {
  return PolicySpecSchema.parse({
    id: "pol_aaaaaaaaaa",
    topic: "test.policy-artifact-safety",
    origin: "generic",
    ir_version: 1,
    revision: 1,
    state: "compiled",
    statement: "A policy artifact stays inside its selected Hunch store.",
    rationale: "",
    scope: { repos: [], paths: [], components: [] },
    assertion: { kind: "exists", subject: { selector: "symbol:thing" } },
    severity: "warning",
    surfaces: ["cli"],
    authority: null,
    activation_gate: null,
    evidence: [],
    proof: null,
    reversal_conditions: [],
    supersedes: null,
    superseded_by: null,
    exception_of: null,
    valid_from: null,
    valid_to: null,
    data_class: "public",
    limitations: [],
    candidate: { alternatives: [], uncertainty: [], conflicts: [], incumbent: null, scope_suggestion: null, counterexamples: [] },
    legacy_refs: [],
    audit: [],
    created_at: NOW,
    updated_at: NOW,
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
  });
}

function repository(root: string): PolicyRepository {
  return new PolicyRepository(root, { privateDir: undefined, unified: false } as never);
}

function writePolicy(root: string): void {
  mkdirSync(join(root, ".hunch", "policies"), { recursive: true });
  writeFileSync(join(root, ".hunch", "policies", "pol_aaaaaaaaaa.json"), JSON.stringify(policy()));
}

test("policy reads refuse a symlinked kind directory without reading its target", { skip: SYMLINK_SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-policy-kind-link-"));
  const outside = mkdtempSync(join(tmpdir(), "hunch-policy-kind-target-"));
  try {
    mkdirSync(join(root, ".hunch"));
    writePolicy(outside);
    symlinkSync(join(outside, ".hunch", "policies"), join(root, ".hunch", "policies"), "dir");
    const repo = repository(root);
    assert.throws(() => repo.listPolicies({ publicOnly: true }), /unsafe store artifact path|symlinks/i);
    assert.throws(() => repo.putPolicy(policy(), { public: true }), /unsafe store artifact path|symlinks/i);
  } finally {
    cleanupDir(root);
    cleanupDir(outside);
  }
});

test("policy writes refuse a symlinked .hunch root without mutating its target", { skip: SYMLINK_SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-policy-root-link-"));
  const outside = mkdtempSync(join(tmpdir(), "hunch-policy-root-target-"));
  try {
    mkdirSync(join(outside, ".hunch"), { recursive: true });
    symlinkSync(join(outside, ".hunch"), join(root, ".hunch"), "dir");
    assert.throws(() => repository(root).putPolicy(policy(), { public: true }), /unsafe store artifact path|symlinks/i);
    assert.equal(existsSync(join(outside, ".hunch", "policies", "pol_aaaaaaaaaa.json")), false);
  } finally {
    cleanupDir(root);
    cleanupDir(outside);
  }
});

test("policy reads refuse a symlinked record and writes refuse to replace it", { skip: SYMLINK_SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-policy-record-link-"));
  const outside = mkdtempSync(join(tmpdir(), "hunch-policy-record-target-"));
  try {
    mkdirSync(join(root, ".hunch", "policies"), { recursive: true });
    writeFileSync(join(outside, "foreign.json"), JSON.stringify(policy()));
    symlinkSync(join(outside, "foreign.json"), join(root, ".hunch", "policies", "pol_aaaaaaaaaa.json"), "file");
    const repo = repository(root);
    assert.throws(() => repo.listPolicies({ publicOnly: true }), /unsafe store artifact path|symlinks/i);
    assert.throws(() => repo.putPolicy(policy(), { public: true }), /unsafe store artifact path|symlinks/i);
    assert.equal(readFileSync(join(outside, "foreign.json"), "utf8"), JSON.stringify(policy()));
  } finally {
    cleanupDir(root);
    cleanupDir(outside);
  }
});

test("policy reads and writes refuse a hard-linked record", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-policy-record-hardlink-"));
  const outside = mkdtempSync(join(tmpdir(), "hunch-policy-record-hardlink-target-"));
  try {
    mkdirSync(join(root, ".hunch", "policies"), { recursive: true });
    const target = join(outside, "foreign.json");
    const original = JSON.stringify(policy());
    writeFileSync(target, original);
    linkSync(target, join(root, ".hunch", "policies", "pol_aaaaaaaaaa.json"));
    const repo = repository(root);
    assert.throws(() => repo.listPolicies({ publicOnly: true }), /unsafe store artifact path|hard links/i);
    assert.throws(() => repo.putPolicy(policy(), { public: true }), /unsafe store artifact path|hard links/i);
    assert.equal(readFileSync(target, "utf8"), original);
  } finally {
    cleanupDir(root);
    cleanupDir(outside);
  }
});

test("missing policy artifact collections remain empty and malformed records remain visible", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-policy-empty-"));
  try {
    mkdirSync(join(root, ".hunch"), { recursive: true });
    const repo = repository(root);
    assert.deepEqual(repo.listPolicies({ publicOnly: true }), []);
    mkdirSync(join(root, ".hunch", "policies"));
    writeFileSync(join(root, ".hunch", "policies", "broken.json"), "not-json");
    assert.throws(() => repo.listPolicies({ publicOnly: true }), /invalid policies\/broken\.json/i);
  } finally {
    cleanupDir(root);
  }
});

test("policy writes reject artifacts larger than the bounded read size before publication", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-policy-oversize-"));
  try {
    const oversized = { ...policy(), rationale: "x".repeat(9 * 1024 * 1024) };
    assert.throws(
      () => repository(root).putPolicy(oversized, { public: true }),
      /policy artifact exceeds the 8388608-byte limit/i,
    );
    assert.equal(existsSync(join(root, ".hunch", "policies", "pol_aaaaaaaaaa.json")), false);
  } finally {
    cleanupDir(root);
  }
});
