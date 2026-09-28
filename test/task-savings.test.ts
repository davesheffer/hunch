import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBenchmarkReport, DIET_MECHANISM_EVENTS, median, renderBenchmarkMarkdown, summarizeMetric, type BenchmarkReport,
} from "../src/core/taskSavings.js";
import type { BenchmarkArm, BenchmarkSuite, EfficiencyRun, SuiteTask, TaskCost } from "../src/benchmark/types.js";

const task = (id: string, category: SuiteTask["category"], relevance: SuiteTask["memory"]["relevance_expected"] = "relevant",
  eligible: string[] = []): SuiteTask => ({
  id, issue_number: 1, category, prompt: `prompt ${id}`, starting_commit: "abc",
  memory: { cutoff_at: "2026-09-01T00:00:00Z", eligible_record_ids: eligible, relevance_expected: relevance },
  validator: { file: `${id}.test.ts`, sha256: "0".repeat(64) },
});

const suite: BenchmarkSuite = {
  schema: "hunch.context-efficiency-suite/1", id: "pilot5", kind: "retrospective", timeout_ms: 1000, validator_timeout_ms: 1000,
  tasks: [
    task("t-cont", "continuation", "relevant", ["dec_aaaaaaaaaa", "con_bbbbbbbbbb"]),
    task("t-bug", "repeated-bug", "relevant", ["bug_cccccccccc"]),
    task("t-conv", "convention", "unknown"),
    task("t-self", "self-contained", "abstain", ["fnd_dddddddddd"]),
  ],
};

const cost = (over: Partial<TaskCost> = {}): TaskCost => ({
  input_tokens: 1000, output_tokens: 100, token_measurement: "provider", input_token_parts: null,
  hunch_context_estimated_tokens: 0, memory_processing_tokens: null, model_calls: 5, tool_calls: 10, investigation_tool_calls: 6,
  call_measurement: "parsed", agent_wall_clock_ms: 1000, validation_ms: 100, total_wall_clock_ms: 1100, ...over,
});

const run = (task_id: string, arm: BenchmarkArm, run_index: number, costOver: Partial<TaskCost> = {},
  over: Partial<EfficiencyRun> = {}): EfficiencyRun => ({
  schema: "hunch.context-efficiency-run/1", task_id, arm, run_index, suite_hash: "s", harness_revision: "h",
  audited_hunch_revision: null, arm_order_seed: "seed", manifest_sha256: "m", repository_revision: "r", memory_revision: null,
  runner: { provider: "claude", cli_version: "1", sanitized_argv_hash: "x", model_identity: null, model_identity_source: "unknown" },
  cache_state: "cold", evidence_kind: "product", success: true, status: "completed",
  quality: { outcome: "passed", validator_id: "v" }, cost: cost(costOver), replay_packet_id: null,
  selected_memory_ids: [], delivered_eligible_ids: [], isolation_evidence: [], validation_evidence: [], ...over,
});

const opts = { baseline: "no-hunch" as const, treatment: "current-hunch" as const, manifest_sha256: "f".repeat(64), generated_at: "2026-09-27T00:00:00Z" };
const build = (runs: EfficiencyRun[]) => buildBenchmarkReport(suite, runs, opts);
const metric = (report: BenchmarkReport, name: string) => report.comparison.overall.metrics.find((m) => m.metric === name)!;

test("median handles odd, even and empty input", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.deepEqual(summarizeMetric([], "total_wall_clock_ms"), { n: 0, median: null, min: null, max: null, values: [] });
});

test("invalid runs are excluded from every aggregate but kept as observations", () => {
  const runs = [
    run("t-cont", "no-hunch", 0, { total_wall_clock_ms: 100 }),
    run("t-cont", "no-hunch", 1, { total_wall_clock_ms: 300 }),
    run("t-cont", "no-hunch", 2, { total_wall_clock_ms: 999_999 }, { status: "invalid_exposure", success: false }),
    run("t-cont", "current-hunch", 0, { total_wall_clock_ms: 50 }, { status: "isolation_breach", success: false }),
    run("t-cont", "current-hunch", 1, { total_wall_clock_ms: 200 }, { status: "timed_out", success: false }),
  ];
  assert.deepEqual(summarizeMetric(runs.filter((r) => r.arm === "no-hunch"), "total_wall_clock_ms").values, [100, 300]);
  const report = build(runs);
  assert.equal(report.observations.length, 5);
  const excluded = report.observations.filter((o) => o.excluded_reason !== null);
  assert.deepEqual(excluded.map((o) => [o.arm, o.run_index, o.status]), [["current-hunch", 0, "isolation_breach"], ["no-hunch", 2, "invalid_exposure"]]);
  const noHunch = report.per_arm.find((a) => a.arm === "no-hunch")!;
  assert.deepEqual([noHunch.runs, noHunch.valid_runs, noHunch.excluded_runs, noHunch.success_rate], [3, 2, 1, 1]);
  assert.deepEqual(noHunch.metrics.total_wall_clock_ms, { n: 2, median: 200, min: 100, max: 300, values: [100, 300] });
  const hunch = report.per_arm.find((a) => a.arm === "current-hunch")!;
  assert.deepEqual([hunch.valid_runs, hunch.success_rate, hunch.metrics.total_wall_clock_ms.median], [1, 0, 200]);
  assert.equal(report.comparison.overall.success_rate_delta_points, -100);
  assert.deepEqual(report.sample, { tasks: 4, runs: 5, valid_runs: 3, excluded_runs: 2 });
});

test("token pct is withheld when one side is estimated and computed when both are provider", () => {
  const mixed = build([
    run("t-cont", "no-hunch", 0, { input_tokens: 1000, total_wall_clock_ms: 1000 }),
    run("t-cont", "current-hunch", 0, { input_tokens: 800, total_wall_clock_ms: 900 }),
    run("t-cont", "current-hunch", 1, { input_tokens: 700, token_measurement: "estimate", total_wall_clock_ms: 900 }),
  ]);
  const input = metric(mixed, "input_tokens");
  assert.equal(input.pct_change, null);
  assert.equal(input.pct_reason, "token measurement not provider on both sides");
  assert.equal(input.delta_median, null, "a withheld token pct prints no delta either");
  assert.equal(input.treatment_median, 800, "estimated tokens never enter the median");
  assert.equal(metric(mixed, "total_wall_clock_ms").pct_change, -10);

  const provider = build([
    run("t-cont", "no-hunch", 0, { input_tokens: 1000 }),
    run("t-cont", "current-hunch", 0, { input_tokens: 800, hunch_context_estimated_tokens: 500 }),
  ]);
  const both = metric(provider, "input_tokens");
  assert.deepEqual([both.delta_median, both.pct_change, both.pct_reason], [-200, -20, null]);
  assert.equal(provider.per_arm.find((a) => a.arm === "current-hunch")!.metrics.input_tokens.median, 800, "estimate not added");
});

test("pct is withheld when the baseline median is 0 or there is no data", () => {
  const report = build([
    run("t-cont", "no-hunch", 0, { investigation_tool_calls: 0 }),
    run("t-cont", "current-hunch", 0, { investigation_tool_calls: 3, model_calls: null }),
  ]);
  const inv = metric(report, "investigation_tool_calls");
  assert.deepEqual([inv.delta_median, inv.pct_change, inv.pct_reason], [3, null, "baseline median is 0"]);
  assert.equal(metric(report, "model_calls").pct_reason, "no data");
  assert.match(renderBenchmarkMarkdown(report), /n\/a \(baseline median is 0\)/);
});

test("fixture evidence is flagged in the report and on the first Markdown line", () => {
  const product = build([run("t-cont", "no-hunch", 0), run("t-cont", "current-hunch", 0)]);
  assert.equal(product.evidence, "product");
  assert.doesNotMatch(renderBenchmarkMarkdown(product).split("\n")[0]!, /fixture/i);
  const fixture = build([run("t-cont", "no-hunch", 0), run("t-cont", "current-hunch", 0, {}, { evidence_kind: "fixture" })]);
  assert.equal(fixture.evidence, "fixture");
  const first = renderBenchmarkMarkdown(fixture).split("\n")[0]!;
  assert.match(first, /fixture evidence/i);
  assert.match(first, /not product evidence/i);
});

test("criterion 3 uses only continuation and repeated-bug tasks; abstention is not computed", () => {
  // Convention tasks get much faster with Hunch; continuation and repeated-bug get slower and costlier.
  const slowerWhereItCounts = [
    run("t-cont", "no-hunch", 0, { total_wall_clock_ms: 1000, input_tokens: 1000 }),
    run("t-cont", "current-hunch", 0, { total_wall_clock_ms: 1200, input_tokens: 1100 }),
    run("t-bug", "no-hunch", 0, { total_wall_clock_ms: 1000, input_tokens: 1000 }),
    run("t-bug", "current-hunch", 0, { total_wall_clock_ms: 1300, input_tokens: 1200 }),
    ...[0, 1, 2].flatMap((i) => [
      run("t-conv", "no-hunch", i, { total_wall_clock_ms: 9000, input_tokens: 9000 }),
      run("t-conv", "current-hunch", i, { total_wall_clock_ms: 100, input_tokens: 100 }),
    ]),
    run("t-self", "current-hunch", 0, { hunch_context_estimated_tokens: 42 }, { delivered_eligible_ids: ["fnd_dddddddddd"] }),
  ];
  const report = build(slowerWhereItCounts);
  assert.ok(metric(report, "total_wall_clock_ms").delta_median! < 0, "overall median is lower with Hunch");
  assert.equal(report.criteria.movement.pass, false);
  assert.deepEqual(report.criteria.movement.categories, ["continuation", "repeated-bug"]);
  assert.deepEqual([report.criteria.movement.time.lower, report.criteria.movement.input_tokens.lower], [false, false]);
  assert.equal(report.criteria.indicative, true);
  assert.equal(report.criteria.task_count, 4);
  assert.deepEqual(report.criteria.abstention, {
    computed: false,
    reason: "no preregistered abstention measure; see delivered records on abstain-labeled tasks",
    tasks: [{ task_id: "t-self", runs: [{ run_index: 0, status: "completed", hunch_context_estimated_tokens: 42, delivered_eligible_ids: ["fnd_dddddddddd"] }] }],
  });
  assert.deepEqual(report.delivery.find((d) => d.task_id === "t-self")!.records, [{ id: "fnd_dddddddddd", delivered_runs: 1 }]);

  const faster = build(slowerWhereItCounts.map((r) => (r.task_id === "t-cont" && r.arm === "current-hunch"
    ? run("t-cont", "current-hunch", 0, { total_wall_clock_ms: 500, input_tokens: 1100 }) : r)));
  assert.equal(faster.criteria.movement.time.lower, true);
  assert.equal(faster.criteria.movement.pass, true);
});

test("same input yields identical JSON and Markdown regardless of run order", () => {
  const runs = [
    run("t-bug", "current-hunch", 1, { total_wall_clock_ms: 700 }, { delivered_eligible_ids: ["bug_cccccccccc"] }),
    run("t-cont", "no-hunch", 1, { total_wall_clock_ms: 900 }),
    run("t-cont", "current-hunch", 0, { total_wall_clock_ms: 800, token_measurement: "estimate" }, { delivered_eligible_ids: ["dec_aaaaaaaaaa"] }),
    run("t-bug", "no-hunch", 0, { total_wall_clock_ms: 950 }, { success: false }),
    run("t-cont", "no-hunch", 0, { total_wall_clock_ms: 1000 }, { status: "invalid_exposure" }),
  ];
  const first = build(runs);
  const second = build([...runs].reverse());
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(renderBenchmarkMarkdown(first), renderBenchmarkMarkdown(second));
  assert.deepEqual(first.observations.map((o) => `${o.task_id}/${o.run_index}/${o.arm}`),
    ["t-cont/0/current-hunch", "t-cont/0/no-hunch", "t-cont/1/no-hunch", "t-bug/0/no-hunch", "t-bug/1/current-hunch"]);
  const markdown = renderBenchmarkMarkdown(first);
  assert.match(markdown, /- Sample size: 4 tasks, 5 runs \(4 valid, 1 excluded\)\./);
  assert.match(markdown, /Existing-Hunch criteria \(indicative: 4 tasks\)/);
});

test("runs for tasks outside the suite are refused", () => {
  assert.throws(() => build([run("t-unknown", "no-hunch", 0)]), /not in suite pilot5/);
});

const hooks = (pre: number, post: number, other = 5000) => ({
  by_event: {
    PreToolUse: { injections: 1, chars: pre }, PostToolUse: { injections: 1, chars: post }, SessionStart: { injections: 1, chars: other },
  },
  total: { injections: 3, chars: pre + post + other },
});
/** Two paired tasks (t-cont, t-bug), one run per arm each; t-conv has only a valid current-hunch run and must not count. */
const dietRuns = (diet: Partial<TaskCost> = {}, dietOver: Partial<EfficiencyRun> = {}, bugDietOver: Partial<EfficiencyRun> = {}) => [
  run("t-cont", "no-hunch", 1, { input_tokens: 2000, main_model_calls: 20 }),
  run("t-bug", "no-hunch", 1, { input_tokens: 2000, main_model_calls: 20 }),
  run("t-cont", "current-hunch", 1, { input_tokens: 1000, main_model_calls: 10, hook_injections: hooks(1000, 1000) }),
  run("t-bug", "current-hunch", 1, { input_tokens: 1000, main_model_calls: 10, hook_injections: hooks(1000, 1000) }),
  run("t-conv", "current-hunch", 1, { input_tokens: 1, main_model_calls: 1, hook_injections: hooks(1, 1, 1) }),
  run("t-conv", "diet-hunch", 1, { input_tokens: 1, main_model_calls: 1, hook_injections: hooks(1, 1, 1) }, { status: "invalid_exposure" }),
  run("t-cont", "diet-hunch", 1, { input_tokens: 800, main_model_calls: 8, hook_injections: hooks(400, 500), ...diet }, dietOver),
  run("t-bug", "diet-hunch", 1, { input_tokens: 800, main_model_calls: 8, hook_injections: hooks(400, 500), ...diet }, { ...dietOver, ...bugDietOver }),
];
const threeArm = { ...opts, extra_treatments: ["diet-hunch" as const] };
const dietReport = (...args: Parameters<typeof dietRuns>) => buildBenchmarkReport(suite, dietRuns(...args), threeArm).diet_vs_current!;

test("three arms: each Hunch arm gets the pairwise comparison vs no-hunch; two-arm reports gain no keys", () => {
  const report = buildBenchmarkReport(suite, dietRuns(), threeArm);
  assert.deepEqual(report.arms, { baseline: "no-hunch", treatment: "current-hunch" });
  assert.deepEqual(report.additional_pairs!.map((p) => p.arms), [{ baseline: "no-hunch", treatment: "diet-hunch" }]);
  assert.equal(report.additional_pairs![0]!.criteria.investigation.treatment_median, 6);
  assert.deepEqual(report.per_arm.map((a) => a.arm), ["current-hunch", "diet-hunch", "no-hunch"]);
  const markdown = renderBenchmarkMarkdown(report);
  assert.match(markdown, /^# Context-efficiency pilot report: current-hunch vs no-hunch, diet-hunch vs no-hunch$/m);
  assert.match(markdown, /## Comparison: current-hunch vs no-hunch \(medians\)/);
  assert.match(markdown, /## Comparison: diet-hunch vs no-hunch \(medians\)/);
  assert.match(markdown, /## Existing-Hunch criteria: diet-hunch vs no-hunch \(indicative: 4 tasks\)/);
  assert.match(markdown, /## Delivery \(diet-hunch, valid runs\)/);
  assert.match(markdown, /## diet-hunch vs current-hunch \(indicative: 2 tasks with valid runs in both arms\)/);

  const two = build(dietRuns().filter((r) => r.arm !== "diet-hunch"));
  assert.ok(!("additional_pairs" in two) && !("diet_vs_current" in two));
  assert.match(renderBenchmarkMarkdown(two), /^# Context-efficiency pilot report: current-hunch vs no-hunch$/m);
  assert.match(renderBenchmarkMarkdown(two), /## Existing-Hunch criteria \(indicative: 4 tasks\)/);
  assert.doesNotMatch(renderBenchmarkMarkdown(two), /diet/);
  // Two arms current-hunch,diet-hunch: the pairwise report plus the diet-vs-current section.
  const pairOnly = buildBenchmarkReport(suite, dietRuns(), { ...opts, baseline: "current-hunch", treatment: "diet-hunch" });
  assert.ok(pairOnly.diet_vs_current && !("additional_pairs" in pairOnly));
  assert.throws(() => buildBenchmarkReport(suite, [], { ...opts, extra_treatments: ["no-hunch"] }), /must differ/);
});

test("diet-hunch vs current-hunch passes on paired tasks only: mechanism, quality, tokens and steps", () => {
  const d = dietReport();
  assert.deepEqual(d.tasks, ["t-cont", "t-bug"], "t-conv has no valid diet-hunch run");
  assert.deepEqual([d.current_valid_runs, d.diet_valid_runs], [2, 2]);
  assert.deepEqual(d.quality, { current_success_rate: 1, diet_success_rate: 1, difference_points: 0, threshold_points: 5 });
  assert.deepEqual(d.input_tokens, { current_median: 1000, diet_median: 800, reason: null });
  assert.deepEqual(d.main_model_calls, { current_median: 10, diet_median: 8 });
  assert.deepEqual(d.hook_chars_total, { current_median: 7000, diet_median: 5900 });
  assert.deepEqual(d.hook_chars_mechanism, { current_median: 2000, diet_median: 900, events: ["PreToolUse", "PostToolUse"] });
  assert.deepEqual(d.mechanism, { pass: true, max_ratio: 0.5 });
  assert.deepEqual(d.improvement, { pass: true, mechanism: true, quality: true, input_tokens_lower: true, main_model_calls_lower: true });
  assert.deepEqual([...DIET_MECHANISM_EVENTS], ["PreToolUse", "PostToolUse"]);
  assert.equal(dietReport({ hook_injections: hooks(500, 500) }).mechanism.pass, true, "exactly half passes");
  const markdown = renderBenchmarkMarkdown(buildBenchmarkReport(suite, dietRuns(), threeArm));
  assert.match(markdown, /1\. Mechanism: median PreToolUse\+PostToolUse hook chars <= 50% of current-hunch's: PASS \(2000 -> 900\)/);
  assert.match(markdown, /2\. Improvement: .*: PASS \(mechanism PASS; quality PASS, 0 points; input tokens PASS; main-agent steps PASS\)/);
});

test("diet-hunch improvement fails on each condition and is undetermined without data", () => {
  const mechanism = dietReport({ hook_injections: hooks(600, 500) });
  assert.equal(mechanism.mechanism.pass, false, "1100 > 50% of 2000");
  assert.deepEqual(mechanism.improvement, { pass: false, mechanism: false, quality: true, input_tokens_lower: true, main_model_calls_lower: true });

  const quality = dietReport({}, {}, { success: false, quality: { outcome: "failed", validator_id: "v" } });
  assert.equal(quality.quality.difference_points, -50);
  assert.deepEqual(quality.improvement, { pass: false, mechanism: true, quality: false, input_tokens_lower: true, main_model_calls_lower: true });

  const tokens = dietReport({ input_tokens: 1000 });
  assert.deepEqual(tokens.improvement, { pass: false, mechanism: true, quality: true, input_tokens_lower: false, main_model_calls_lower: true });

  const steps = dietReport({ main_model_calls: 10 });
  assert.deepEqual(steps.improvement, { pass: false, mechanism: true, quality: true, input_tokens_lower: true, main_model_calls_lower: false });

  const estimated = dietReport({ token_measurement: "estimate" });
  assert.equal(estimated.input_tokens.reason, "token measurement not provider on both sides");
  assert.deepEqual(estimated.improvement, { pass: null, mechanism: true, quality: true, input_tokens_lower: null, main_model_calls_lower: true });
  assert.equal(dietReport({ token_measurement: "estimate", main_model_calls: 10 }).improvement.pass, false, "a failure outranks an undetermined condition");

  const noHookData = dietReport({ hook_injections: undefined });
  assert.equal(noHookData.hook_chars_mechanism.diet_median, null, "run.json from before hook_injections existed");
  assert.equal(noHookData.mechanism.pass, null);
  assert.equal(noHookData.improvement.pass, null);
  assert.match(renderBenchmarkMarkdown(buildBenchmarkReport(suite, dietRuns({ hook_injections: undefined }), threeArm)), /1\. Mechanism: .*: UNDETERMINED/);

  // No PreToolUse/PostToolUse injections in either arm: the diet was not exercised, so undetermined, not a pass.
  const unexercised = dietRuns({ hook_injections: hooks(0, 0) })
    .map((r) => (r.arm === "current-hunch" ? { ...r, cost: { ...r.cost, hook_injections: hooks(0, 0) } } : r));
  const zero = buildBenchmarkReport(suite, unexercised, threeArm).diet_vs_current!;
  assert.deepEqual([zero.hook_chars_mechanism.current_median, zero.hook_chars_mechanism.diet_median], [0, 0]);
  assert.equal(zero.mechanism.pass, null);
  assert.deepEqual(zero.improvement, { pass: null, mechanism: null, quality: true, input_tokens_lower: true, main_model_calls_lower: true });
});
