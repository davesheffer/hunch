import { z } from "zod";
import { shortHash } from "../core/ids.js";
import { canonicalHash } from "./canonical.js";
import {
  g2BehaviorCandidateHash,
  g2BehaviorReviewContentHash,
  type G2BehaviorCandidateReview,
} from "./g2BehaviorCandidates.js";
import {
  g2BehaviorAttestationContentHash,
  type G2BehaviorAttestation,
} from "./g2BehaviorAttestation.js";
import { BEHAVIOR_POLICY_EVALUATOR, EXECUTABLE_BEHAVIOR_IR_VERSION } from "./schema.js";

const HASH = /^sha1:[a-f0-9]{40}$/;
const SUPPORTED_ASSERTION_KINDS = ["executable-behavior", "exists", "must-pass-through", "not-reaches", "reaches"] as const;

const SourceReviewSchema = z.object({
  id: z.string().regex(/^g2behaviorcandidates_[a-f0-9]{10}$/),
  content_hash: z.string().regex(HASH),
  structural_review_hash: z.string().regex(HASH),
  grounding_mode: z.literal("human_decision_plus_added_test").optional(),
  source_decision_id: z.string().regex(/^dec_[A-Za-z0-9_-]+$/).optional(),
  source_grounding_hash: z.string().regex(HASH).optional(),
}).strict();

const MaterializationItemSchema = z.object({
  candidate_id: z.string().regex(/^g2behavior_[a-f0-9]{10}$/),
  candidate_hash: z.string().regex(HASH),
  attestation_id: z.string().regex(/^g2behaviorattest_[a-f0-9]{10}$/),
  attestation_hash: z.string().regex(HASH),
  attested_review_hash: z.string().regex(HASH),
  replay_id: z.string().regex(/^g2behaviorreplay_[a-f0-9]{10}$/),
  replay_hash: z.string().regex(HASH),
  dependency_snapshot_ids: z.array(z.string().regex(/^g2deps_[a-f0-9]{10}$/)).min(1).max(2),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  test: z.object({
    file: z.string().min(1),
    name: z.string().min(1),
    source_hash: z.string().regex(HASH),
  }).strict(),
  durable_meaning: z.string().min(1),
  status: z.literal("ready_for_materialization"),
  reason: z.string().min(1),
  required_capability: z.object({
    assertion: z.literal("executable-behavior"),
    current_baseline: z.literal("required"),
    known_bad: z.literal("must_fail_behaviorally"),
    known_good: z.literal("must_pass"),
    mutation_controls: z.literal("required"),
  }).strict(),
}).strict();

export const G2BehaviorMaterializationAssessmentSchema = z.object({
  id: z.string().regex(/^g2behaviormaterialization_[a-f0-9]{10}$/),
  content_hash: z.string().regex(HASH),
  source_review: SourceReviewSchema,
  policy_ir_version: z.literal(EXECUTABLE_BEHAVIOR_IR_VERSION),
  evaluator: z.object({
    name: z.literal(BEHAVIOR_POLICY_EVALUATOR.name),
    version: z.literal(BEHAVIOR_POLICY_EVALUATOR.version),
  }).strict(),
  supported_assertion_kinds: z.array(z.enum(SUPPORTED_ASSERTION_KINDS)).length(SUPPORTED_ASSERTION_KINDS.length),
  selected_attestations: z.number().int().min(1),
  materialized_policies: z.literal(0),
  readiness: z.literal("ready_for_materialization"),
  items: z.array(MaterializationItemSchema).min(1),
  outputs: z.object({
    policies: z.array(z.never()).length(0),
    corpora: z.array(z.never()).length(0),
    plans: z.array(z.never()).length(0),
    proofs: z.array(z.never()).length(0),
  }).strict(),
  limitations: z.array(z.string().min(1)).min(1),
  data_class: z.literal("private"),
  authority: z.literal("none"),
  effects: z.literal("assessment_only"),
  writes: z.literal("none"),
  proof_status: z.literal("not_run"),
  activation: z.literal("separate_human_action_required"),
}).strict();

export type G2BehaviorMaterializationAssessment = z.infer<typeof G2BehaviorMaterializationAssessmentSchema>;

export function g2BehaviorMaterializationContentHash(assessment: G2BehaviorMaterializationAssessment): string {
  const { id: _id, content_hash: _contentHash, ...body } = assessment;
  return canonicalHash(body);
}

const readyReason = `The selected receipt is expressible by Policy IR v${EXECUTABLE_BEHAVIOR_IR_VERSION} through ${BEHAVIOR_POLICY_EVALUATOR.name}@${BEHAVIOR_POLICY_EVALUATOR.version}; materialization must still produce exact current, known-bad, known-good, and mutation-control receipts before proposal.`;

/**
 * Assess exact selected behavior receipts against the currently implemented
 * Policy IR. This is intentionally fail-closed: it never substitutes a static
 * symbol or edge proxy for behavior that the evaluator cannot execute.
 */
export function assessG2BehaviorMaterialization(
  report: G2BehaviorCandidateReview,
  currentAttestations: G2BehaviorAttestation[],
): G2BehaviorMaterializationAssessment {
  if (report.content_hash !== g2BehaviorReviewContentHash(report)
    || report.id !== `g2behaviorcandidates_${shortHash(report.content_hash)}`) {
    throw new Error(`G2 behavior candidate review ${report.id} content hash mismatch`);
  }
  if (report.has_more) throw new Error("G2 behavior materialization requires a complete, untruncated behavior review");
  if (report.unreviewed_candidates !== 0) throw new Error("G2 behavior materialization requires every behavior candidate to have a current human disposition");

  const candidateHashes = new Map(report.items.map((candidate) => [candidate.id, g2BehaviorCandidateHash(candidate)]));
  const selected = currentAttestations
    .filter((attestation) => attestation.disposition === "selected"
      && candidateHashes.get(attestation.candidate_id) === attestation.candidate_hash)
    .sort((left, right) => left.candidate_id.localeCompare(right.candidate_id));
  if (!selected.length) throw new Error("G2 behavior materialization requires at least one current selected attestation");
  if (report.selected_candidates !== selected.length) {
    throw new Error("G2 behavior materialization selected-attestation count does not match the exact current review");
  }

  const items = selected.map((attestation) => {
    if (attestation.content_hash !== g2BehaviorAttestationContentHash(attestation)
      || attestation.id !== `g2behaviorattest_${shortHash(attestation.content_hash)}`) {
      throw new Error(`G2 behavior attestation ${attestation.id} content hash mismatch`);
    }
    const candidate = report.items.find((item) => item.id === attestation.candidate_id);
    if (!candidate || g2BehaviorCandidateHash(candidate) !== attestation.candidate_hash) {
      throw new Error(`G2 behavior attestation ${attestation.id} does not bind a candidate in the exact current review`);
    }
    if (candidate.human_review?.id !== attestation.id || candidate.human_review.disposition !== "selected") {
      throw new Error(`G2 behavior attestation ${attestation.id} is not the current selected disposition projected by the review`);
    }
    return {
      candidate_id: candidate.id,
      candidate_hash: attestation.candidate_hash,
      attestation_id: attestation.id,
      attestation_hash: attestation.content_hash,
      attested_review_hash: attestation.review_hash,
      replay_id: attestation.replay_id,
      replay_hash: attestation.replay_hash,
      dependency_snapshot_ids: attestation.dependency_snapshot_ids,
      commit: attestation.commit,
      test: candidate.test,
      durable_meaning: attestation.reason,
      status: "ready_for_materialization" as const,
      reason: readyReason,
      required_capability: {
        assertion: "executable-behavior" as const,
        current_baseline: "required" as const,
        known_bad: "must_fail_behaviorally" as const,
        known_good: "must_pass" as const,
        mutation_controls: "required" as const,
      },
    };
  });

  const body = {
    source_review: {
      id: report.id,
      content_hash: report.content_hash,
      structural_review_hash: report.structural_review_hash,
      ...(report.grounding_mode ? { grounding_mode: report.grounding_mode } : {}),
      ...(report.source_decision_id ? { source_decision_id: report.source_decision_id } : {}),
      ...(report.source_grounding_hash ? { source_grounding_hash: report.source_grounding_hash } : {}),
    },
    policy_ir_version: EXECUTABLE_BEHAVIOR_IR_VERSION,
    evaluator: { ...BEHAVIOR_POLICY_EVALUATOR },
    supported_assertion_kinds: [...SUPPORTED_ASSERTION_KINDS],
    selected_attestations: items.length,
    materialized_policies: 0 as const,
    readiness: "ready_for_materialization" as const,
    items,
    outputs: { policies: [], corpora: [], plans: [], proofs: [] },
    limitations: [
      "Assessment alone creates no PolicySpec, corpus, proof plan, proof, authority, warning, or block.",
      "Executable materialization must independently prove current, known-bad, known-good, and mutation-control behavior before proposal.",
      "Committed HEAD remains the proof baseline; advisory delivery may separately evaluate a content-addressed staged or working snapshot.",
    ],
    data_class: "private" as const,
    authority: "none" as const,
    effects: "assessment_only" as const,
    writes: "none" as const,
    proof_status: "not_run" as const,
    activation: "separate_human_action_required" as const,
  };
  const contentHash = canonicalHash(body);
  return G2BehaviorMaterializationAssessmentSchema.parse({
    id: `g2behaviormaterialization_${shortHash(contentHash)}`,
    content_hash: contentHash,
    ...body,
  });
}
