import { shortHash } from "../core/ids.js";
import { canonicalHash } from "./canonical.js";
import { assessHistoryDispositions } from "./disposition.js";
import {
  HistoryDispositionClassificationSchema,
  ShadowDispositionSchema,
  ShadowEvaluationRecordSchema,
  type HistoryDisposition,
  type HistoryDispositionClassification,
  type PolicyEvaluation,
  type PolicyProof,
  type PolicySpec,
  type ProofClass,
  type ShadowDisposition,
  type ShadowEvaluationRecord,
} from "./schema.js";

export function policyEvaluationContentHash(evaluation: PolicyEvaluation): string {
  const { deterministic_hash: _hash, ...body } = evaluation;
  return canonicalHash(body);
}

export function shadowEvaluationContentHash(record: ShadowEvaluationRecord): string {
  const { id: _id, content_hash: _contentHash, ...body } = record;
  return canonicalHash(body);
}

export function shadowEvaluationIdentityHash(record: ShadowEvaluationRecord): string {
  return canonicalHash({
    policy_id: record.policy_id,
    proof_id: record.proof_id,
    policy_hash: record.policy_hash,
    plan_hash: record.plan_hash,
    repository_head: record.evaluation.repository.head,
    graph_hash: record.evaluation.repository.graph_hash,
  });
}

export function shadowDispositionContentHash(record: ShadowDisposition): string {
  const { id: _id, content_hash: _contentHash, ...body } = record;
  return canonicalHash(body);
}

export function shadowDispositionJudgmentHash(record: ShadowDisposition): string {
  const { id: _id, content_hash: _contentHash, created_at: _createdAt, ...body } = record;
  return canonicalHash(body);
}

export function compileShadowEvaluation(
  policy: PolicySpec,
  proof: PolicyProof,
  expectedPolicyHash: string,
  evaluation: PolicyEvaluation,
  alsoDetectedBy: string[],
  latencyMs: number,
  now = new Date().toISOString(),
): ShadowEvaluationRecord {
  if (policy.proof !== proof.id) throw new Error(`policy ${policy.id} does not link proof ${proof.id}`);
  if (proof.policy_hash !== expectedPolicyHash) throw new Error(`proof ${proof.id} does not match current policy semantics`);
  if (proof.data_class !== policy.data_class) throw new Error(`proof ${proof.id} does not match policy ${policy.id} data class`);
  if (evaluation.policy_id !== policy.id) throw new Error(`shadow evaluation does not belong to policy ${policy.id}`);
  if (evaluation.evaluator.name !== proof.evaluator.name || evaluation.evaluator.version !== proof.evaluator.version) {
    throw new Error(`shadow evaluation does not use proof ${proof.id} evaluator`);
  }
  if (evaluation.deterministic_hash !== policyEvaluationContentHash(evaluation)) throw new Error("shadow evaluation deterministic hash mismatch");
  if (!Number.isFinite(latencyMs) || latencyMs < 0) throw new Error("shadow evaluation latency must be a non-negative finite number");
  const body = {
    record_type: "evaluation" as const,
    policy_id: policy.id,
    proof_id: proof.id,
    policy_hash: proof.policy_hash,
    plan_hash: proof.plan_hash,
    evaluation,
    also_detected_by: [...new Set(alsoDetectedBy.filter((id) => id !== policy.id))].sort(),
    latency_ms: latencyMs,
    data_class: policy.data_class,
    observed_at: now,
  };
  const contentHash = canonicalHash(body);
  return ShadowEvaluationRecordSchema.parse({
    id: `shadow_${shortHash(contentHash)}`,
    content_hash: contentHash,
    ...body,
  });
}

export function compileShadowDisposition(
  evaluation: ShadowEvaluationRecord,
  classification: HistoryDispositionClassification,
  actor: string,
  reason: string,
  opts: { now?: string; supersedes?: string | null } = {},
): ShadowDisposition {
  if (evaluation.evaluation.result !== "violated") throw new Error("shadow dispositions apply only to violated shadow evaluations");
  const body = {
    record_type: "disposition" as const,
    shadow_id: evaluation.id,
    policy_id: evaluation.policy_id,
    proof_id: evaluation.proof_id,
    policy_hash: evaluation.policy_hash,
    evaluation_hash: evaluation.evaluation.deterministic_hash,
    classification: HistoryDispositionClassificationSchema.parse(classification),
    actor,
    reason: reason.trim(),
    supersedes: opts.supersedes ?? null,
    data_class: evaluation.data_class,
    created_at: opts.now ?? new Date().toISOString(),
  };
  const contentHash = canonicalHash(body);
  return ShadowDispositionSchema.parse({
    id: `sdisp_${shortHash(contentHash)}`,
    content_hash: contentHash,
    ...body,
  });
}

/** Resolve append-only correction chains without trusting timestamps. */
export function currentShadowDispositions(records: ShadowDisposition[]): ShadowDisposition[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  if (byId.size !== records.length) throw new Error("duplicate shadow disposition id");
  const childCount = new Map<string, number>();
  for (const record of records) {
    if (!record.supersedes) continue;
    const parent = byId.get(record.supersedes);
    if (!parent) throw new Error(`shadow disposition ${record.id} supersedes missing ${record.supersedes}`);
    if (parent.policy_id !== record.policy_id || parent.proof_id !== record.proof_id || parent.shadow_id !== record.shadow_id) {
      throw new Error(`shadow disposition ${record.id} supersedes a different policy/proof/evaluation`);
    }
    childCount.set(parent.id, (childCount.get(parent.id) ?? 0) + 1);
    if (childCount.get(parent.id)! > 1) throw new Error(`shadow disposition ${parent.id} has a branched supersession chain`);
  }
  for (const record of records) {
    const visited = new Set<string>();
    let cursor: ShadowDisposition | undefined = record;
    while (cursor?.supersedes) {
      if (visited.has(cursor.id)) throw new Error(`shadow disposition chain contains a cycle at ${cursor.id}`);
      visited.add(cursor.id);
      cursor = byId.get(cursor.supersedes);
    }
  }
  const current = records
    .filter((record) => !childCount.has(record.id))
    .sort((left, right) => left.policy_id.localeCompare(right.policy_id) || left.shadow_id.localeCompare(right.shadow_id));
  const currentByEvaluation = new Set<string>();
  for (const record of current) {
    const key = `${record.policy_id}:${record.proof_id}:${record.shadow_id}`;
    if (currentByEvaluation.has(key)) throw new Error(`shadow evaluation ${record.shadow_id} has multiple current dispositions`);
    currentByEvaluation.add(key);
  }
  return current;
}

export interface ShadowPrecisionThresholds {
  minApplicable: number;
  recentApplicable: number;
  maxUnknownErrorRate: number;
  minMutationSensitivity: number;
}

export const DEFAULT_SHADOW_THRESHOLDS: ShadowPrecisionThresholds = {
  minApplicable: 20,
  recentApplicable: 100,
  maxUnknownErrorRate: 0.01,
  minMutationSensitivity: 0.95,
};

export interface ShadowPrecisionReport {
  policy_id: string;
  proof_id: string;
  policy_hash: string;
  thresholds: ShadowPrecisionThresholds;
  counts: {
    total: number;
    applicable: number;
    satisfied: number;
    violated: number;
    not_applicable: number;
    unknown: number;
    error: number;
    stale_excluded: number;
  };
  window: { recent_limit: number; applicable: number; violated: number };
  dispositions: Record<HistoryDispositionClassification | "unclassified", number>;
  precision: {
    true_positives: number;
    false_positives: number;
    confirmed_denominator: number;
    confirmed: number | null;
    lower_bound: number | null;
  };
  unknown_error_rate: number;
  mutation_sensitivity: number;
  recommendation: "not_ready" | "eligible_for_p4_review";
  reasons: string[];
}

const proofRank: Record<ProofClass, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };

export function scoreShadowPrecision(
  policy: PolicySpec,
  proof: PolicyProof,
  evaluations: ShadowEvaluationRecord[],
  dispositions: ShadowDisposition[],
  historyDispositions: HistoryDisposition[],
  thresholdOverrides: Partial<ShadowPrecisionThresholds> = {},
): ShadowPrecisionReport {
  const thresholds = { ...DEFAULT_SHADOW_THRESHOLDS, ...thresholdOverrides };
  if (!Number.isInteger(thresholds.minApplicable) || thresholds.minApplicable < 0) throw new Error("shadow minApplicable must be a non-negative integer");
  if (!Number.isInteger(thresholds.recentApplicable) || thresholds.recentApplicable < 1) throw new Error("shadow recentApplicable must be a positive integer");
  if (thresholds.maxUnknownErrorRate < 0 || thresholds.maxUnknownErrorRate > 1) throw new Error("shadow maxUnknownErrorRate must be between 0 and 1");
  if (thresholds.minMutationSensitivity < 0 || thresholds.minMutationSensitivity > 1) throw new Error("shadow minMutationSensitivity must be between 0 and 1");

  const exact = evaluations.filter((record) => record.proof_id === proof.id && record.policy_hash === proof.policy_hash);
  const allApplicable = exact.filter((record) => record.evaluation.result !== "not_applicable");
  const applicable = allApplicable
    .sort((left, right) => right.observed_at.localeCompare(left.observed_at) || right.id.localeCompare(left.id))
    .slice(0, thresholds.recentApplicable);
  const currentDispositions = currentShadowDispositions(dispositions);
  const classificationCounts: ShadowPrecisionReport["dispositions"] = {
    true_positive_actionable: 0,
    true_positive_accepted_exception: 0,
    false_positive_selector: 0,
    false_positive_semantics: 0,
    false_positive_stale: 0,
    unknown_insufficient_parser: 0,
    unclassified: 0,
  };
  for (const record of applicable.filter((candidate) => candidate.evaluation.result === "violated")) {
    const disposition = currentDispositions.find((candidate) => candidate.shadow_id === record.id
      && candidate.proof_id === proof.id
      && candidate.policy_hash === proof.policy_hash
      && candidate.evaluation_hash === record.evaluation.deterministic_hash);
    if (disposition) classificationCounts[disposition.classification] += 1;
    else classificationCounts.unclassified += 1;
  }
  const truePositives = classificationCounts.true_positive_actionable + classificationCounts.true_positive_accepted_exception;
  const falsePositives = classificationCounts.false_positive_selector + classificationCounts.false_positive_semantics + classificationCounts.false_positive_stale;
  const confirmedDenominator = truePositives + falsePositives;
  const violationCount = applicable.filter((record) => record.evaluation.result === "violated").length;
  const unknownErrors = applicable.filter((record) => record.evaluation.result === "unknown" || record.evaluation.result === "error").length;
  const unknownErrorRate = applicable.length ? unknownErrors / applicable.length : 0;
  const requiredMutations = proof.mutation_receipts.filter((receipt) => receipt.required);
  const mutationSensitivity = requiredMutations.length
    ? requiredMutations.filter((receipt) => receipt.passed).length / requiredMutations.length
    : 0;
  const historyAssessment = assessHistoryDispositions(proof, historyDispositions);
  const reasons: string[] = [];
  if (proofRank[proof.proof_class] < proofRank.P3) reasons.push(`Proof ${proof.id} is ${proof.proof_class}; P3+ is required.`);
  if (proof.current.satisfied !== 1 || proof.current.unknown || proof.current.error) reasons.push("Proof has no clean satisfied baseline.");
  if (historyAssessment.blocking_error) reasons.push(historyAssessment.blocking_error);
  if (mutationSensitivity < thresholds.minMutationSensitivity) reasons.push(`Required mutation sensitivity ${mutationSensitivity.toFixed(3)} is below ${thresholds.minMutationSensitivity.toFixed(3)}.`);
  if (applicable.length < thresholds.minApplicable) reasons.push(`Shadow window has ${applicable.length} applicable change(s); ${thresholds.minApplicable} required.`);
  if (falsePositives) reasons.push(`Shadow window has ${falsePositives} confirmed false positive(s).`);
  if (classificationCounts.unclassified) reasons.push(`Shadow window has ${classificationCounts.unclassified} unclassified violation(s).`);
  if (classificationCounts.unknown_insufficient_parser) reasons.push(`Shadow window has ${classificationCounts.unknown_insufficient_parser} disposition(s) unresolved for parser support.`);
  if (classificationCounts.true_positive_accepted_exception) reasons.push(`Shadow window has ${classificationCounts.true_positive_accepted_exception} accepted exception(s) requiring policy composition repair and re-proof.`);
  if (unknownErrorRate >= thresholds.maxUnknownErrorRate && unknownErrors) reasons.push(`Shadow unknown/error rate ${unknownErrorRate.toFixed(3)} is not below ${thresholds.maxUnknownErrorRate.toFixed(3)}.`);

  return {
    policy_id: policy.id,
    proof_id: proof.id,
    policy_hash: proof.policy_hash,
    thresholds,
    counts: {
      total: exact.length,
      applicable: allApplicable.length,
      satisfied: exact.filter((record) => record.evaluation.result === "satisfied").length,
      violated: exact.filter((record) => record.evaluation.result === "violated").length,
      not_applicable: exact.filter((record) => record.evaluation.result === "not_applicable").length,
      unknown: exact.filter((record) => record.evaluation.result === "unknown").length,
      error: exact.filter((record) => record.evaluation.result === "error").length,
      stale_excluded: evaluations.length - exact.length,
    },
    window: { recent_limit: thresholds.recentApplicable, applicable: applicable.length, violated: violationCount },
    dispositions: classificationCounts,
    precision: {
      true_positives: truePositives,
      false_positives: falsePositives,
      confirmed_denominator: confirmedDenominator,
      confirmed: confirmedDenominator ? truePositives / confirmedDenominator : null,
      lower_bound: violationCount ? truePositives / violationCount : null,
    },
    unknown_error_rate: unknownErrorRate,
    mutation_sensitivity: mutationSensitivity,
    recommendation: reasons.length ? "not_ready" : "eligible_for_p4_review",
    reasons,
  };
}
