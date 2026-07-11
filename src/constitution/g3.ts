import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../core/io.js";
import { shortHash } from "../core/ids.js";
import type { HunchStore } from "../store/hunchStore.js";
import { canonicalHash } from "./canonical.js";
import { currentAppendOnly, loadPrivateRecords, type G2ReadinessReport } from "./g2.js";

const HASH = /^sha1:[a-f0-9]{40}$/;
const HUMAN_ACTOR = /^(human|github|git):[^\s]+$/i;
const POLICY_ID = /^pol_[a-f0-9]{10}$/;
const CLIENT_ID = /^[a-z][a-z0-9_-]{1,63}$/;
const encode = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const G3_REQUIRED_EXPERIMENTS = ["EXP-01", "EXP-03"] as const;
export type G3RequiredExperiment = (typeof G3_REQUIRED_EXPERIMENTS)[number];

const ExperimentBindingsSchema = z.object({
  retrieval: z.string().regex(/^expreg_[a-f0-9]{10}$/),
  compiler: z.string().regex(/^expreg_[a-f0-9]{10}$/),
}).strict();

export const G3PlanSchema = z.object({
  id: z.string().regex(/^g3plan_[a-f0-9]{10}$/),
  content_hash: z.string().regex(HASH),
  gate: z.literal("G3"),
  g2_readiness_hash: z.string().regex(HASH),
  policy_ids: z.array(z.string().regex(POLICY_ID)).min(3, "G3 requires at least 3 selected policies"),
  clients: z.array(z.string().regex(CLIENT_ID)).min(3, "G3 requires at least 3 selected clients"),
  experiments: ExperimentBindingsSchema,
  actor: z.string().regex(HUMAN_ACTOR, "G3 plan requires an explicit human actor (human:, github:, or git:)"),
  reason: z.string().trim().min(1).max(2000),
  supersedes: z.string().regex(/^g3plan_[a-f0-9]{10}$/).nullable(),
  data_class: z.literal("private"),
  authority: z.literal("none"),
  created_at: z.string().datetime({ offset: true }),
}).strict().superRefine((plan, ctx) => {
  if (new Set(plan.policy_ids).size !== plan.policy_ids.length) {
    ctx.addIssue({ code: "custom", path: ["policy_ids"], message: "G3 policy ids must be unique" });
  }
  if (new Set(plan.clients).size !== plan.clients.length) {
    ctx.addIssue({ code: "custom", path: ["clients"], message: "G3 client ids must be unique" });
  }
  if (plan.experiments.retrieval === plan.experiments.compiler) {
    ctx.addIssue({ code: "custom", path: ["experiments"], message: "G3 retrieval and compiler experiments must be distinct records" });
  }
});
export type G3Plan = z.infer<typeof G3PlanSchema>;

export interface CompileG3PlanInput {
  g2_readiness_hash: string;
  policy_ids: string[];
  clients: string[];
  experiments: { retrieval: string; compiler: string };
  actor: string;
  reason: string;
  supersedes?: string | null;
}

export function g3PlanContentHash(plan: G3Plan): string {
  const { id: _id, content_hash: _hash, ...body } = plan;
  return canonicalHash(body);
}

export function compileG3Plan(input: CompileG3PlanInput, opts: { now?: string } = {}): G3Plan {
  const body = {
    gate: "G3" as const,
    g2_readiness_hash: input.g2_readiness_hash,
    policy_ids: [...input.policy_ids].sort(),
    clients: [...input.clients].sort(),
    experiments: { retrieval: input.experiments.retrieval, compiler: input.experiments.compiler },
    actor: input.actor,
    reason: input.reason.trim(),
    supersedes: input.supersedes ?? null,
    data_class: "private" as const,
    authority: "none" as const,
    created_at: opts.now ?? new Date().toISOString(),
  };
  const contentHash = canonicalHash(body);
  return G3PlanSchema.parse({ id: `g3plan_${shortHash(contentHash)}`, content_hash: contentHash, ...body });
}

const ExperimentArmSchema = z.object({
  id: z.string().regex(/^[A-Z][A-Z0-9_-]{0,15}$/),
  description: z.string().trim().min(1).max(2000),
}).strict();

const ExperimentAssignmentSchema = z.object({
  method: z.enum(["randomized", "blocked_randomized", "paired_randomized"]),
  unit: z.enum(["task", "pull_request", "repository", "developer", "policy_candidate"]),
  seed: z.string().trim().min(1).max(256),
}).strict();

const ExperimentSamplePlanSchema = z.object({
  minimum_per_arm: z.number().int().min(1).max(100000),
  target_per_arm: z.number().int().min(1).max(100000),
  maximum_total: z.number().int().min(2).max(1000000),
  rationale: z.string().trim().min(1).max(4000),
}).strict().superRefine((plan, ctx) => {
  if (plan.target_per_arm < plan.minimum_per_arm) {
    ctx.addIssue({ code: "custom", path: ["target_per_arm"], message: "target_per_arm cannot be below minimum_per_arm" });
  }
});

const ExperimentAnalysisPlanSchema = z.object({
  primary_estimator: z.string().trim().min(1).max(2000),
  effect_size: z.string().trim().min(1).max(2000),
  uncertainty: z.string().trim().min(1).max(2000),
  missing_data: z.string().trim().min(1).max(2000),
  multiple_metrics: z.string().trim().min(1).max(2000),
}).strict();

export const ExperimentPreregistrationSchema = z.object({
  id: z.string().regex(/^expreg_[a-f0-9]{10}$/),
  content_hash: z.string().regex(HASH),
  experiment: z.enum(G3_REQUIRED_EXPERIMENTS),
  revision: z.number().int().min(1),
  hypothesis: z.string().trim().min(1).max(4000),
  primary_metric: z.string().trim().min(1).max(2000),
  secondary_metrics: z.array(z.string().trim().min(1).max(2000)).min(1),
  unit: z.enum(["task", "pull_request", "repository", "developer", "policy_candidate"]),
  arms: z.array(ExperimentArmSchema).min(2).max(16),
  assignment: ExperimentAssignmentSchema,
  strata: z.array(z.string().trim().min(1).max(500)).min(1),
  inclusion: z.array(z.string().trim().min(1).max(1000)).min(1),
  exclusion: z.array(z.string().trim().min(1).max(1000)).min(1),
  sample_plan: ExperimentSamplePlanSchema,
  analysis_plan: ExperimentAnalysisPlanSchema,
  stopping_rule: z.string().trim().min(1).max(4000),
  guardrails: z.array(z.string().trim().min(1).max(1000)).min(1),
  privacy_class: z.literal("private"),
  status: z.literal("registered"),
  actor: z.string().regex(HUMAN_ACTOR, "experiment preregistration requires an explicit human actor"),
  reason: z.string().trim().min(1).max(2000),
  supersedes: z.string().regex(/^expreg_[a-f0-9]{10}$/).nullable(),
  authority: z.literal("none"),
  registered_at: z.string().datetime({ offset: true }),
}).strict().superRefine((spec, ctx) => {
  const armIds = spec.arms.map((arm) => arm.id);
  if (new Set(armIds).size !== armIds.length) ctx.addIssue({ code: "custom", path: ["arms"], message: "experiment arm ids must be unique" });
  if (spec.assignment.unit !== spec.unit) ctx.addIssue({ code: "custom", path: ["assignment", "unit"], message: "assignment unit must equal the experiment unit" });
  if (spec.sample_plan.maximum_total < spec.sample_plan.target_per_arm * spec.arms.length) {
    ctx.addIssue({ code: "custom", path: ["sample_plan", "maximum_total"], message: "maximum_total cannot be below target_per_arm multiplied by arm count" });
  }
});
export type ExperimentPreregistration = z.infer<typeof ExperimentPreregistrationSchema>;

export type CompileExperimentPreregistrationInput = Omit<ExperimentPreregistration,
  "id" | "content_hash" | "revision" | "privacy_class" | "status" | "authority" | "registered_at"> & {
    revision?: number;
  };

export function experimentPreregistrationContentHash(spec: ExperimentPreregistration): string {
  const { id: _id, content_hash: _hash, ...body } = spec;
  return canonicalHash(body);
}

export function compileExperimentPreregistration(
  input: CompileExperimentPreregistrationInput,
  opts: { now?: string } = {},
): ExperimentPreregistration {
  const body = {
    experiment: input.experiment,
    revision: input.revision ?? 1,
    hypothesis: input.hypothesis.trim(),
    primary_metric: input.primary_metric.trim(),
    secondary_metrics: [...input.secondary_metrics],
    unit: input.unit,
    arms: input.arms.map((arm) => ({ id: arm.id, description: arm.description.trim() })),
    assignment: { ...input.assignment },
    strata: [...input.strata],
    inclusion: [...input.inclusion],
    exclusion: [...input.exclusion],
    sample_plan: { ...input.sample_plan },
    analysis_plan: { ...input.analysis_plan },
    stopping_rule: input.stopping_rule.trim(),
    guardrails: [...input.guardrails],
    privacy_class: "private" as const,
    status: "registered" as const,
    actor: input.actor,
    reason: input.reason.trim(),
    supersedes: input.supersedes ?? null,
    authority: "none" as const,
    registered_at: opts.now ?? new Date().toISOString(),
  };
  const contentHash = canonicalHash(body);
  return ExperimentPreregistrationSchema.parse({ id: `expreg_${shortHash(contentHash)}`, content_hash: contentHash, ...body });
}

const ComprehensionSchema = z.object({
  requirement: z.enum(["correct", "incorrect"]),
  limitations: z.enum(["correct", "incorrect"]),
  authority: z.enum(["correct", "incorrect"]),
}).strict();

export const ProofReviewMeasurementSchema = z.object({
  id: z.string().regex(/^proofreview_[a-f0-9]{10}$/),
  content_hash: z.string().regex(HASH),
  plan_id: z.string().regex(/^g3plan_[a-f0-9]{10}$/),
  policy_id: z.string().regex(POLICY_ID),
  policy_hash: z.string().regex(HASH),
  proof_id: z.string().min(1),
  proof_hash: z.string().regex(HASH),
  card_hash: z.string().regex(HASH),
  reviewer: z.string().regex(HUMAN_ACTOR, "proof review requires an explicit human reviewer"),
  duration_ms: z.number().int().min(1000).max(14_400_000),
  comprehension: ComprehensionSchema,
  notes: z.string().trim().min(1).max(4000),
  supersedes: z.string().regex(/^proofreview_[a-f0-9]{10}$/).nullable(),
  data_class: z.literal("private"),
  authority: z.literal("none"),
  measured_at: z.string().datetime({ offset: true }),
}).strict();
export type ProofReviewMeasurement = z.infer<typeof ProofReviewMeasurementSchema>;

export interface CompileProofReviewMeasurementInput {
  plan_id: string;
  policy_id: string;
  policy_hash: string;
  proof_id: string;
  proof_hash: string;
  card_hash: string;
  reviewer: string;
  duration_ms: number;
  comprehension: z.infer<typeof ComprehensionSchema>;
  notes: string;
  supersedes?: string | null;
}

export function proofReviewMeasurementContentHash(record: ProofReviewMeasurement): string {
  const { id: _id, content_hash: _hash, ...body } = record;
  return canonicalHash(body);
}

export function compileProofReviewMeasurement(
  input: CompileProofReviewMeasurementInput,
  opts: { now?: string } = {},
): ProofReviewMeasurement {
  const body = {
    plan_id: input.plan_id,
    policy_id: input.policy_id,
    policy_hash: input.policy_hash,
    proof_id: input.proof_id,
    proof_hash: input.proof_hash,
    card_hash: input.card_hash,
    reviewer: input.reviewer,
    duration_ms: input.duration_ms,
    comprehension: { ...input.comprehension },
    notes: input.notes.trim(),
    supersedes: input.supersedes ?? null,
    data_class: "private" as const,
    authority: "none" as const,
    measured_at: opts.now ?? new Date().toISOString(),
  };
  const contentHash = canonicalHash(body);
  return ProofReviewMeasurementSchema.parse({ id: `proofreview_${shortHash(contentHash)}`, content_hash: contentHash, ...body });
}

export const AdapterConformanceReceiptSchema = z.object({
  id: z.string().regex(/^g3conformance_[a-f0-9]{10}$/),
  content_hash: z.string().regex(HASH),
  plan_id: z.string().regex(/^g3plan_[a-f0-9]{10}$/),
  clients: z.array(z.string().regex(CLIENT_ID)).min(3),
  test: z.object({ file: z.string().min(1), name: z.string().min(1), source_hash: z.string().regex(HASH) }).strict(),
  runner: z.object({ name: z.literal("node-test-tsx"), isolation_flag: z.string().min(1) }).strict(),
  result: z.enum(["passed", "failed", "error"]),
  exit_code: z.number().int().nullable(),
  selected_event: z.enum(["passed", "failed"]).nullable(),
  verdict_agreement: z.number().min(0).max(1).nullable(),
  confirmed_private_leaks: z.number().int().min(0).nullable(),
  error_code: z.string().min(1).optional(),
  log_hash: z.string().regex(HASH),
  supersedes: z.string().regex(/^g3conformance_[a-f0-9]{10}$/).nullable(),
  data_class: z.literal("private"),
  authority: z.literal("none"),
  effects: z.literal("diagnostic_only"),
  writes: z.literal("evidence_receipt_only"),
  executed_at: z.string().datetime({ offset: true }),
}).strict().superRefine((receipt, ctx) => {
  if (new Set(receipt.clients).size !== receipt.clients.length) ctx.addIssue({ code: "custom", path: ["clients"], message: "conformance client ids must be unique" });
  if (receipt.result === "passed" && (receipt.verdict_agreement !== 1 || receipt.confirmed_private_leaks !== 0)) {
    ctx.addIssue({ code: "custom", message: "passed conformance requires exact verdict agreement and zero confirmed private leaks" });
  }
  if (receipt.result !== "passed" && (receipt.verdict_agreement !== null || receipt.confirmed_private_leaks !== null)) {
    ctx.addIssue({ code: "custom", message: "failed/error conformance cannot claim agreement or privacy results" });
  }
});
export type AdapterConformanceReceipt = z.infer<typeof AdapterConformanceReceiptSchema>;

export function adapterConformanceContentHash(receipt: AdapterConformanceReceipt): string {
  const { id: _id, content_hash: _hash, ...body } = receipt;
  return canonicalHash(body);
}

export function compileAdapterConformanceReceipt(
  input: Omit<AdapterConformanceReceipt, "id" | "content_hash" | "data_class" | "authority" | "effects" | "writes" | "executed_at">,
  opts: { now?: string } = {},
): AdapterConformanceReceipt {
  const body = {
    plan_id: input.plan_id,
    clients: [...input.clients].sort(),
    test: { ...input.test },
    runner: { ...input.runner },
    result: input.result,
    exit_code: input.exit_code,
    selected_event: input.selected_event,
    verdict_agreement: input.verdict_agreement,
    confirmed_private_leaks: input.confirmed_private_leaks,
    ...(input.error_code ? { error_code: input.error_code } : {}),
    log_hash: input.log_hash,
    supersedes: input.supersedes,
    data_class: "private" as const,
    authority: "none" as const,
    effects: "diagnostic_only" as const,
    writes: "evidence_receipt_only" as const,
    executed_at: opts.now ?? new Date().toISOString(),
  };
  const contentHash = canonicalHash(body);
  return AdapterConformanceReceiptSchema.parse({ id: `g3conformance_${shortHash(contentHash)}`, content_hash: contentHash, ...body });
}

export function currentG3Plans(records: G3Plan[]): G3Plan[] {
  return currentAppendOnly(records.map((record) => G3PlanSchema.parse(record)), "G3 plan", () => "G3", true);
}

export function currentExperimentPreregistrations(records: ExperimentPreregistration[]): ExperimentPreregistration[] {
  return currentAppendOnly(records.map((record) => ExperimentPreregistrationSchema.parse(record)), "experiment preregistration", (record) => record.experiment);
}

export function currentProofReviewMeasurements(records: ProofReviewMeasurement[]): ProofReviewMeasurement[] {
  return currentAppendOnly(records.map((record) => ProofReviewMeasurementSchema.parse(record)), "proof review measurement", (record) => `${record.plan_id}:${record.policy_id}:${record.reviewer}`);
}

export function currentAdapterConformanceReceipts(records: AdapterConformanceReceipt[]): AdapterConformanceReceipt[] {
  return currentAppendOnly(records.map((record) => AdapterConformanceReceiptSchema.parse(record)), "adapter conformance receipt", (record) => record.plan_id);
}

export type ScoreBand = "green" | "yellow" | "red" | "unmeasured";

export interface G3Scorecard {
  median_review_burden_ms: { value: number | null; band: ScoreBand };
  proof_comprehension: { correct: number; total: number; rate: number | null; band: ScoreBand };
  required_client_verdict_agreement: { value: number | null; band: ScoreBand };
  current_proof_rate: { current: number; selected: number; value: number | null; band: ScoreBand };
  confirmed_private_leaks: { value: number | null; band: ScoreBand };
  overall: ScoreBand;
}

export interface G3PolicyEvidence {
  policy_id: string;
  state: string | null;
  authority_kind: string | null;
  proof_current: boolean;
  card_hash: string | null;
  review_id: string | null;
  review_duration_ms: number | null;
  comprehension_correct: boolean | null;
  reasons: string[];
}

export interface G3ReadinessReport {
  id: string;
  content_hash: string;
  gate: "G3";
  manifest: G3Plan | null;
  g2_readiness: { id: string; content_hash: string; recommendation: string };
  policy_evidence: G3PolicyEvidence[];
  experiments: Array<{ experiment: G3RequiredExperiment; id: string | null; content_hash: string | null; current: boolean; reasons: string[] }>;
  conformance: AdapterConformanceReceipt | null;
  scorecard: G3Scorecard;
  active_blocking_policy_ids: string[];
  blockers: string[];
  recommendation: "not_ready" | "eligible_for_human_g3_signoff";
  authority: "none";
  g3_passed: false;
}

export interface ScoreG3ReadinessInput {
  manifest: G3Plan | null;
  g2_readiness: G2ReadinessReport;
  policy_evidence: G3PolicyEvidence[];
  experiments: G3ReadinessReport["experiments"];
  conformance: AdapterConformanceReceipt | null;
  active_blocking_policy_ids: string[];
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function overallBand(bands: ScoreBand[]): ScoreBand {
  if (bands.includes("red")) return "red";
  if (bands.includes("unmeasured")) return "unmeasured";
  if (bands.includes("yellow")) return "yellow";
  return "green";
}

export function scoreG3Readiness(input: ScoreG3ReadinessInput): G3ReadinessReport {
  const blockers: string[] = [];
  if (!input.manifest) blockers.push("No current private G3 evidence plan exists; a human must select the exact G2 policies, three or more clients, and preregistrations.");
  if (input.g2_readiness.recommendation !== "eligible_for_human_g2_signoff") blockers.push(`G2 evidence is not currently eligible (${input.g2_readiness.id}).`);
  if (input.manifest && input.manifest.g2_readiness_hash !== input.g2_readiness.content_hash) blockers.push("G3 plan does not bind the exact current G2 readiness receipt.");
  if (input.manifest && input.policy_evidence.length !== input.manifest.policy_ids.length) blockers.push(`Selected G3 policy evidence is incomplete (${input.policy_evidence.length}/${input.manifest.policy_ids.length}).`);
  for (const evidence of input.policy_evidence) for (const reason of evidence.reasons) blockers.push(`${evidence.policy_id}: ${reason}`);
  for (const experiment of input.experiments) for (const reason of experiment.reasons) blockers.push(`${experiment.experiment}: ${reason}`);
  if (input.experiments.length !== G3_REQUIRED_EXPERIMENTS.length) blockers.push(`Experiment evidence is incomplete (${input.experiments.length}/${G3_REQUIRED_EXPERIMENTS.length}).`);
  if (!input.conformance) blockers.push("The exact current G3 plan has no adapter-conformance receipt.");
  else {
    if (input.conformance.result !== "passed") blockers.push(`Adapter conformance result is ${input.conformance.result}.`);
    if (input.manifest && input.conformance.plan_id !== input.manifest.id) blockers.push("Adapter conformance is not bound to the current G3 plan.");
    if (input.manifest && canonicalHash([...input.conformance.clients].sort()) !== canonicalHash([...input.manifest.clients].sort())) blockers.push("Adapter conformance client set differs from the human-selected G3 client set.");
  }
  const activeBlocking = [...new Set(input.active_blocking_policy_ids)].sort();
  if (activeBlocking.length) blockers.push(`Blocking behavior must remain disabled for G3; active blocking policies: ${activeBlocking.join(", ")}.`);

  const durations = input.policy_evidence.flatMap((item) => item.review_duration_ms == null ? [] : [item.review_duration_ms]);
  const medianMs = median(durations);
  const reviewBand: ScoreBand = medianMs == null ? "unmeasured" : medianMs <= 300_000 ? "green" : medianMs <= 900_000 ? "yellow" : "red";
  const comprehension = input.policy_evidence.flatMap((item) => item.comprehension_correct == null ? [] : [item.comprehension_correct]);
  const comprehensionCorrect = comprehension.filter(Boolean).length;
  const comprehensionRate = comprehension.length ? comprehensionCorrect / comprehension.length : null;
  const comprehensionBand: ScoreBand = comprehensionRate == null ? "unmeasured" : comprehensionRate === 1 ? "green" : "red";
  const agreement = input.conformance?.verdict_agreement ?? null;
  const agreementBand: ScoreBand = agreement == null ? "unmeasured" : agreement === 1 ? "green" : agreement >= 0.99 ? "yellow" : "red";
  const currentProofs = input.policy_evidence.filter((item) => item.proof_current).length;
  const proofRate = input.policy_evidence.length ? currentProofs / input.policy_evidence.length : null;
  const proofBand: ScoreBand = proofRate == null ? "unmeasured" : proofRate >= 0.95 ? "green" : proofRate >= 0.85 ? "yellow" : "red";
  const leaks = input.conformance?.confirmed_private_leaks ?? null;
  const privacyBand: ScoreBand = leaks == null ? "unmeasured" : leaks === 0 ? "green" : "red";
  const overall = overallBand([reviewBand, comprehensionBand, agreementBand, proofBand, privacyBand]);
  if (reviewBand === "red") blockers.push("Median proof-card review burden exceeds the 15-minute red threshold.");
  if (reviewBand === "unmeasured") blockers.push("Proof-card review burden is not measured for the selected policy set.");
  if (comprehensionBand === "red") blockers.push("At least one proof-card comprehension measurement is incorrect.");
  if (comprehensionBand === "unmeasured") blockers.push("Proof-card comprehension is not measured for the selected policy set.");
  if (agreementBand === "red" || agreementBand === "unmeasured") blockers.push("Required-client verdict agreement is not measured at the G3 threshold.");
  if (proofBand === "red" || proofBand === "unmeasured") blockers.push("Current-proof coverage is below the G3 scorecard threshold.");
  if (privacyBand !== "green") blockers.push("The privacy red line is not cleared by an exact zero-leak conformance result.");
  if (overall === "red" || overall === "unmeasured") blockers.push(`G3 scorecard is ${overall}; only green/yellow is eligible.`);
  const uniqueBlockers = [...new Set(blockers)];
  const body = {
    gate: "G3" as const,
    manifest: input.manifest,
    g2_readiness: { id: input.g2_readiness.id, content_hash: input.g2_readiness.content_hash, recommendation: input.g2_readiness.recommendation },
    policy_evidence: [...input.policy_evidence].sort((a, b) => a.policy_id.localeCompare(b.policy_id)),
    experiments: [...input.experiments].sort((a, b) => a.experiment.localeCompare(b.experiment)),
    conformance: input.conformance,
    scorecard: {
      median_review_burden_ms: { value: medianMs, band: reviewBand },
      proof_comprehension: { correct: comprehensionCorrect, total: comprehension.length, rate: comprehensionRate, band: comprehensionBand },
      required_client_verdict_agreement: { value: agreement, band: agreementBand },
      current_proof_rate: { current: currentProofs, selected: input.policy_evidence.length, value: proofRate, band: proofBand },
      confirmed_private_leaks: { value: leaks, band: privacyBand },
      overall,
    },
    active_blocking_policy_ids: activeBlocking,
    blockers: uniqueBlockers,
    recommendation: uniqueBlockers.length ? "not_ready" as const : "eligible_for_human_g3_signoff" as const,
    authority: "none" as const,
    g3_passed: false as const,
  };
  const contentHash = canonicalHash(body);
  return { id: `g3readiness_${shortHash(contentHash)}`, content_hash: contentHash, ...body };
}

/** Private-only append-only storage for G3 plans, preregistrations, measurements, and conformance. */
export class G3EvidenceRepository {
  constructor(private readonly store: HunchStore) {}

  private requirePrivate(): string {
    if (!this.store.privateDir) throw new Error("No private Hunch overlay is configured; refusing to write G3 evidence.");
    return this.store.privateDir;
  }

  listPlans(): G3Plan[] {
    const records = loadPrivateRecords(this.store.privateDir ? join(this.store.privateDir, "gates") : undefined, "g3plan_", (raw) => {
      const parsed = G3PlanSchema.parse(raw);
      if (parsed.content_hash !== g3PlanContentHash(parsed) || parsed.id !== `g3plan_${shortHash(parsed.content_hash)}`) throw new Error(`G3 plan ${parsed.id} content hash mismatch`);
      return parsed;
    }, "gates");
    currentG3Plans(records);
    return records.sort((a, b) => a.id.localeCompare(b.id));
  }

  currentPlan(): G3Plan | null { return currentG3Plans(this.listPlans())[0] ?? null; }

  putPlan(plan: G3Plan): G3Plan {
    const parsed = G3PlanSchema.parse(plan);
    if (parsed.content_hash !== g3PlanContentHash(parsed) || parsed.id !== `g3plan_${shortHash(parsed.content_hash)}`) throw new Error(`G3 plan ${parsed.id} content hash mismatch`);
    const records = this.listPlans();
    const existing = records.find((record) => record.id === parsed.id);
    if (existing) return existing;
    const current = currentG3Plans(records)[0];
    if (current && parsed.supersedes !== current.id) throw new Error(`G3 plan ${current.id} is current; pass supersedes:${current.id} to append a correction`);
    if (!current && parsed.supersedes) throw new Error(`G3 plan ${parsed.id} supersedes no current plan`);
    currentG3Plans([...records, parsed]);
    const dir = join(this.requirePrivate(), "gates");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }

  listExperiments(): ExperimentPreregistration[] {
    const records = loadPrivateRecords(this.store.privateDir ? join(this.store.privateDir, "experiments") : undefined, "expreg_", (raw) => {
      const parsed = ExperimentPreregistrationSchema.parse(raw);
      if (parsed.content_hash !== experimentPreregistrationContentHash(parsed) || parsed.id !== `expreg_${shortHash(parsed.content_hash)}`) throw new Error(`experiment preregistration ${parsed.id} content hash mismatch`);
      return parsed;
    }, "experiments");
    currentExperimentPreregistrations(records);
    return records.sort((a, b) => a.id.localeCompare(b.id));
  }

  currentExperiments(): ExperimentPreregistration[] { return currentExperimentPreregistrations(this.listExperiments()); }

  putExperiment(spec: ExperimentPreregistration): ExperimentPreregistration {
    const parsed = ExperimentPreregistrationSchema.parse(spec);
    if (parsed.content_hash !== experimentPreregistrationContentHash(parsed) || parsed.id !== `expreg_${shortHash(parsed.content_hash)}`) throw new Error(`experiment preregistration ${parsed.id} content hash mismatch`);
    const records = this.listExperiments();
    const existing = records.find((record) => record.id === parsed.id);
    if (existing) return existing;
    const current = currentExperimentPreregistrations(records).find((record) => record.experiment === parsed.experiment);
    if (current && parsed.supersedes !== current.id) throw new Error(`${parsed.experiment} preregistration ${current.id} is current; pass supersedes:${current.id} to append a correction`);
    if (!current && parsed.supersedes) throw new Error(`${parsed.experiment} preregistration ${parsed.id} supersedes no current record`);
    if (current && parsed.revision !== current.revision + 1) throw new Error(`${parsed.experiment} correction revision must be ${current.revision + 1}`);
    currentExperimentPreregistrations([...records, parsed]);
    const dir = join(this.requirePrivate(), "experiments");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }

  listReviews(): ProofReviewMeasurement[] {
    const records = loadPrivateRecords(this.store.privateDir ? join(this.store.privateDir, "proof-reviews") : undefined, "proofreview_", (raw) => {
      const parsed = ProofReviewMeasurementSchema.parse(raw);
      if (parsed.content_hash !== proofReviewMeasurementContentHash(parsed) || parsed.id !== `proofreview_${shortHash(parsed.content_hash)}`) throw new Error(`proof review ${parsed.id} content hash mismatch`);
      return parsed;
    }, "proof-reviews");
    currentProofReviewMeasurements(records);
    return records.sort((a, b) => a.id.localeCompare(b.id));
  }

  currentReviews(): ProofReviewMeasurement[] { return currentProofReviewMeasurements(this.listReviews()); }

  putReview(review: ProofReviewMeasurement): ProofReviewMeasurement {
    const parsed = ProofReviewMeasurementSchema.parse(review);
    if (parsed.content_hash !== proofReviewMeasurementContentHash(parsed) || parsed.id !== `proofreview_${shortHash(parsed.content_hash)}`) throw new Error(`proof review ${parsed.id} content hash mismatch`);
    const records = this.listReviews();
    const existing = records.find((record) => record.id === parsed.id);
    if (existing) return existing;
    const identity = `${parsed.plan_id}:${parsed.policy_id}:${parsed.reviewer}`;
    const current = currentProofReviewMeasurements(records).find((record) => `${record.plan_id}:${record.policy_id}:${record.reviewer}` === identity);
    if (current && parsed.supersedes !== current.id) throw new Error(`proof review ${current.id} is current for this plan, policy, and reviewer; pass supersedes:${current.id} to append a correction`);
    if (!current && parsed.supersedes) throw new Error(`proof review ${parsed.id} supersedes no current measurement`);
    currentProofReviewMeasurements([...records, parsed]);
    const dir = join(this.requirePrivate(), "proof-reviews");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }

  listConformance(): AdapterConformanceReceipt[] {
    const records = loadPrivateRecords(this.store.privateDir ? join(this.store.privateDir, "adapter-conformance") : undefined, "g3conformance_", (raw) => {
      const parsed = AdapterConformanceReceiptSchema.parse(raw);
      if (parsed.content_hash !== adapterConformanceContentHash(parsed) || parsed.id !== `g3conformance_${shortHash(parsed.content_hash)}`) throw new Error(`adapter conformance ${parsed.id} content hash mismatch`);
      return parsed;
    }, "adapter-conformance");
    currentAdapterConformanceReceipts(records);
    return records.sort((a, b) => a.id.localeCompare(b.id));
  }

  currentConformance(): AdapterConformanceReceipt[] { return currentAdapterConformanceReceipts(this.listConformance()); }

  putConformance(receipt: AdapterConformanceReceipt): AdapterConformanceReceipt {
    const parsed = AdapterConformanceReceiptSchema.parse(receipt);
    if (parsed.content_hash !== adapterConformanceContentHash(parsed) || parsed.id !== `g3conformance_${shortHash(parsed.content_hash)}`) throw new Error(`adapter conformance ${parsed.id} content hash mismatch`);
    const records = this.listConformance();
    const existing = records.find((record) => record.id === parsed.id);
    if (existing) return existing;
    const current = currentAdapterConformanceReceipts(records).find((record) => record.plan_id === parsed.plan_id);
    if (current && parsed.supersedes !== current.id) throw new Error(`adapter conformance ${current.id} is current for plan ${parsed.plan_id}; pass supersedes:${current.id} to append a correction`);
    if (!current && parsed.supersedes) throw new Error(`adapter conformance ${parsed.id} supersedes no current receipt`);
    currentAdapterConformanceReceipts([...records, parsed]);
    const dir = join(this.requirePrivate(), "adapter-conformance");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }
}
