import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../core/io.js";
import { shortHash } from "../core/ids.js";
import type { HunchStore } from "../store/hunchStore.js";
import { canonicalHash } from "./canonical.js";
import { currentAppendOnly, loadPrivateRecords } from "./g2.js";
import type { ExperimentPreregistration, G3RequiredExperiment } from "./g3.js";

const HASH = /^sha1:[a-f0-9]{40}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const ACTOR = /^(human|git|github|runner):[^\s]+$/i;
const ID = /^[a-z][a-z0-9_.-]{1,127}$/;
const encode = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const EXPERIMENT_ANALYSIS_SPEC = {
  implementation: "hunch-g3-experiment-report-v1",
  binary_interval: "wilson-95",
  small_cell_test: "fisher-exact-two-sided",
  reviewer_rate_interval: "seeded-nonparametric-bootstrap-4000",
  effect_sizes: ["absolute-difference", "relative-risk-or-rate"],
  missingness: "all-assigned-denominators",
} as const;
export const EXPERIMENT_ANALYSIS_HASH = canonicalHash(EXPERIMENT_ANALYSIS_SPEC);

const CommandSchema = z.object({
  command: z.string().trim().min(1).max(4096),
  args: z.array(z.string().max(8192)).max(128),
  timeout_ms: z.number().int().min(1).max(1_800_000),
}).strict();

const LockedExternalCommandSchema = CommandSchema.extend({
  artifact: z.string().trim().min(1).max(4096),
  artifact_hash: z.string().regex(HASH),
}).strict();

const HiddenEvaluatorSchema = LockedExternalCommandSchema.extend({
  visibility: z.literal("hidden_external"),
}).strict();

const StrataSchema = z.record(z.string().min(1).max(128), z.string().min(1).max(512));

const CommonCaseSchema = z.object({
  id: z.string().regex(ID),
  block: z.string().trim().min(1).max(256),
  created_at: z.string().datetime({ offset: true }),
  held_out: z.literal(true),
  used_for_tuning: z.literal(false),
  strata: StrataSchema,
}).strict();

export const Exp01CaseSchema = CommonCaseSchema.extend({
  prompt: z.string().trim().min(1).max(40_000),
  context: z.object({
    decision: z.string().trim().min(1).max(10_000),
    rationale: z.string().trim().min(1).max(10_000),
    executable_policy: z.string().trim().min(1).max(10_000),
    causal_incident: z.string().trim().min(1).max(10_000),
  }).strict(),
  setup: LockedExternalCommandSchema.nullable(),
  evaluator: HiddenEvaluatorSchema,
}).strict();

export const Exp03CaseSchema = CommonCaseSchema.extend({
  evidence: z.string().trim().min(1).max(100_000),
  required_relationship: z.string().trim().min(1).max(20_000).optional(),
  manual_brief: z.string().trim().min(1).max(20_000),
  compiler_candidate: z.string().trim().min(1).max(100_000),
  proof_card: z.string().trim().min(1).max(100_000),
  editable_bindings: z.array(z.string().trim().min(1).max(5000)).min(1).max(256),
  target_commitment_hash: z.string().regex(HASH),
}).strict();

const ExperimentCaseSchema = z.union([Exp01CaseSchema, Exp03CaseSchema]);

export const ExperimentCaseBankSchema = z.object({
  id: z.string().regex(/^expbank_[a-f0-9]{10}$/),
  content_hash: z.string().regex(HASH),
  experiment: z.enum(["EXP-01", "EXP-03"]),
  preregistration_id: z.string().regex(/^expreg_[a-f0-9]{10}$/),
  preregistration_hash: z.string().regex(HASH),
  repository_root: z.string().trim().min(1).max(4096),
  base_commit: z.string().regex(COMMIT),
  cases: z.array(ExperimentCaseSchema).min(1).max(100_000),
  actor: z.string().regex(ACTOR),
  reason: z.string().trim().min(1).max(4000),
  data_class: z.literal("private"),
  authority: z.literal("none"),
  locked_at: z.string().datetime({ offset: true }),
}).strict().superRefine((bank, ctx) => {
  const seen = new Set<string>();
  for (const [index, item] of bank.cases.entries()) {
    if (seen.has(item.id)) ctx.addIssue({ code: "custom", path: ["cases", index, "id"], message: "case ids must be unique" });
    seen.add(item.id);
    const isExp01 = "prompt" in item;
    if ((bank.experiment === "EXP-01") !== isExp01) {
      ctx.addIssue({ code: "custom", path: ["cases", index], message: `case shape does not match ${bank.experiment}` });
    }
  }
});
export type ExperimentCaseBank = z.infer<typeof ExperimentCaseBankSchema>;
export type Exp01Case = z.infer<typeof Exp01CaseSchema>;
export type Exp03Case = z.infer<typeof Exp03CaseSchema>;

export type CompileExperimentCaseBankInput = Omit<ExperimentCaseBank,
  "id" | "content_hash" | "data_class" | "authority" | "locked_at">;

export function experimentCaseBankContentHash(bank: ExperimentCaseBank): string {
  const { id: _id, content_hash: _hash, ...body } = bank;
  return canonicalHash(body);
}

export function compileExperimentCaseBank(
  input: CompileExperimentCaseBankInput,
  preregistration: ExperimentPreregistration,
  opts: { now?: string } = {},
): ExperimentCaseBank {
  if (input.experiment !== preregistration.experiment) throw new Error("case bank experiment does not match preregistration");
  if (input.preregistration_id !== preregistration.id || input.preregistration_hash !== preregistration.content_hash) {
    throw new Error("case bank must bind the exact current preregistration id and content hash");
  }
  const lockedAt = opts.now ?? new Date().toISOString();
  if (Date.parse(lockedAt) < Date.parse(preregistration.registered_at)) throw new Error("case bank cannot be locked before preregistration");
  for (const item of input.cases) {
    if (Date.parse(item.created_at) < Date.parse(preregistration.registered_at)) {
      throw new Error(`case ${item.id} predates preregistration and is excluded from the fresh sample`);
    }
    const missing = preregistration.strata.filter((stratum) => !item.strata[stratum]);
    if (missing.length) throw new Error(`case ${item.id} is missing preregistered strata: ${missing.join(", ")}`);
    if (input.experiment === "EXP-03" && preregistration.revision >= 2
      && (!("required_relationship" in item) || !item.required_relationship)) {
      throw new Error(`case ${item.id} must state the durable required relationship in plain language for EXP-03 revision 2 or later`);
    }
  }
  const body = {
    experiment: input.experiment,
    preregistration_id: input.preregistration_id,
    preregistration_hash: input.preregistration_hash,
    repository_root: input.repository_root,
    base_commit: input.base_commit,
    cases: input.cases,
    actor: input.actor,
    reason: input.reason.trim(),
    data_class: "private" as const,
    authority: "none" as const,
    locked_at: lockedAt,
  };
  const contentHash = canonicalHash(body);
  return ExperimentCaseBankSchema.parse({ id: `expbank_${shortHash(contentHash)}`, content_hash: contentHash, ...body });
}

const AssignmentSchema = z.object({
  id: z.string().regex(/^expassign_[a-f0-9]{10}$/),
  case_id: z.string().regex(ID),
  arm: z.string().regex(/^[A-Z][A-Z0-9_-]{0,15}$/),
  block: z.string().min(1),
  order: z.number().int().min(0),
  treatment_hash: z.string().regex(HASH),
}).strict();
export type ExperimentAssignment = z.infer<typeof AssignmentSchema>;

export const ExperimentRunSchema = z.object({
  id: z.string().regex(/^exprun_[a-f0-9]{10}$/),
  content_hash: z.string().regex(HASH),
  experiment: z.enum(["EXP-01", "EXP-03"]),
  preregistration_id: z.string().regex(/^expreg_[a-f0-9]{10}$/),
  preregistration_hash: z.string().regex(HASH),
  case_bank_id: z.string().regex(/^expbank_[a-f0-9]{10}$/),
  case_bank_hash: z.string().regex(HASH),
  seed: z.string().min(1),
  sample_per_arm: z.number().int().min(1),
  assignment_strategy: z.enum(["crossed_blocked", "exclusive_blocked"]),
  assignments: z.array(AssignmentSchema).min(2).max(1_000_000),
  runner: z.object({
    implementation: z.literal("hunch-g3-experiment-v1"),
    provider: z.enum(["claude-cli", "codex-cli"]).nullable(),
    provider_version: z.string().min(1).nullable(),
    model_version: z.string().min(1).nullable(),
    max_turns: z.number().int().min(1).max(1000).nullable(),
  }).strict(),
  actor: z.string().regex(ACTOR),
  reason: z.string().trim().min(1).max(4000),
  data_class: z.literal("private"),
  authority: z.literal("none"),
  created_at: z.string().datetime({ offset: true }),
}).strict().superRefine((run, ctx) => {
  const ids = run.assignments.map((item) => item.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["assignments"], message: "assignment ids must be unique" });
  const orders = [...run.assignments.map((item) => item.order)].sort((a, b) => a - b);
  if (new Set(orders).size !== orders.length || orders.some((value, index) => value !== index)) {
    ctx.addIssue({ code: "custom", path: ["assignments"], message: "assignment order must be one unique contiguous sequence" });
  }
  const arms = [...new Set(run.assignments.map((item) => item.arm))];
  if (arms.some((arm) => run.assignments.filter((item) => item.arm === arm).length !== run.sample_per_arm)) {
    ctx.addIssue({ code: "custom", path: ["assignments"], message: "every manifest arm must contain exactly sample_per_arm assignments" });
  }
  const byCase = new Map<string, ExperimentAssignment[]>();
  for (const assignment of run.assignments) byCase.set(assignment.case_id, [...(byCase.get(assignment.case_id) ?? []), assignment]);
  if (run.experiment === "EXP-01") {
    if (run.assignment_strategy !== "crossed_blocked" || byCase.size !== run.sample_per_arm
      || [...byCase.values()].some((items) => items.length !== arms.length || new Set(items.map((item) => item.arm)).size !== arms.length)) {
      ctx.addIssue({ code: "custom", path: ["assignments"], message: "EXP-01 must cross every fresh case exactly once through every arm" });
    }
  } else if (run.assignment_strategy !== "exclusive_blocked" || byCase.size !== run.assignments.length) {
    ctx.addIssue({ code: "custom", path: ["assignments"], message: "EXP-03 must assign each fresh case exclusively to one arm" });
  }
  if (run.experiment === "EXP-01" && (!run.runner.provider || !run.runner.provider_version || !run.runner.model_version || !run.runner.max_turns)) {
    ctx.addIssue({ code: "custom", path: ["runner"], message: "EXP-01 requires an exact subscription CLI, version, model, and max-turn limit" });
  }
  if (run.experiment === "EXP-03" && Object.values(run.runner).some((value) => value !== null && value !== "hunch-g3-experiment-v1")) {
    ctx.addIssue({ code: "custom", path: ["runner"], message: "EXP-03 human review must not claim an automated model runner" });
  }
});
export type ExperimentRun = z.infer<typeof ExperimentRunSchema>;

export interface CompileExperimentRunInput {
  sample_per_arm: number;
  provider?: "claude-cli" | "codex-cli";
  provider_version?: string;
  model_version?: string;
  max_turns?: number;
  actor: string;
  reason: string;
}

function rank(seed: string, ...parts: string[]): string {
  return canonicalHash([seed, ...parts]);
}

function treatmentFor(experiment: G3RequiredExperiment, arm: string, item: Exp01Case | Exp03Case): unknown {
  if (experiment === "EXP-01") {
    const c = Exp01CaseSchema.parse(item);
    if (arm === "A") return { prompt: c.prompt, context: null };
    if (arm === "B") return { prompt: c.prompt, context: { decision: c.context.decision, rationale: c.context.rationale } };
    return { prompt: c.prompt, context: c.context };
  }
  const c = Exp03CaseSchema.parse(item);
  // Revision-1 cases have no required_relationship. Preserve their exact treatment
  // bytes so the append-only pilot remains replayable under its original hash.
  if (c.required_relationship) {
    const review = {
      required_relationship: c.required_relationship,
      question: "Does the proposed rule accurately preserve the required relationship described above?",
      choices: [
        { value: "accept", label: "Yes — use it as written" },
        { value: "edit", label: "Yes — after I correct the rule" },
        { value: "reject", label: "No — the rule is wrong or unsupported" },
        { value: "cannot_decide", label: "Cannot decide from this evidence" },
      ],
      response_template: {
        choice: "accept | edit | reject | cannot_decide",
        rule_text: "Required for accept or edit; otherwise leave blank.",
        reason: "One plain-language sentence.",
      },
    };
    if (arm === "A") return { evidence: c.evidence, review, manual_brief: c.manual_brief };
    if (arm === "B") return { evidence: c.evidence, review, proposed_rule: c.compiler_candidate };
    return { evidence: c.evidence, review, proposed_rule: c.compiler_candidate, supporting_checks: c.proof_card, editable_parts: c.editable_bindings };
  }
  if (arm === "A") return { evidence: c.evidence, manual_brief: c.manual_brief };
  if (arm === "B") return { evidence: c.evidence, compiler_candidate: c.compiler_candidate };
  return { evidence: c.evidence, compiler_candidate: c.compiler_candidate, proof_card: c.proof_card, editable_bindings: c.editable_bindings };
}

export function assignmentTreatment(bank: ExperimentCaseBank, run: ExperimentRun, assignment: ExperimentAssignment): unknown {
  if (run.case_bank_id !== bank.id || run.case_bank_hash !== bank.content_hash) throw new Error("run does not bind this exact case bank");
  const item = bank.cases.find((candidate) => candidate.id === assignment.case_id);
  if (!item) throw new Error(`assignment ${assignment.id} references missing case ${assignment.case_id}`);
  const treatment = treatmentFor(run.experiment, assignment.arm, item);
  if (canonicalHash(treatment) !== assignment.treatment_hash) throw new Error(`assignment ${assignment.id} treatment hash mismatch`);
  return treatment;
}

export function experimentRunContentHash(run: ExperimentRun): string {
  const { id: _id, content_hash: _hash, ...body } = run;
  return canonicalHash(body);
}

export function compileExperimentRun(
  input: CompileExperimentRunInput,
  preregistration: ExperimentPreregistration,
  bank: ExperimentCaseBank,
  opts: { now?: string } = {},
): ExperimentRun {
  if (bank.preregistration_id !== preregistration.id || bank.preregistration_hash !== preregistration.content_hash) {
    throw new Error("run case bank does not bind the exact preregistration");
  }
  if (Date.parse(bank.locked_at) < Date.parse(preregistration.registered_at)) throw new Error("run case bank predates its preregistration");
  for (const item of bank.cases) {
    const missing = preregistration.strata.filter((stratum) => !item.strata[stratum]);
    if (Date.parse(item.created_at) < Date.parse(preregistration.registered_at) || missing.length || !item.held_out || item.used_for_tuning) {
      throw new Error(`case ${item.id} no longer satisfies the locked fresh-sample boundary`);
    }
  }
  if (!Number.isInteger(input.sample_per_arm) || input.sample_per_arm !== preregistration.sample_plan.target_per_arm) {
    throw new Error(`the immutable assignment manifest must carry the full preregistered target of ${preregistration.sample_plan.target_per_arm} samples per arm; inspect the first ${preregistration.sample_plan.minimum_per_arm} as a pilot checkpoint without stopping or replacing the run`);
  }
  const arms = preregistration.arms.map((arm) => arm.id);
  if (arms.join(",") !== "A,B,C") throw new Error(`${preregistration.experiment} execution requires the preregistered A/B/C arm contract in exact order`);
  const assignments: ExperimentAssignment[] = [];
  if (preregistration.experiment === "EXP-01") {
    if (bank.cases.length !== input.sample_per_arm) throw new Error("EXP-01 requires exactly sample_per_arm fresh case templates; every case is run once in every arm");
    for (const item of bank.cases) {
      const orderedArms = [...arms].sort((a, b) => rank(preregistration.assignment.seed, item.block, item.id, a).localeCompare(rank(preregistration.assignment.seed, item.block, item.id, b)));
      for (const arm of orderedArms) {
        const treatmentHash = canonicalHash(treatmentFor(preregistration.experiment, arm, item));
        const id = `expassign_${shortHash(canonicalHash({ preregistration: preregistration.content_hash, bank: bank.content_hash, case_id: item.id, arm, treatment_hash: treatmentHash }))}`;
        assignments.push({ id, case_id: item.id, arm, block: item.block, order: 0, treatment_hash: treatmentHash });
      }
    }
  } else {
    if (bank.cases.length !== input.sample_per_arm * arms.length) throw new Error("EXP-03 requires exactly sample_per_arm multiplied by arm count fresh cases");
    const byBlock = new Map<string, typeof bank.cases>();
    for (const item of bank.cases) byBlock.set(item.block, [...(byBlock.get(item.block) ?? []), item]);
    let offset = 0;
    for (const [block, blockCases] of [...byBlock.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const ordered = [...blockCases].sort((a, b) => rank(preregistration.assignment.seed, block, a.id).localeCompare(rank(preregistration.assignment.seed, block, b.id)));
      const armOrder = [...arms].sort((a, b) => rank(preregistration.assignment.seed, block, "arm", a).localeCompare(rank(preregistration.assignment.seed, block, "arm", b)));
      for (const [index, item] of ordered.entries()) {
        const arm = armOrder[(offset + index) % armOrder.length]!;
        const treatmentHash = canonicalHash(treatmentFor(preregistration.experiment, arm, item));
        const id = `expassign_${shortHash(canonicalHash({ preregistration: preregistration.content_hash, bank: bank.content_hash, case_id: item.id, arm, treatment_hash: treatmentHash }))}`;
        assignments.push({ id, case_id: item.id, arm, block: item.block, order: 0, treatment_hash: treatmentHash });
      }
      offset += ordered.length;
    }
    const counts = new Map(arms.map((arm) => [arm, assignments.filter((item) => item.arm === arm).length]));
    if ([...counts.values()].some((count) => count !== input.sample_per_arm)) throw new Error("EXP-03 blocks cannot be assigned to an exactly balanced arm allocation; adjust block sizes");
  }
  assignments.sort((a, b) => rank(preregistration.assignment.seed, "execution", a.id).localeCompare(rank(preregistration.assignment.seed, "execution", b.id)));
  assignments.forEach((assignment, order) => { assignment.order = order; });
  if (assignments.length > preregistration.sample_plan.maximum_total) throw new Error("assignment count exceeds preregistered maximum_total");
  const isExp01 = preregistration.experiment === "EXP-01";
  const body = {
    experiment: preregistration.experiment,
    preregistration_id: preregistration.id,
    preregistration_hash: preregistration.content_hash,
    case_bank_id: bank.id,
    case_bank_hash: bank.content_hash,
    seed: preregistration.assignment.seed,
    sample_per_arm: input.sample_per_arm,
    assignment_strategy: isExp01 ? "crossed_blocked" as const : "exclusive_blocked" as const,
    assignments,
    runner: {
      implementation: "hunch-g3-experiment-v1" as const,
      provider: isExp01 ? input.provider ?? null : null,
      provider_version: isExp01 ? input.provider_version?.trim() ?? null : null,
      model_version: isExp01 ? input.model_version?.trim() ?? null : null,
      max_turns: isExp01 ? input.max_turns ?? null : null,
    },
    actor: input.actor,
    reason: input.reason.trim(),
    data_class: "private" as const,
    authority: "none" as const,
    created_at: opts.now ?? new Date().toISOString(),
  };
  const contentHash = canonicalHash(body);
  return ExperimentRunSchema.parse({ id: `exprun_${shortHash(contentHash)}`, content_hash: contentHash, ...body });
}

const Exp01MetricsSchema = z.object({
  valid_completion: z.boolean(),
  policy_violation: z.boolean().nullable(),
  task_success: z.boolean(),
  build_success: z.boolean(),
  unknown_or_error: z.boolean(),
  refusal: z.boolean(),
  turns: z.number().int().min(0).nullable(),
  edits: z.number().int().min(0).nullable(),
  tokens: z.number().int().min(0).nullable(),
  latency_ms: z.number().int().min(0),
}).strict().superRefine((metrics, ctx) => {
  if (metrics.valid_completion !== (metrics.policy_violation !== null)) ctx.addIssue({ code: "custom", path: ["policy_violation"], message: "policy_violation must be present exactly for valid completions" });
});

const Exp03MetricsSchema = z.object({
  decision: z.enum(["accepted_precise", "accepted_edited", "rejected", "uncompilable", "abandoned", "timeout"]),
  precise: z.boolean(),
  proof_inspected: z.boolean(),
  result_hash: z.string().regex(HASH).nullable(),
  semantic_edit_distance: z.number().min(0).max(1).nullable(),
  silent_semantic_substitution: z.boolean(),
  rejection_reason: z.string().trim().min(1).max(4000).nullable(),
  duration_ms: z.number().int().min(1).max(86_400_000),
}).strict().superRefine((metrics, ctx) => {
  if (metrics.decision.startsWith("accepted") && !metrics.precise) ctx.addIssue({ code: "custom", path: ["precise"], message: "accepted outcomes must be precise" });
  if (metrics.decision.startsWith("accepted") !== (metrics.result_hash !== null)) ctx.addIssue({ code: "custom", path: ["result_hash"], message: "an accepted result hash is required exactly for accepted outcomes" });
  if (!metrics.decision.startsWith("accepted") && metrics.semantic_edit_distance !== null) ctx.addIssue({ code: "custom", path: ["semantic_edit_distance"], message: "non-accepted outcomes cannot claim proposal edit distance" });
  if (metrics.decision === "rejected" && !metrics.rejection_reason) ctx.addIssue({ code: "custom", path: ["rejection_reason"], message: "rejected outcomes require a reason" });
});

export const ExperimentOutcomeSchema = z.object({
  id: z.string().regex(/^expout_[a-f0-9]{10}$/),
  content_hash: z.string().regex(HASH),
  run_id: z.string().regex(/^exprun_[a-f0-9]{10}$/),
  assignment_id: z.string().regex(/^expassign_[a-f0-9]{10}$/),
  experiment: z.enum(["EXP-01", "EXP-03"]),
  arm: z.string().regex(/^[A-Z][A-Z0-9_-]{0,15}$/),
  status: z.enum(["completed", "invalid_completion", "infrastructure_failure", "refused", "aborted"]),
  invocation_started: z.boolean(),
  metrics: z.union([Exp01MetricsSchema, Exp03MetricsSchema]).nullable(),
  output_hash: z.string().regex(HASH).nullable(),
  diff_hash: z.string().regex(HASH).nullable(),
  evaluator_hash: z.string().regex(HASH).nullable(),
  error_code: z.string().trim().min(1).max(256).nullable(),
  incidents: z.object({
    confirmed_private_leak: z.boolean(),
    data_loss_or_corruption: z.boolean(),
    unsafe_evaluator_behavior: z.boolean(),
  }).strict(),
  recorder: z.string().regex(ACTOR),
  reason: z.string().trim().min(1).max(4000),
  supersedes: z.string().regex(/^expout_[a-f0-9]{10}$/).nullable(),
  data_class: z.literal("private"),
  authority: z.literal("none"),
  recorded_at: z.string().datetime({ offset: true }),
}).strict().superRefine((outcome, ctx) => {
  if (outcome.status === "completed" && !outcome.metrics) ctx.addIssue({ code: "custom", path: ["metrics"], message: "completed outcomes require metrics" });
  if (outcome.status !== "completed" && outcome.metrics) ctx.addIssue({ code: "custom", path: ["metrics"], message: "non-completed outcomes cannot claim primary metrics" });
  if (outcome.status === "completed" && !outcome.invocation_started) ctx.addIssue({ code: "custom", path: ["invocation_started"], message: "completed outcomes require a recorded model/reviewer invocation" });
  if (outcome.status === "infrastructure_failure" && outcome.invocation_started) ctx.addIssue({ code: "custom", path: ["invocation_started"], message: "pre-invocation infrastructure exclusions must not claim model invocation" });
  if ((outcome.status === "invalid_completion" || outcome.status === "refused") && !outcome.invocation_started) ctx.addIssue({ code: "custom", path: ["invocation_started"], message: `${outcome.status} requires a recorded invocation` });
  if (outcome.status === "completed" && outcome.error_code) ctx.addIssue({ code: "custom", path: ["error_code"], message: "completed outcomes cannot carry an error code" });
  if (outcome.status !== "completed" && !outcome.error_code) ctx.addIssue({ code: "custom", path: ["error_code"], message: "non-completed outcomes require an explicit error code" });
});
export type ExperimentOutcome = z.infer<typeof ExperimentOutcomeSchema>;

export type CompileExperimentOutcomeInput = Omit<ExperimentOutcome,
  "id" | "content_hash" | "experiment" | "arm" | "data_class" | "authority" | "recorded_at">;

export function experimentOutcomeContentHash(outcome: ExperimentOutcome): string {
  const { id: _id, content_hash: _hash, ...body } = outcome;
  return canonicalHash(body);
}

export function normalizedEditDistance(from: string, to: string): number {
  if (from === to) return 0;
  if (!from.length || !to.length) return 1;
  let previous = Array.from({ length: to.length + 1 }, (_, index) => index);
  for (let left = 1; left <= from.length; left++) {
    const current = [left];
    for (let right = 1; right <= to.length; right++) {
      current[right] = Math.min(
        current[right - 1]! + 1,
        previous[right]! + 1,
        previous[right - 1]! + (from[left - 1] === to[right - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[to.length]! / Math.max(from.length, to.length);
}

export function compileExperimentOutcome(input: CompileExperimentOutcomeInput, run: ExperimentRun, opts: { now?: string } = {}): ExperimentOutcome {
  const assignment = run.assignments.find((item) => item.id === input.assignment_id);
  if (!assignment || input.run_id !== run.id) throw new Error("outcome must bind an assignment in the exact run");
  const body = {
    ...input,
    experiment: run.experiment,
    arm: assignment.arm,
    reason: input.reason.trim(),
    data_class: "private" as const,
    authority: "none" as const,
    recorded_at: opts.now ?? new Date().toISOString(),
  };
  const contentHash = canonicalHash(body);
  const parsed = ExperimentOutcomeSchema.parse({ id: `expout_${shortHash(contentHash)}`, content_hash: contentHash, ...body });
  if (parsed.experiment === "EXP-01" && parsed.metrics && !("valid_completion" in parsed.metrics)) throw new Error("EXP-01 outcome requires prevention metrics");
  if (parsed.experiment === "EXP-03" && parsed.metrics && !("decision" in parsed.metrics)) throw new Error("EXP-03 outcome requires review metrics");
  if (parsed.experiment === "EXP-01" && parsed.status === "completed" && parsed.metrics && "valid_completion" in parsed.metrics
    && (!parsed.metrics.valid_completion || parsed.metrics.refusal || parsed.metrics.unknown_or_error)) {
    throw new Error("completed EXP-01 outcomes require a valid, non-refused, known evaluator result");
  }
  return parsed;
}

export const ExperimentReviewStartSchema = z.object({
  id: z.string().regex(/^expreview_[a-f0-9]{10}$/),
  content_hash: z.string().regex(HASH),
  run_id: z.string().regex(/^exprun_[a-f0-9]{10}$/),
  assignment_id: z.string().regex(/^expassign_[a-f0-9]{10}$/),
  reviewer: z.string().regex(/^human:[^\s]+$/i),
  treatment_hash: z.string().regex(HASH),
  data_class: z.literal("private"),
  authority: z.literal("none"),
  started_at: z.string().datetime({ offset: true }),
}).strict();
export type ExperimentReviewStart = z.infer<typeof ExperimentReviewStartSchema>;

export function experimentReviewStartContentHash(record: ExperimentReviewStart): string {
  const { id: _id, content_hash: _hash, ...body } = record;
  return canonicalHash(body);
}

export function compileExperimentReviewStart(run: ExperimentRun, assignment: ExperimentAssignment, reviewer: string, opts: { now?: string } = {}): ExperimentReviewStart {
  if (run.experiment !== "EXP-03" || !run.assignments.some((item) => item.id === assignment.id)) throw new Error("review starts require an EXP-03 assignment in the exact run");
  const body = {
    run_id: run.id,
    assignment_id: assignment.id,
    reviewer,
    treatment_hash: assignment.treatment_hash,
    data_class: "private" as const,
    authority: "none" as const,
    started_at: opts.now ?? new Date().toISOString(),
  };
  const contentHash = canonicalHash(body);
  return ExperimentReviewStartSchema.parse({ id: `expreview_${shortHash(contentHash)}`, content_hash: contentHash, ...body });
}

export const ExperimentFollowupSchema = z.object({
  id: z.string().regex(/^expfollow_[a-f0-9]{10}$/),
  content_hash: z.string().regex(HASH),
  run_id: z.string().regex(/^exprun_[a-f0-9]{10}$/),
  assignment_id: z.string().regex(/^expassign_[a-f0-9]{10}$/),
  outcome_id: z.string().regex(/^expout_[a-f0-9]{10}$/),
  reviewer: z.string().regex(/^human:[^\s]+$/i),
  reversed: z.boolean().nullable(),
  missing_reason: z.string().trim().min(1).max(4000).nullable(),
  notes: z.string().trim().min(1).max(4000),
  supersedes: z.string().regex(/^expfollow_[a-f0-9]{10}$/).nullable(),
  data_class: z.literal("private"),
  authority: z.literal("none"),
  measured_at: z.string().datetime({ offset: true }),
}).strict().superRefine((record, ctx) => {
  if ((record.reversed === null) !== (record.missing_reason !== null)) ctx.addIssue({ code: "custom", path: ["missing_reason"], message: "missing reason is required exactly when reversal is unmeasured" });
});
export type ExperimentFollowup = z.infer<typeof ExperimentFollowupSchema>;

export function experimentFollowupContentHash(record: ExperimentFollowup): string {
  const { id: _id, content_hash: _hash, ...body } = record;
  return canonicalHash(body);
}

export function compileExperimentFollowup(
  input: Omit<ExperimentFollowup, "id" | "content_hash" | "run_id" | "assignment_id" | "outcome_id" | "data_class" | "authority" | "measured_at">,
  run: ExperimentRun,
  outcome: ExperimentOutcome,
  opts: { now?: string } = {},
): ExperimentFollowup {
  if (run.experiment !== "EXP-03" || outcome.run_id !== run.id || outcome.status !== "completed") throw new Error("seven-day follow-up requires a completed EXP-03 outcome in the exact run");
  const measuredAt = opts.now ?? new Date().toISOString();
  if (Date.parse(measuredAt) - Date.parse(outcome.recorded_at) < 7 * 24 * 60 * 60 * 1000) throw new Error("seven-day follow-up cannot be recorded before seven full days");
  const body = {
    run_id: run.id,
    assignment_id: outcome.assignment_id,
    outcome_id: outcome.id,
    reviewer: input.reviewer,
    reversed: input.reversed,
    missing_reason: input.missing_reason,
    notes: input.notes.trim(),
    supersedes: input.supersedes,
    data_class: "private" as const,
    authority: "none" as const,
    measured_at: measuredAt,
  };
  const contentHash = canonicalHash(body);
  return ExperimentFollowupSchema.parse({ id: `expfollow_${shortHash(contentHash)}`, content_hash: contentHash, ...body });
}

export function currentExperimentOutcomes(records: ExperimentOutcome[]): ExperimentOutcome[] {
  return currentAppendOnly(records.map((item) => ExperimentOutcomeSchema.parse(item)), "experiment outcome", (item) => `${item.run_id}:${item.assignment_id}`);
}

export function currentExperimentFollowups(records: ExperimentFollowup[]): ExperimentFollowup[] {
  return currentAppendOnly(records.map((item) => ExperimentFollowupSchema.parse(item)), "experiment follow-up", (item) => `${item.run_id}:${item.assignment_id}`);
}

export const ExperimentStopSchema = z.object({
  id: z.string().regex(/^expstop_[a-f0-9]{10}$/),
  content_hash: z.string().regex(HASH),
  run_id: z.string().regex(/^exprun_[a-f0-9]{10}$/),
  category: z.enum(["confirmed_private_leak", "data_loss_or_corruption", "unsafe_evaluator_behavior", "unsafe_semantic_substitution", "provider_wide_unavailability"]),
  actor: z.string().regex(/^(human|git|github):[^\s]+$/i),
  reason: z.string().trim().min(1).max(4000),
  evidence_hashes: z.array(z.string().regex(HASH)).min(1).max(256),
  data_class: z.literal("private"),
  authority: z.literal("none"),
  effect: z.literal("irreversible_run_stop"),
  recorded_at: z.string().datetime({ offset: true }),
}).strict();
export type ExperimentStop = z.infer<typeof ExperimentStopSchema>;

export function experimentStopContentHash(record: ExperimentStop): string {
  const { id: _id, content_hash: _hash, ...body } = record;
  return canonicalHash(body);
}

export function compileExperimentStop(
  input: Omit<ExperimentStop, "id" | "content_hash" | "run_id" | "data_class" | "authority" | "effect" | "recorded_at">,
  run: ExperimentRun,
  opts: { now?: string } = {},
): ExperimentStop {
  const body = {
    run_id: run.id,
    category: input.category,
    actor: input.actor,
    reason: input.reason.trim(),
    evidence_hashes: [...new Set(input.evidence_hashes)].sort(),
    data_class: "private" as const,
    authority: "none" as const,
    effect: "irreversible_run_stop" as const,
    recorded_at: opts.now ?? new Date().toISOString(),
  };
  const contentHash = canonicalHash(body);
  return ExperimentStopSchema.parse({ id: `expstop_${shortHash(contentHash)}`, content_hash: contentHash, ...body });
}

export interface ExperimentArmReport {
  arm: string;
  assigned: number;
  terminal: number;
  infrastructure_failures: number;
  invalid_or_refused: number;
  valid_completions: number;
  violations: number | null;
  violation_rate: number | null;
  wilson_95: [number, number] | null;
  accepted_precise: number | null;
  reviewer_hours: number | null;
  accepted_per_reviewer_hour: number | null;
  bootstrap_95: [number, number] | null;
  reversals: number | null;
  followups_missing: number | null;
}

function wilson(successes: number, total: number): [number, number] | null {
  if (!total) return null;
  const z = 1.959963984540054;
  const p = successes / total;
  const denom = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denom;
  const half = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function seededRandom(seed: string): () => number {
  let state = Number.parseInt(canonicalHash(seed).slice(5, 13), 16) >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function bootstrapReviewerRate(
  rows: Array<{ duration_ms: number; precise: boolean; decision: string }>,
  seed: string,
  samples = 4000,
): [number, number] | null {
  if (!rows.length) return null;
  const random = seededRandom(seed);
  const rates: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    let accepted = 0;
    let duration = 0;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[Math.floor(random() * rows.length)]!;
      if (row.precise && row.decision.startsWith("accepted")) accepted++;
      duration += row.duration_ms;
    }
    if (duration) rates.push(accepted / (duration / 3_600_000));
  }
  if (!rates.length) return null;
  rates.sort((a, b) => a - b);
  return [rates[Math.floor(0.025 * (rates.length - 1))]!, rates[Math.floor(0.975 * (rates.length - 1))]!];
}

function logCombination(n: number, k: number): number {
  if (k < 0 || k > n) return Number.NEGATIVE_INFINITY;
  let value = 0;
  for (let index = 1; index <= k; index++) value += Math.log(n - k + index) - Math.log(index);
  return value;
}

function fisherTwoSided(a: number, b: number, c: number, d: number): number | null {
  const total = a + b + c + d;
  if (!total) return null;
  const rowOne = a + b;
  const columnOne = a + c;
  const lower = Math.max(0, rowOne - (total - columnOne));
  const upper = Math.min(rowOne, columnOne);
  const probability = (x: number): number => Math.exp(logCombination(columnOne, x) + logCombination(total - columnOne, rowOne - x) - logCombination(total, rowOne));
  const observed = probability(a);
  let p = 0;
  for (let x = lower; x <= upper; x++) {
    const candidate = probability(x);
    if (candidate <= observed + 1e-12) p += candidate;
  }
  return Math.min(1, p);
}

export interface ExperimentReport {
  id: string;
  content_hash: string;
  run_id: string;
  preregistration_hash: string;
  case_bank_hash: string;
  experiment: G3RequiredExperiment;
  analysis: typeof EXPERIMENT_ANALYSIS_SPEC & { deterministic_hash: string };
  status: "registered" | "running" | "awaiting_followup" | "completed" | "guardrail_stopped";
  arms: ExperimentArmReport[];
  strata: Array<{
    key: string;
    value: string;
    arm: string;
    assigned: number;
    terminal: number;
    valid_completions: number;
    violations: number | null;
    accepted_precise: number | null;
    reviewer_ms: number | null;
  }>;
  assignments: number;
  terminal: number;
  unresolved: string[];
  contrasts: Record<string, number | null>;
  deviations: string[];
  guardrails: { confirmed_private_leaks: number; silent_semantic_substitutions: number; data_loss_or_corruption: number; unsafe_evaluator_behavior: number };
  stop_receipts: ExperimentStop[];
  claim_allowed: false;
  authority: "none";
}

export function buildExperimentReport(run: ExperimentRun, bank: ExperimentCaseBank, outcomes: ExperimentOutcome[], followups: ExperimentFollowup[], stops: ExperimentStop[] = []): ExperimentReport {
  if (run.case_bank_id !== bank.id || run.case_bank_hash !== bank.content_hash) throw new Error("experiment report requires the exact run-bound case bank");
  const currentOutcomes = currentExperimentOutcomes(outcomes).filter((item) => item.run_id === run.id);
  const currentFollowups = currentExperimentFollowups(followups).filter((item) => item.run_id === run.id);
  const runStops = stops.filter((item) => ExperimentStopSchema.parse(item).run_id === run.id).sort((a, b) => a.id.localeCompare(b.id));
  const outcomeByAssignment = new Map(currentOutcomes.map((item) => [item.assignment_id, item]));
  const validFollowups = currentFollowups.filter((item) => outcomeByAssignment.get(item.assignment_id)?.id === item.outcome_id);
  const followupByAssignment = new Map(validFollowups.map((item) => [item.assignment_id, item]));
  const armIds = [...new Set(run.assignments.map((item) => item.arm))].sort();
  const arms: ExperimentArmReport[] = armIds.map((arm) => {
    const assigned = run.assignments.filter((item) => item.arm === arm);
    const terminal = assigned.flatMap((item) => outcomeByAssignment.get(item.id) ?? []);
    const completed = terminal.filter((item) => item.status === "completed");
    const prevention = completed.flatMap((item) => item.metrics && "valid_completion" in item.metrics ? [item.metrics] : []);
    const reviews = completed.flatMap((item) => item.metrics && "decision" in item.metrics ? [item.metrics] : []);
    const valid = prevention.filter((item) => item.valid_completion);
    const violations = valid.filter((item) => item.policy_violation === true).length;
    const accepted = reviews.filter((item) => item.precise && item.decision.startsWith("accepted")).length;
    const reviewerHours = reviews.reduce((sum, item) => sum + item.duration_ms, 0) / 3_600_000;
    const measuredFollowups = assigned.flatMap((item) => followupByAssignment.get(item.id) ?? []);
    return {
      arm,
      assigned: assigned.length,
      terminal: terminal.length,
      infrastructure_failures: terminal.filter((item) => item.status === "infrastructure_failure").length,
      invalid_or_refused: terminal.filter((item) => item.status === "invalid_completion" || item.status === "refused").length,
      valid_completions: run.experiment === "EXP-01" ? valid.length : completed.length,
      violations: run.experiment === "EXP-01" ? violations : null,
      violation_rate: run.experiment === "EXP-01" && valid.length ? violations / valid.length : null,
      wilson_95: run.experiment === "EXP-01" ? wilson(violations, valid.length) : null,
      accepted_precise: run.experiment === "EXP-03" ? accepted : null,
      reviewer_hours: run.experiment === "EXP-03" ? reviewerHours : null,
      accepted_per_reviewer_hour: run.experiment === "EXP-03" && reviewerHours ? accepted / reviewerHours : null,
      bootstrap_95: run.experiment === "EXP-03" ? bootstrapReviewerRate(reviews, `${run.seed}:${arm}:reviewer-rate`) : null,
      reversals: run.experiment === "EXP-03" ? measuredFollowups.filter((item) => item.reversed === true).length : null,
      followups_missing: run.experiment === "EXP-03" ? completed.length - measuredFollowups.length : null,
    };
  });
  const caseById = new Map(bank.cases.map((item) => [item.id, item]));
  const stratumKeys = [...new Set(bank.cases.flatMap((item) => Object.keys(item.strata)))].sort();
  const strata: ExperimentReport["strata"] = [];
  for (const key of stratumKeys) {
    const values = [...new Set(bank.cases.map((item) => item.strata[key]).filter((value): value is string => !!value))].sort();
    for (const value of values) {
      for (const arm of armIds) {
        const assigned = run.assignments.filter((assignment) => assignment.arm === arm && caseById.get(assignment.case_id)?.strata[key] === value);
        const terminal = assigned.flatMap((assignment) => outcomeByAssignment.get(assignment.id) ?? []);
        const completed = terminal.filter((outcome) => outcome.status === "completed");
        const prevention = completed.flatMap((outcome) => outcome.metrics && "valid_completion" in outcome.metrics ? [outcome.metrics] : []);
        const reviews = completed.flatMap((outcome) => outcome.metrics && "decision" in outcome.metrics ? [outcome.metrics] : []);
        const valid = prevention.filter((metrics) => metrics.valid_completion);
        strata.push({
          key,
          value,
          arm,
          assigned: assigned.length,
          terminal: terminal.length,
          valid_completions: run.experiment === "EXP-01" ? valid.length : completed.length,
          violations: run.experiment === "EXP-01" ? valid.filter((metrics) => metrics.policy_violation === true).length : null,
          accepted_precise: run.experiment === "EXP-03" ? reviews.filter((metrics) => metrics.precise && metrics.decision.startsWith("accepted")).length : null,
          reviewer_ms: run.experiment === "EXP-03" ? reviews.reduce((sum, metrics) => sum + metrics.duration_ms, 0) : null,
        });
      }
    }
  }
  const terminal = currentOutcomes.length;
  const allTerminal = terminal === run.assignments.length;
  const exp03Completed = currentOutcomes.filter((item) => item.status === "completed").length;
  const followupsComplete = run.experiment !== "EXP-03" || validFollowups.length === exp03Completed;
  const substitutions = currentOutcomes.filter((item) => item.metrics && "silent_semantic_substitution" in item.metrics && item.metrics.silent_semantic_substitution).length;
  const privateLeaks = currentOutcomes.filter((item) => item.incidents.confirmed_private_leak).length;
  const corruption = currentOutcomes.filter((item) => item.incidents.data_loss_or_corruption).length;
  const unsafeEvaluator = currentOutcomes.filter((item) => item.incidents.unsafe_evaluator_behavior).length;
  const guardrailStopped = substitutions + privateLeaks + corruption + unsafeEvaluator > 0 || runStops.length > 0;
  const status = guardrailStopped ? "guardrail_stopped" as const : !terminal ? "registered" as const : !allTerminal ? "running" as const : !followupsComplete ? "awaiting_followup" as const : "completed" as const;
  const unresolved = run.assignments.filter((item) => !outcomeByAssignment.has(item.id)).map((item) => item.id);
  const byArm = new Map(arms.map((item) => [item.arm, item]));
  const a = byArm.get("A");
  const b = byArm.get("B");
  const c = byArm.get("C");
  const contrasts: Record<string, number | null> = run.experiment === "EXP-01" ? {
    "C_vs_A_risk_difference": c?.violation_rate != null && a?.violation_rate != null ? c.violation_rate - a.violation_rate : null,
    "C_vs_A_relative_risk": c?.violation_rate != null && a?.violation_rate ? c.violation_rate / a.violation_rate : null,
    "B_vs_A_risk_difference": b?.violation_rate != null && a?.violation_rate != null ? b.violation_rate - a.violation_rate : null,
    "C_vs_B_risk_difference": c?.violation_rate != null && b?.violation_rate != null ? c.violation_rate - b.violation_rate : null,
    "C_vs_A_fisher_exact_p": c?.violations != null && a?.violations != null ? fisherTwoSided(c.violations, c.valid_completions - c.violations, a.violations, a.valid_completions - a.violations) : null,
    "B_vs_A_fisher_exact_p": b?.violations != null && a?.violations != null ? fisherTwoSided(b.violations, b.valid_completions - b.violations, a.violations, a.valid_completions - a.violations) : null,
    "C_vs_B_fisher_exact_p": c?.violations != null && b?.violations != null ? fisherTwoSided(c.violations, c.valid_completions - c.violations, b.violations, b.valid_completions - b.violations) : null,
  } : {
    "C_vs_A_rate_difference": c?.accepted_per_reviewer_hour != null && a?.accepted_per_reviewer_hour != null ? c.accepted_per_reviewer_hour - a.accepted_per_reviewer_hour : null,
    "C_vs_A_rate_ratio": c?.accepted_per_reviewer_hour != null && a?.accepted_per_reviewer_hour ? c.accepted_per_reviewer_hour / a.accepted_per_reviewer_hour : null,
    "B_vs_A_rate_difference": b?.accepted_per_reviewer_hour != null && a?.accepted_per_reviewer_hour != null ? b.accepted_per_reviewer_hour - a.accepted_per_reviewer_hour : null,
    "C_vs_B_rate_difference": c?.accepted_per_reviewer_hour != null && b?.accepted_per_reviewer_hour != null ? c.accepted_per_reviewer_hour - b.accepted_per_reviewer_hour : null,
  };
  const deviations = [
    ...currentOutcomes.filter((item) => item.supersedes).map((item) => `corrected outcome ${item.id} supersedes ${item.supersedes}`),
    ...currentFollowups.filter((item) => item.supersedes).map((item) => `corrected follow-up ${item.id} supersedes ${item.supersedes}`),
    ...currentFollowups.filter((item) => outcomeByAssignment.get(item.assignment_id)?.id !== item.outcome_id).map((item) => `follow-up ${item.id} is stale because its bound initial outcome is no longer current`),
  ];
  const body = {
    run_id: run.id,
    preregistration_hash: run.preregistration_hash,
    case_bank_hash: run.case_bank_hash,
    experiment: run.experiment,
    analysis: { ...EXPERIMENT_ANALYSIS_SPEC, deterministic_hash: EXPERIMENT_ANALYSIS_HASH },
    status,
    arms,
    strata,
    assignments: run.assignments.length,
    terminal,
    unresolved,
    contrasts,
    deviations,
    guardrails: { confirmed_private_leaks: privateLeaks, silent_semantic_substitutions: substitutions, data_loss_or_corruption: corruption, unsafe_evaluator_behavior: unsafeEvaluator },
    stop_receipts: runStops,
    claim_allowed: false as const,
    authority: "none" as const,
  };
  const contentHash = canonicalHash(body);
  return { id: `expreport_${shortHash(contentHash)}`, content_hash: contentHash, ...body };
}

/** Private-only, content-addressed experiment execution ledger. */
export class ExperimentRepository {
  constructor(private readonly store: HunchStore) {}

  private requirePrivate(): string {
    if (!this.store.privateDir) throw new Error("experiment execution requires a configured private overlay");
    return this.store.privateDir;
  }

  private load<T>(dir: string, prefix: string, parse: (raw: unknown) => T): T[] {
    return loadPrivateRecords(this.store.privateDir ? join(this.store.privateDir, dir) : undefined, prefix, parse, dir);
  }

  private put(dir: string, id: string, value: unknown): void {
    const root = join(this.requirePrivate(), dir);
    mkdirSync(root, { recursive: true });
    writeFileAtomic(join(root, `${id}.json`), encode(value));
  }

  listCaseBanks(): ExperimentCaseBank[] {
    return this.load("experiment-case-banks", "expbank_", (raw) => {
      const parsed = ExperimentCaseBankSchema.parse(raw);
      if (experimentCaseBankContentHash(parsed) !== parsed.content_hash || parsed.id !== `expbank_${shortHash(parsed.content_hash)}`) throw new Error(`experiment case bank ${parsed.id} content hash mismatch`);
      return parsed;
    }).sort((a, b) => a.id.localeCompare(b.id));
  }

  putCaseBank(bank: ExperimentCaseBank): ExperimentCaseBank {
    const parsed = ExperimentCaseBankSchema.parse(bank);
    if (experimentCaseBankContentHash(parsed) !== parsed.content_hash || parsed.id !== `expbank_${shortHash(parsed.content_hash)}`) throw new Error(`experiment case bank ${parsed.id} content hash mismatch`);
    if (!this.listCaseBanks().some((item) => item.id === parsed.id)) this.put("experiment-case-banks", parsed.id, parsed);
    return parsed;
  }

  listRuns(): ExperimentRun[] {
    const records = this.load("experiment-runs", "exprun_", (raw) => {
      const parsed = ExperimentRunSchema.parse(raw);
      if (experimentRunContentHash(parsed) !== parsed.content_hash || parsed.id !== `exprun_${shortHash(parsed.content_hash)}`) throw new Error(`experiment run ${parsed.id} content hash mismatch`);
      return parsed;
    }).sort((a, b) => a.id.localeCompare(b.id));
    const banks = new Map(this.listCaseBanks().map((item) => [item.id, item]));
    for (const run of records) {
      const bank = banks.get(run.case_bank_id);
      if (!bank || bank.content_hash !== run.case_bank_hash) throw new Error(`experiment run ${run.id} is missing its exact case bank`);
      for (const assignment of run.assignments) assignmentTreatment(bank, run, assignment);
    }
    return records;
  }

  putRun(run: ExperimentRun): ExperimentRun {
    const parsed = ExperimentRunSchema.parse(run);
    if (experimentRunContentHash(parsed) !== parsed.content_hash || parsed.id !== `exprun_${shortHash(parsed.content_hash)}`) throw new Error(`experiment run ${parsed.id} content hash mismatch`);
    const runs = this.listRuns();
    const incumbent = runs.find((item) => item.preregistration_id === parsed.preregistration_id);
    if (incumbent && incumbent.id !== parsed.id) throw new Error(`preregistration ${parsed.preregistration_id} already has immutable run ${incumbent.id}`);
    if (!incumbent) this.put("experiment-runs", parsed.id, parsed);
    return parsed;
  }

  listOutcomes(): ExperimentOutcome[] {
    const records = this.load("experiment-outcomes", "expout_", (raw) => {
      const parsed = ExperimentOutcomeSchema.parse(raw);
      if (experimentOutcomeContentHash(parsed) !== parsed.content_hash || parsed.id !== `expout_${shortHash(parsed.content_hash)}`) throw new Error(`experiment outcome ${parsed.id} content hash mismatch`);
      return parsed;
    });
    currentExperimentOutcomes(records);
    const runs = new Map(this.listRuns().map((item) => [item.id, item]));
    for (const outcome of records) {
      const run = runs.get(outcome.run_id);
      const assignment = run?.assignments.find((item) => item.id === outcome.assignment_id);
      if (!run || !assignment || outcome.experiment !== run.experiment || outcome.arm !== assignment.arm) throw new Error(`experiment outcome ${outcome.id} has no exact run assignment binding`);
    }
    return records.sort((a, b) => a.id.localeCompare(b.id));
  }

  putOutcome(outcome: ExperimentOutcome): ExperimentOutcome {
    const parsed = ExperimentOutcomeSchema.parse(outcome);
    if (experimentOutcomeContentHash(parsed) !== parsed.content_hash || parsed.id !== `expout_${shortHash(parsed.content_hash)}`) throw new Error(`experiment outcome ${parsed.id} content hash mismatch`);
    const records = this.listOutcomes();
    if (records.some((item) => item.id === parsed.id)) return parsed;
    const current = currentExperimentOutcomes(records).find((item) => item.run_id === parsed.run_id && item.assignment_id === parsed.assignment_id);
    if (current && parsed.supersedes !== current.id) throw new Error(`assignment ${parsed.assignment_id} already has current outcome ${current.id}; corrections must supersede it explicitly`);
    if (!current && parsed.supersedes) throw new Error(`outcome ${parsed.id} supersedes no current assignment outcome`);
    currentExperimentOutcomes([...records, parsed]);
    this.put("experiment-outcomes", parsed.id, parsed);
    return parsed;
  }

  listReviewStarts(): ExperimentReviewStart[] {
    const records = this.load("experiment-review-starts", "expreview_", (raw) => {
      const parsed = ExperimentReviewStartSchema.parse(raw);
      if (experimentReviewStartContentHash(parsed) !== parsed.content_hash || parsed.id !== `expreview_${shortHash(parsed.content_hash)}`) throw new Error(`experiment review start ${parsed.id} content hash mismatch`);
      return parsed;
    }).sort((a, b) => a.id.localeCompare(b.id));
    const runs = new Map(this.listRuns().map((item) => [item.id, item]));
    for (const record of records) {
      const run = runs.get(record.run_id);
      const assignment = run?.assignments.find((item) => item.id === record.assignment_id);
      if (!run || run.experiment !== "EXP-03" || !assignment || assignment.treatment_hash !== record.treatment_hash) throw new Error(`experiment review start ${record.id} has no exact EXP-03 assignment binding`);
    }
    return records;
  }

  putReviewStart(record: ExperimentReviewStart): ExperimentReviewStart {
    const parsed = ExperimentReviewStartSchema.parse(record);
    if (experimentReviewStartContentHash(parsed) !== parsed.content_hash || parsed.id !== `expreview_${shortHash(parsed.content_hash)}`) throw new Error(`experiment review start ${parsed.id} content hash mismatch`);
    const records = this.listReviewStarts();
    const incumbent = records.find((item) => item.run_id === parsed.run_id && item.assignment_id === parsed.assignment_id);
    if (incumbent) {
      if (incumbent.reviewer !== parsed.reviewer) throw new Error(`assignment ${parsed.assignment_id} review already started by ${incumbent.reviewer}`);
      return incumbent;
    }
    const completed = new Set(currentExperimentOutcomes(this.listOutcomes()).map((item) => `${item.run_id}:${item.assignment_id}`));
    const openForReviewer = records.find((item) => item.run_id === parsed.run_id && item.reviewer === parsed.reviewer && !completed.has(`${item.run_id}:${item.assignment_id}`));
    if (openForReviewer) throw new Error(`${parsed.reviewer} already has open review ${openForReviewer.id}; complete it before starting another assignment`);
    this.put("experiment-review-starts", parsed.id, parsed);
    return parsed;
  }

  listFollowups(): ExperimentFollowup[] {
    const records = this.load("experiment-followups", "expfollow_", (raw) => {
      const parsed = ExperimentFollowupSchema.parse(raw);
      if (experimentFollowupContentHash(parsed) !== parsed.content_hash || parsed.id !== `expfollow_${shortHash(parsed.content_hash)}`) throw new Error(`experiment follow-up ${parsed.id} content hash mismatch`);
      return parsed;
    });
    currentExperimentFollowups(records);
    const runs = new Map(this.listRuns().map((item) => [item.id, item]));
    const outcomes = new Map(this.listOutcomes().map((item) => [item.id, item]));
    for (const record of records) {
      const run = runs.get(record.run_id);
      const outcome = outcomes.get(record.outcome_id);
      if (!run || run.experiment !== "EXP-03" || !outcome || outcome.run_id !== run.id || outcome.assignment_id !== record.assignment_id) throw new Error(`experiment follow-up ${record.id} has no exact EXP-03 outcome binding`);
    }
    return records.sort((a, b) => a.id.localeCompare(b.id));
  }

  putFollowup(record: ExperimentFollowup): ExperimentFollowup {
    const parsed = ExperimentFollowupSchema.parse(record);
    if (experimentFollowupContentHash(parsed) !== parsed.content_hash || parsed.id !== `expfollow_${shortHash(parsed.content_hash)}`) throw new Error(`experiment follow-up ${parsed.id} content hash mismatch`);
    const records = this.listFollowups();
    if (records.some((item) => item.id === parsed.id)) return parsed;
    const current = currentExperimentFollowups(records).find((item) => item.run_id === parsed.run_id && item.assignment_id === parsed.assignment_id);
    if (current && parsed.supersedes !== current.id) throw new Error(`assignment ${parsed.assignment_id} already has current follow-up ${current.id}`);
    if (!current && parsed.supersedes) throw new Error(`follow-up ${parsed.id} supersedes no current record`);
    currentExperimentFollowups([...records, parsed]);
    this.put("experiment-followups", parsed.id, parsed);
    return parsed;
  }

  listStops(): ExperimentStop[] {
    const records = this.load("experiment-stops", "expstop_", (raw) => {
      const parsed = ExperimentStopSchema.parse(raw);
      if (experimentStopContentHash(parsed) !== parsed.content_hash || parsed.id !== `expstop_${shortHash(parsed.content_hash)}`) throw new Error(`experiment stop ${parsed.id} content hash mismatch`);
      return parsed;
    }).sort((a, b) => a.id.localeCompare(b.id));
    const runIds = new Set(this.listRuns().map((item) => item.id));
    for (const record of records) if (!runIds.has(record.run_id)) throw new Error(`experiment stop ${record.id} has no exact run binding`);
    return records;
  }

  putStop(record: ExperimentStop): ExperimentStop {
    const parsed = ExperimentStopSchema.parse(record);
    if (experimentStopContentHash(parsed) !== parsed.content_hash || parsed.id !== `expstop_${shortHash(parsed.content_hash)}`) throw new Error(`experiment stop ${parsed.id} content hash mismatch`);
    const incumbent = this.listStops().find((item) => item.run_id === parsed.run_id);
    if (incumbent) {
      if (incumbent.id !== parsed.id) throw new Error(`run ${parsed.run_id} is already irreversibly stopped by ${incumbent.id}`);
      return incumbent;
    }
    this.put("experiment-stops", parsed.id, parsed);
    return parsed;
  }
}
