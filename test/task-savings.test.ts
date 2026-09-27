import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBenchmarkReport, median, renderBenchmarkMarkdown, summarizeMetric, type BenchmarkReport,
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
