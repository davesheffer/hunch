import { canonicalHash, policySemanticHash } from "./canonical.js";
import { blockingEvidenceError } from "./lifecycle.js";
import type { EvaluationSummary, PolicyProof, PolicySpec, ProofClass } from "./schema.js";

const proofRank: Record<ProofClass, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };

export interface ProofCard {
  card_hash: string;
  policy: {
    id: string;
    statement: string;
    state: PolicySpec["state"];
    severity: PolicySpec["severity"];
    data_class: PolicySpec["data_class"];
    assertion: PolicySpec["assertion"];
    scope: PolicySpec["scope"];
    evidence: string[];
  };
  proof: { id: string; proof_class: ProofClass; plan_hash: string; generated_at: string };
  evidence_vector: {
    current: EvaluationSummary;
    known_bad: EvaluationSummary;
    known_good: EvaluationSummary;
    accepted_history: PolicyProof["accepted_history"];
    mutations: PolicyProof["mutations"];
  };
  uncertainty: {
    unclassified_history_hits: number;
    unknown_results: number;
    error_results: number;
    limitations: string[];
  };
  authority: {
    current: PolicySpec["authority"];
    eligible_for_human_blocking_approval: boolean;
    can_block_now: boolean;
    blocking_evidence_error: string | null;
  };
  actions: string[];
}

export function buildProofCard(policy: PolicySpec, proof: PolicyProof): ProofCard {
  const semanticMatch = proof.policy_hash === policySemanticHash(policy);
  const baselineClean = proof.current.total === 1 && proof.current.satisfied === 1 && proof.current.unknown === 0 && proof.current.error === 0;
  const evidenceError = blockingEvidenceError(proof);
  const proofStrongEnough = proofRank[proof.proof_class] >= proofRank.P3;
  const eligible = semanticMatch && baselineClean && proofStrongEnough && !evidenceError;
  const canBlock = eligible && policy.state === "active_blocking" && policy.severity === "blocking" && policy.authority?.kind === "human";
  const unknownResults = proof.current.unknown + proof.known_bad.unknown + proof.known_good.unknown + proof.accepted_history.unknown + proof.mutations.unknown;
  const errorResults = proof.current.error + proof.known_bad.error + proof.known_good.error + proof.accepted_history.error + proof.mutations.error;
  const actions: string[] = [];
  if (!semanticMatch) actions.push("Regenerate the plan and proof for the current policy semantics.");
  if (proof.accepted_history.violated > proof.accepted_history.classified_hits.length) actions.push("Classify every accepted-history violation before considering blocking approval.");
  if (unknownResults || errorResults) actions.push("Repair or explicitly resolve every unknown/error proof result.");
  if (eligible && !canBlock) actions.push("A human may review and explicitly activate blocking mode; the proof and any earlier advisory approval grant no blocking authority by themselves.");
  if (!eligible && actions.length === 0) actions.push("Strengthen the evidence vector before requesting blocking approval.");
  actions.push("Review the exact assertion, scope, evidence, and limitations before any lifecycle action.");

  const body = {
    policy: {
      id: policy.id,
      statement: policy.statement,
      state: policy.state,
      severity: policy.severity,
      data_class: policy.data_class,
      assertion: policy.assertion,
      scope: policy.scope,
      evidence: [...policy.evidence],
    },
    proof: { id: proof.id, proof_class: proof.proof_class, plan_hash: proof.plan_hash, generated_at: proof.generated_at },
    evidence_vector: {
      current: proof.current,
      known_bad: proof.known_bad,
      known_good: proof.known_good,
      accepted_history: proof.accepted_history,
      mutations: proof.mutations,
    },
    uncertainty: {
      unclassified_history_hits: Math.max(0, proof.accepted_history.violated - proof.accepted_history.classified_hits.length),
      unknown_results: unknownResults,
      error_results: errorResults,
      limitations: [...proof.limitations],
    },
    authority: {
      current: policy.authority,
      eligible_for_human_blocking_approval: eligible,
      can_block_now: canBlock,
      blocking_evidence_error: evidenceError,
    },
    actions,
  };
  return { card_hash: canonicalHash(body), ...body };
}

function line(label: string, summary: EvaluationSummary): string {
  return `${label}: ${summary.total} total · ${summary.satisfied} satisfied · ${summary.violated} violated · ${summary.not_applicable} n/a · ${summary.unknown} unknown · ${summary.error} error`;
}

export function renderProofCard(card: ProofCard): string {
  return [
    `CONSTITUTION PROOF CARD  ${card.policy.id}`,
    `  ${card.policy.statement}`,
    `  state: ${card.policy.state} · severity: ${card.policy.severity} · proof: ${card.proof.proof_class} (${card.proof.id})`,
    `  assertion: ${JSON.stringify(card.policy.assertion)}`,
    `  scope: ${JSON.stringify(card.policy.scope)}`,
    `  evidence: ${card.policy.evidence.join(", ") || "none"}`,
    `  ${line("current", card.evidence_vector.current)}`,
    `  ${line("known bad", card.evidence_vector.known_bad)}`,
    `  ${line("known good", card.evidence_vector.known_good)}`,
    `  ${line("accepted history", card.evidence_vector.accepted_history)}`,
    `  ${line("mutations", card.evidence_vector.mutations)}`,
    `  uncertainty: ${card.uncertainty.unclassified_history_hits} unclassified history hit · ${card.uncertainty.unknown_results} unknown · ${card.uncertainty.error_results} error`,
    `  blocking readiness: ${card.authority.eligible_for_human_blocking_approval ? "eligible for explicit human review" : `not eligible${card.authority.blocking_evidence_error ? ` — ${card.authority.blocking_evidence_error}` : ""}`}`,
    `  authority: ${card.authority.current?.kind === "human" ? card.authority.current.actor : "none — proof cannot activate policy"}`,
    ...card.uncertainty.limitations.map((limitation) => `  limitation: ${limitation}`),
    ...card.actions.map((action) => `  action: ${action}`),
    `  card: ${card.card_hash}`,
  ].join("\n");
}
