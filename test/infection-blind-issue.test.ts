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
  review_learning: {
    source_review: string;
    observed_after_blind_run: boolean;
    counts_as_original_hunch_lift: boolean;
    hunch_constraint_candidates: Array<{
      statement: string;
      source_comment: string;
      scope: string[];
      type: string;
      severity: string;
    }>;
  };
  implementation: {
    commit: string;
    tree: string;
    files: Array<{ path: string; role: string; sha256: string }>;
    pull_request: { number: number; url: string };
    validation: {
      targeted_tests: { tests: number; assertions: number; skipped: number; status: string };
      autoreview: { tests: number; assertions: number; status: string };
      default_unit_suite: { tests: number; assertions: number; skipped: number; status: string };
      integration_suite: { tests: number; assertions: number; skipped: number; status: string };
      mutation: {
        generated: number;
        killed: number;
        escaped: number;
        mutation_code_coverage_percent: number;
        covered_code_msi_percent: number;
      };
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

  assert.equal(result.review_learning.observed_after_blind_run, true);
  assert.equal(result.review_learning.counts_as_original_hunch_lift, false);
  assert.match(result.review_learning.source_review, /pullrequestreview-5059517665$/);
  assert.equal(result.review_learning.hunch_constraint_candidates.length, 4);
  assert.deepEqual(
    result.review_learning.hunch_constraint_candidates.map(({ source_comment }) => source_comment),
    [
      "https://github.com/infection/infection/pull/3524#discussion_r3888020054",
      "https://github.com/infection/infection/pull/3524#discussion_r3888022707",
      "https://github.com/infection/infection/pull/3524#discussion_r3888015207",
      "https://github.com/infection/infection/pull/3524#discussion_r3888012729",
    ],
  );
  assert.deepEqual(
    result.review_learning.hunch_constraint_candidates.map(({ severity }) => severity),
    ["warning", "warning", "advisory", "advisory"],
  );

  assert.equal(result.implementation.commit, "04545fd8bb8e27fa4cfde3f67b4daf4820e5939d");
  assert.equal(result.implementation.tree, "06f85c60a12f524234e25bcc5f5dfde3f6a3b4e4");
  assert.deepEqual(
    result.implementation.files.map(({ path }) => path),
    [
      "src/Command/ConfigureCommand.php",
      "src/FileSystem/Finder/TestFrameworkFinder.php",
      "src/FileSystem/Finder/ComposerBinExecutableFinder.php",
      "tests/phpunit/FileSystem/Finder/TestFrameworkFinderTest.php",
      "tests/phpunit/FileSystem/Finder/ComposerBinExecutableFinderTest.php",
      "devTools/mago-baseline.toml",
    ],
  );
  assert.ok(result.implementation.files.every(({ sha256: hash }) => /^[0-9a-f]{64}$/.test(hash)));
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
  assert.deepEqual(result.implementation.validation.targeted_tests, {
    tests: 20,
    assertions: 42,
    skipped: 0,
    status: "passed",
  });
  assert.deepEqual(result.implementation.validation.autoreview, {
    command: "CI=1 make autoreview",
    tests: 1762,
    assertions: 1722,
    status: "passed",
  });
  assert.deepEqual(result.implementation.validation.default_unit_suite, {
    tests: 4837,
    assertions: 13347,
    skipped: 4,
    status: "passed_with_environment_skips",
  });
  assert.deepEqual(result.implementation.validation.integration_suite, {
    tests: 1950,
    assertions: 3188,
    skipped: 10,
    status: "passed_with_environment_skips",
  });
  assert.equal(result.implementation.validation.mutation.generated, 47);
  assert.equal(result.implementation.validation.mutation.killed, 47);
  assert.equal(result.implementation.validation.mutation.escaped, 0);
  assert.equal(result.implementation.validation.mutation.mutation_code_coverage_percent, 100);
  assert.equal(result.implementation.validation.mutation.covered_code_msi_percent, 100);
  assert.equal(result.implementation.validation.zizmor.status, "passed");
  assert.equal(result.publication.rule_satisfied, true);
  assert.equal(result.publication.marketing_claim_allowed, false);
});
