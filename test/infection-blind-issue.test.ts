import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(new URL(path, root))).digest("hex");

interface Preregistration {
  schema: string;
  repository: string;
  revision: string;
  issue: { number: number };
  baseline: { expected_owner_files: string[] };
}

interface Result {
  schema: string;
  repository: string;
  revision: string;
  issue: { number: number };
  preregistration: { path: string; commit: string; sha256: string };
  arms: {
    baseline: { expected_owner_files: string[]; owner_file_hits: number };
    hunch: {
      shortlist: { expected_owner_file_hits: number; expected_owner_file_total: number; exact_owner_enabled: boolean };
      combined_owner_file_hits: number;
    };
  };
  comparison: {
    primary: { baseline_hits: number; hunch_shortlist_hits: number; total: number; verdict: string };
    secondary: { changed_plan: boolean; verdict: string };
    overall_verdict: string;
    claim_boundary: string;
  };
  implementation: {
    commit: string;
    pull_request: { number: number; url: string };
    validation: {
      targeted_tests: { status: string };
      autoreview: { status: string };
      default_unit_suite: { status: string };
      mutation: { mutation_code_coverage_percent: number; covered_code_msi_percent: number };
      zizmor: { status: string };
    };
  };
  publication: { rule_satisfied: boolean; marketing_claim_allowed: boolean };
}

const result = readJson("bench/infection/blind-issue-3423-result-v1.json") as Result;
const preregistration = readJson(result.preregistration.path) as Preregistration;

test("the Infection blind issue result stays bound to its frozen baseline and honest verdict", () => {
  assert.equal(result.schema, "hunch.infection-blind-issue-result/1");
  assert.equal(preregistration.schema, "hunch.infection-blind-issue-preregistration/1");
  assert.equal(sha256(result.preregistration.path), result.preregistration.sha256);
  assert.match(result.preregistration.commit, /^[0-9a-f]{40}$/);

  assert.equal(result.repository, preregistration.repository);
  assert.equal(result.revision, preregistration.revision);
  assert.equal(result.issue.number, preregistration.issue.number);
  assert.deepEqual(result.arms.baseline.expected_owner_files, preregistration.baseline.expected_owner_files);

  const expectedOwners = preregistration.baseline.expected_owner_files.length;
  assert.equal(result.arms.baseline.owner_file_hits, expectedOwners);
  assert.equal(result.arms.hunch.shortlist.expected_owner_file_total, expectedOwners);
  assert.ok(result.arms.hunch.shortlist.expected_owner_file_hits < expectedOwners);
  assert.equal(result.arms.hunch.shortlist.exact_owner_enabled, false);
  assert.equal(result.arms.hunch.combined_owner_file_hits, expectedOwners);

  assert.deepEqual(result.comparison.primary, {
    metric: "Both preregistered owner files appear in the bounded shortlist inspection plan.",
    baseline_hits: 2,
    hunch_shortlist_hits: 1,
    total: 2,
    verdict: "failed",
  });
  assert.deepEqual(result.comparison.secondary, {
    metric: "Hunch adds a correct repository-specific constraint, dependency or risk that changes the implementation or validation plan.",
    changed_plan: false,
    verdict: "no_lift",
  });
  assert.equal(result.comparison.overall_verdict, "no_measured_lift_navigation_support_only");
  assert.match(result.comparison.claim_boundary, /not a general accuracy or productivity improvement/);

  assert.match(result.implementation.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(result.implementation.pull_request, {
    number: 3524,
    url: "https://github.com/infection/infection/pull/3524",
    state_at_recording: "open",
    mergeable_at_recording: true,
    upstream_ci_at_recording: "passed",
    upstream_checks: {
      total: 61,
      passed: 61,
      failed: 0,
    },
  });
  assert.equal(result.implementation.validation.targeted_tests.status, "passed");
  assert.equal(result.implementation.validation.autoreview.status, "passed");
  assert.equal(result.implementation.validation.default_unit_suite.status, "passed_with_environment_skips");
  assert.equal(result.implementation.validation.mutation.mutation_code_coverage_percent, 100);
  assert.equal(result.implementation.validation.mutation.covered_code_msi_percent, 100);
  assert.equal(result.implementation.validation.zizmor.status, "passed");
  assert.equal(result.publication.rule_satisfied, true);
  assert.equal(result.publication.marketing_claim_allowed, false);
});
