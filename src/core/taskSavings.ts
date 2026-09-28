// Gate A pilot report for `hunch task benchmark`: pure aggregation, arm comparison and Markdown.
// Pilot statistics are every observation plus median and range; no p95, no means (plan sections 7-9).
import type {
  BenchmarkArm, BenchmarkSuite, CallMeasurement, EfficiencyRun, SuiteTask, TokenMeasurement,
} from "../benchmark/types.js";

export const METRICS = [
  "input_tokens", "output_tokens", "hunch_context_estimated_tokens",
  "model_calls", "tool_calls", "investigation_tool_calls",
  "agent_wall_clock_ms", "validation_ms", "total_wall_clock_ms",
] as const;
export type MetricName = (typeof METRICS)[number];
export type TaskCategory = SuiteTask["category"];
export type RunStatus = EfficiencyRun["status"];

const TOKEN_METRICS: readonly MetricName[] = ["input_tokens", "output_tokens"];
const CALL_METRICS: readonly MetricName[] = ["model_calls", "tool_calls", "investigation_tool_calls"];
const VALID_STATUSES: readonly RunStatus[] = ["completed", "timed_out", "agent_error"];
/** Criterion (3) looks only at these categories. */
export const MOVEMENT_CATEGORIES: readonly TaskCategory[] = ["continuation", "repeated-bug"];
const QUALITY_THRESHOLD_POINTS = 5;
const REASON_TOKENS = "token measurement not provider on both sides";
const REASON_NO_DATA = "no data";
const REASON_BASELINE_ZERO = "baseline median is 0";
const ABSTENTION_REASON = "no preregistered abstention measure; see delivered records on abstain-labeled tasks";

export interface Stat { n: number; median: number | null; min: number | null; max: number | null; values: number[] }

/** One row per run, raw cost values as recorded; excluded runs keep their row with a reason. */
export interface Observation extends Record<MetricName, number | null> {
  task_id: string;
  category: TaskCategory;
  arm: BenchmarkArm;
  run_index: number;
  status: RunStatus;
  success: boolean;
  excluded_reason: string | null;
  token_measurement: TokenMeasurement;
  call_measurement: CallMeasurement;
}

export interface ArmSummary {
  arm: BenchmarkArm;
  runs: number;
  valid_runs: number;
  excluded_runs: number;
  successes: number;
  /** successes / valid runs; null without valid runs. */
  success_rate: number | null;
  /** Token measurement kinds across valid runs. */
  token_measurements: Record<TokenMeasurement, number>;
  metrics: Record<MetricName, Stat>;
}

export interface MetricComparison {
  metric: MetricName;
  baseline_median: number | null;
  treatment_median: number | null;
  /** treatment median - baseline median. */
  delta_median: number | null;
  pct_change: number | null;
  /** Why pct_change is null; null when it was computed. */
  pct_reason: string | null;
}

export interface ArmComparison {
  baseline_valid_runs: number;
  treatment_valid_runs: number;
  baseline_success_rate: number | null;
  treatment_success_rate: number | null;
  /** (treatment - baseline) success rate, in percentage points. */
  success_rate_delta_points: number | null;
  metrics: MetricComparison[];
}

/** Plan section 9 "Existing-Hunch value", computed mechanically; indicative at pilot size. */
export interface ExistingHunchCriteria {
  indicative: true;
  task_count: number;
  quality: { pass: boolean | null; degradation_points: number | null; threshold_points: number };
  investigation: { pass: boolean | null; baseline_median: number | null; treatment_median: number | null };
  movement: {
    pass: boolean | null;
    categories: TaskCategory[];
    time: { baseline_median: number | null; treatment_median: number | null; lower: boolean | null };
    input_tokens: { baseline_median: number | null; treatment_median: number | null; lower: boolean | null; reason: string | null };
  };
  abstention: {
    computed: false;
    reason: string;
    tasks: {
      task_id: string;
      runs: { run_index: number; status: RunStatus; hunch_context_estimated_tokens: number; delivered_eligible_ids: string[] }[];
    }[];
  };
}

export interface TaskDelivery {
  task_id: string;
  relevance_expected: SuiteTask["memory"]["relevance_expected"];
  /** Valid treatment-arm runs the counts are over. */
  valid_runs: number;
  records: { id: string; delivered_runs: number }[];
}

export interface BenchmarkReport {
  schema: "hunch.context-efficiency-report/1";
  manifest_sha256: string;
  generated_at: string;
  evidence: "product" | "fixture";
  arms: { baseline: BenchmarkArm; treatment: BenchmarkArm };
  sample: { tasks: number; runs: number; valid_runs: number; excluded_runs: number };
  observations: Observation[];
  per_arm: ArmSummary[];
  per_category: { category: TaskCategory; arms: ArmSummary[] }[];
  per_task: {
    task_id: string; category: TaskCategory; relevance_expected: SuiteTask["memory"]["relevance_expected"]; arms: ArmSummary[];
  }[];
  comparison: { overall: ArmComparison; per_category: { category: TaskCategory; comparison: ArmComparison }[] };
  criteria: ExistingHunchCriteria;
  delivery: TaskDelivery[];
}

/** Median of the values; even n averages the two middle values; empty is null. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function isValidRun(run: EfficiencyRun): boolean {
  return VALID_STATUSES.includes(run.status);
}

function excludedReason(run: EfficiencyRun): string | null {
  if (run.status === "invalid_exposure") return "invalid exposure: arm exposure proof failed";
  if (run.status === "isolation_breach") return "isolation breach";
  return null;
}

/** A run's value for aggregation: provider tokens only, calls unless unavailable, timing always. */
function metricValue(run: EfficiencyRun, metric: MetricName): number | null {
  const value = run.cost[metric];
  if (value === null) return null;
  if (TOKEN_METRICS.includes(metric)) return run.cost.token_measurement === "provider" ? value : null;
  if (CALL_METRICS.includes(metric)) return run.cost.call_measurement === "unavailable" ? null : value;
  return value;
}

/** Median and range over valid runs only; values ascending. */
export function summarizeMetric(runs: EfficiencyRun[], metric: MetricName): Stat {
  const values = runs.filter(isValidRun).map((run) => metricValue(run, metric))
    .filter((value): value is number => value !== null).sort((x, y) => x - y);
  return { n: values.length, median: median(values), min: values[0] ?? null, max: values.at(-1) ?? null, values };
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const byCode = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

function successRate(valid: EfficiencyRun[]): number | null {
  return valid.length === 0 ? null : valid.filter((run) => run.success).length / valid.length;
}

function summarizeArm(arm: BenchmarkArm, runs: EfficiencyRun[]): ArmSummary {
  const armRuns = runs.filter((run) => run.arm === arm);
  const valid = armRuns.filter(isValidRun);
  const token_measurements: Record<TokenMeasurement, number> = { provider: 0, estimate: 0, unavailable: 0 };
  for (const run of valid) token_measurements[run.cost.token_measurement] += 1;
  const metrics = Object.fromEntries(METRICS.map((metric) => [metric, summarizeMetric(valid, metric)])) as Record<MetricName, Stat>;
  return {
    arm, runs: armRuns.length, valid_runs: valid.length, excluded_runs: armRuns.length - valid.length,
    successes: valid.filter((run) => run.success).length, success_rate: successRate(valid), token_measurements, metrics,
  };
}

/** Never mixes measurement kinds: a token pct needs every valid run on both sides at "provider". */
function compareMetric(metric: MetricName, a: EfficiencyRun[], b: EfficiencyRun[]): MetricComparison {
  const baseline = summarizeMetric(a, metric).median;
  const treatment = summarizeMetric(b, metric).median;
  const delta = baseline !== null && treatment !== null ? treatment - baseline : null;
  let reason: string | null = null;
  if (TOKEN_METRICS.includes(metric) && ![...a, ...b].filter(isValidRun).every((run) => run.cost.token_measurement === "provider")) {
    reason = REASON_TOKENS;
  } else if (baseline === null || delta === null) reason = REASON_NO_DATA;
  else if (baseline <= 0) reason = REASON_BASELINE_ZERO;
  const pct = reason === null && baseline !== null && delta !== null ? round6((delta / baseline) * 100) : null;
  // A withheld token pct (mixed/unavailable measurement) means the raw delta is not comparable either.
  const delta_median = reason === REASON_TOKENS ? null : delta;
  return { metric, baseline_median: baseline, treatment_median: treatment, delta_median, pct_change: pct, pct_reason: reason };
}

function compareArms(baseline: BenchmarkArm, treatment: BenchmarkArm, runs: EfficiencyRun[]): ArmComparison {
  const a = runs.filter((run) => run.arm === baseline && isValidRun(run));
  const b = runs.filter((run) => run.arm === treatment && isValidRun(run));
  const rateA = successRate(a);
  const rateB = successRate(b);
  return {
    baseline_valid_runs: a.length, treatment_valid_runs: b.length,
    baseline_success_rate: rateA, treatment_success_rate: rateB,
    success_rate_delta_points: rateA !== null && rateB !== null ? round6((rateB - rateA) * 100) : null,
    metrics: METRICS.map((metric) => compareMetric(metric, a, b)),
  };
}

const metricOf = (comparison: ArmComparison, metric: MetricName) => comparison.metrics.find((m) => m.metric === metric)!;

function existingHunchCriteria(
  suite: BenchmarkSuite, runs: EfficiencyRun[], baseline: BenchmarkArm, treatment: BenchmarkArm, overall: ArmComparison,
): ExistingHunchCriteria {
  const degradation = overall.success_rate_delta_points === null ? null : round6(0 - overall.success_rate_delta_points);
  const investigation = metricOf(overall, "investigation_tool_calls");
  const movementTasks = new Set(suite.tasks.filter((task) => MOVEMENT_CATEGORIES.includes(task.category)).map((task) => task.id));
  const movement = compareArms(baseline, treatment, runs.filter((run) => movementTasks.has(run.task_id)));
  const time = metricOf(movement, "total_wall_clock_ms");
  const tokens = metricOf(movement, "input_tokens");
  const timeLower = time.delta_median === null ? null : time.delta_median < 0;
  const tokensComparable = tokens.pct_reason === null || tokens.pct_reason === REASON_BASELINE_ZERO;
  const tokensLower = tokensComparable && tokens.delta_median !== null ? tokens.delta_median < 0 : null;
  // Pass when either signal moved down; fail when a signal was measurable and none did; else undetermined.
  const movementPass = timeLower === true || tokensLower === true ? true : timeLower === null && tokensLower === null ? null : false;
  return {
    indicative: true,
    task_count: suite.tasks.length,
    quality: { pass: degradation === null ? null : degradation <= QUALITY_THRESHOLD_POINTS, degradation_points: degradation, threshold_points: QUALITY_THRESHOLD_POINTS },
    investigation: {
      pass: investigation.delta_median === null ? null : investigation.delta_median < 0,
      baseline_median: investigation.baseline_median, treatment_median: investigation.treatment_median,
    },
    movement: {
      pass: movementPass,
      categories: [...MOVEMENT_CATEGORIES],
      time: { baseline_median: time.baseline_median, treatment_median: time.treatment_median, lower: timeLower },
      input_tokens: {
        baseline_median: tokens.baseline_median, treatment_median: tokens.treatment_median, lower: tokensLower,
        reason: tokensLower === null ? tokens.pct_reason ?? REASON_NO_DATA : null,
      },
    },
    abstention: {
      computed: false,
      reason: ABSTENTION_REASON,
      tasks: suite.tasks.filter((task) => task.memory.relevance_expected === "abstain").map((task) => ({
        task_id: task.id,
        runs: runs.filter((run) => run.task_id === task.id && run.arm === treatment).map((run) => ({
          run_index: run.run_index, status: run.status,
          hunch_context_estimated_tokens: run.cost.hunch_context_estimated_tokens,
          delivered_eligible_ids: [...run.delivered_eligible_ids],
        })),
      })),
    },
  };
}

function observation(run: EfficiencyRun, category: TaskCategory): Observation {
  const values = Object.fromEntries(METRICS.map((metric) => [metric, run.cost[metric]])) as Record<MetricName, number | null>;
  return {
    task_id: run.task_id, category, arm: run.arm, run_index: run.run_index, status: run.status, success: run.success,
    excluded_reason: excludedReason(run), token_measurement: run.cost.token_measurement, call_measurement: run.cost.call_measurement,
    ...values,
  };
}

export function buildBenchmarkReport(
  suite: BenchmarkSuite,
  runs: EfficiencyRun[],
  opts: { baseline: BenchmarkArm; treatment: BenchmarkArm; manifest_sha256: string; generated_at: string },
): BenchmarkReport {
  const { baseline, treatment } = opts;
  if (baseline === treatment) throw new Error(`baseline and treatment are the same arm: ${baseline}`);
  const taskOrder = new Map(suite.tasks.map((task, index) => [task.id, index]));
  const taskById = new Map(suite.tasks.map((task) => [task.id, task]));
  for (const run of runs) {
    if (!taskOrder.has(run.task_id)) throw new Error(`run for task ${run.task_id} is not in suite ${suite.id}`);
  }
  const sorted = [...runs].sort((x, y) =>
    taskOrder.get(x.task_id)! - taskOrder.get(y.task_id)! || x.run_index - y.run_index || byCode(x.arm, y.arm));
  const arms = [...new Set<BenchmarkArm>([baseline, treatment, ...sorted.map((run) => run.arm)])].sort(byCode);
  const categories = [...new Set(suite.tasks.map((task) => task.category))];
  const inCategory = (category: TaskCategory) => sorted.filter((run) => taskById.get(run.task_id)!.category === category);
  const overall = compareArms(baseline, treatment, sorted);
  const validRuns = sorted.filter(isValidRun).length;
  return {
    schema: "hunch.context-efficiency-report/1",
    manifest_sha256: opts.manifest_sha256,
    generated_at: opts.generated_at,
    evidence: sorted.some((run) => run.evidence_kind === "fixture") ? "fixture" : "product",
    arms: { baseline, treatment },
    sample: { tasks: suite.tasks.length, runs: sorted.length, valid_runs: validRuns, excluded_runs: sorted.length - validRuns },
    observations: sorted.map((run) => observation(run, taskById.get(run.task_id)!.category)),
    per_arm: arms.map((arm) => summarizeArm(arm, sorted)),
    per_category: categories.map((category) => ({ category, arms: arms.map((arm) => summarizeArm(arm, inCategory(category))) })),
    per_task: suite.tasks.map((task) => {
      const taskRuns = sorted.filter((run) => run.task_id === task.id);
      return {
        task_id: task.id, category: task.category, relevance_expected: task.memory.relevance_expected,
        arms: arms.map((arm) => summarizeArm(arm, taskRuns)),
      };
    }),
    comparison: {
      overall,
      per_category: categories.map((category) => ({ category, comparison: compareArms(baseline, treatment, inCategory(category)) })),
    },
    criteria: existingHunchCriteria(suite, sorted, baseline, treatment, overall),
    delivery: suite.tasks.map((task) => {
      const b = sorted.filter((run) => run.task_id === task.id && run.arm === treatment && isValidRun(run));
      return {
        task_id: task.id, relevance_expected: task.memory.relevance_expected, valid_runs: b.length,
        records: task.memory.eligible_record_ids.map((id) => ({ id, delivered_runs: b.filter((run) => run.delivered_eligible_ids.includes(id)).length })),
      };
    }),
  };
}

const num = (value: number | null) => (value === null ? "-" : Number.isInteger(value) ? String(value) : value.toFixed(1));
const signed = (value: number | null) => (value === null ? "-" : `${value > 0 ? "+" : ""}${num(value)}`);
const rate = (value: number | null) => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);
const range = (stat: Stat) => (stat.median === null ? "-" : `${num(stat.median)} [${num(stat.min)}-${num(stat.max)}]`);
const verdict = (pass: boolean | null) => (pass === null ? "UNDETERMINED" : pass ? "PASS" : "FAIL");
const cell = (text: string) => text.replace(/\|/g, "\\|");
const tableRow = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
const table = (head: string[], rows: string[][]) =>
  [tableRow(head), tableRow(head.map(() => "---")), ...rows.map(tableRow)].join("\n");

function comparisonRows(scope: string, comparison: ArmComparison): string[][] {
  const quality = [scope, "success rate", rate(comparison.baseline_success_rate), rate(comparison.treatment_success_rate),
    comparison.success_rate_delta_points === null ? "-" : `${signed(round6(comparison.success_rate_delta_points))} pts`, "-"];
  return [quality, ...comparison.metrics.map((m) => [
    scope, m.metric, num(m.baseline_median), num(m.treatment_median), signed(m.delta_median),
    m.pct_change === null ? `n/a (${m.pct_reason})` : `${m.pct_change > 0 ? "+" : ""}${m.pct_change.toFixed(1)}%`,
  ])];
}

export function renderBenchmarkMarkdown(report: BenchmarkReport): string {
  const { baseline, treatment } = report.arms;
  const { criteria, sample } = report;
  const lines: string[] = [];
  if (report.evidence === "fixture") {
    lines.push("**FIXTURE EVIDENCE, not product evidence: these numbers come from fixture runs and say nothing about Hunch.**", "");
  }
  lines.push(`# Context-efficiency pilot report: ${treatment} vs ${baseline}`, "");
  lines.push(`Evidence: ${report.evidence === "fixture" ? "fixture (not product evidence)" : "product"}. `
    + `Manifest \`${report.manifest_sha256}\`. Generated ${report.generated_at}.`, "");

  lines.push("## Observations", "", table(
    ["task", "category", "arm", "run", "status", "success", "excluded", "input tok", "output tok", "token meas.",
      "hunch ctx est.", "model calls", "tool calls", "invest. calls", "agent ms", "validation ms", "total ms"],
    report.observations.map((o) => [
      o.task_id, o.category, o.arm, String(o.run_index), o.status, o.success ? "yes" : "no", o.excluded_reason ?? "-",
      num(o.input_tokens), num(o.output_tokens), o.token_measurement, num(o.hunch_context_estimated_tokens),
      num(o.model_calls), num(o.tool_calls), num(o.investigation_tool_calls),
      num(o.agent_wall_clock_ms), num(o.validation_ms), num(o.total_wall_clock_ms),
    ]),
  ), "");

  lines.push("## Per arm: median [min-max]", "", table(
    ["metric", ...report.per_arm.map((a) => a.arm)],
    [
      ["valid / total runs", ...report.per_arm.map((a) => `${a.valid_runs} / ${a.runs}`)],
      ["success rate", ...report.per_arm.map((a) => rate(a.success_rate))],
      ...METRICS.map((metric) => [metric, ...report.per_arm.map((a) => range(a.metrics[metric]))]),
    ],
  ), "");

  lines.push(`## Comparison: ${treatment} vs ${baseline} (medians)`, "", table(
    ["scope", "metric", baseline, treatment, "delta", "change"],
    [
      ...comparisonRows("all", report.comparison.overall),
      ...report.comparison.per_category.flatMap((c) => comparisonRows(c.category, c.comparison)),
    ],
  ), "");

  const { quality, investigation, movement, abstention } = criteria;
  lines.push(`## Existing-Hunch criteria (indicative: ${criteria.task_count} tasks)`, "");
  lines.push(`1. Quality degradation <= ${quality.threshold_points} points: ${verdict(quality.pass)} `
    + `(degradation ${quality.degradation_points === null ? "-" : num(quality.degradation_points)} points)`);
  lines.push(`2. Lower median investigation tool calls: ${verdict(investigation.pass)} `
    + `(${num(investigation.baseline_median)} -> ${num(investigation.treatment_median)})`);
  lines.push(`3. Positive time or provider-token movement on ${movement.categories.join(", ")}: ${verdict(movement.pass)} `
    + `(total ms ${num(movement.time.baseline_median)} -> ${num(movement.time.treatment_median)}; `
    + `input tokens ${movement.input_tokens.reason === null
      ? `${num(movement.input_tokens.baseline_median)} -> ${num(movement.input_tokens.treatment_median)}`
      : `n/a (${movement.input_tokens.reason})`})`);
  lines.push(`4. Abstention: not computed (${abstention.reason})`);
  for (const task of abstention.tasks) {
    const runs = task.runs.map((r) => `run ${r.run_index} ${r.status}: ${r.hunch_context_estimated_tokens} est. tokens, `
      + `delivered [${r.delivered_eligible_ids.join(", ")}]`);
    lines.push(`   - ${task.task_id}: ${runs.length === 0 ? `no ${treatment} runs` : runs.join("; ")}`);
  }
  lines.push("");

  lines.push(`## Delivery (${treatment}, valid runs)`, "", table(
    ["task", "relevance", "valid runs", "eligible record", "delivered in runs"],
    report.delivery.flatMap((d) => d.records.length === 0
      ? [[d.task_id, d.relevance_expected, String(d.valid_runs), "(none)", "-"]]
      : d.records.map((r) => [d.task_id, d.relevance_expected, String(d.valid_runs), r.id, `${r.delivered_runs} / ${d.valid_runs}`])),
  ), "");

  lines.push("## Limitations", "");
  lines.push(`- Sample size: ${sample.tasks} tasks, ${sample.runs} runs (${sample.valid_runs} valid, ${sample.excluded_runs} excluded).`);
  lines.push("- Pilot statistics are every observation plus median and range; no p95, no means. Criteria are indicative only.");
  lines.push("- hunch_context_estimated_tokens is a local estimate reported separately; it is never added to input_tokens.");
  lines.push("- Token percentages are withheld unless every valid run on both sides has provider token counts.");
  if (report.evidence === "fixture") lines.push("- Fixture evidence: not product evidence.");
  return `${lines.join("\n")}\n`;
}
