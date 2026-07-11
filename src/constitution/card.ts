import { canonicalHash } from "./canonical.js";
import { assertCompositionBinding, policyProofHash } from "./composition.js";
import { blockingEvidenceError } from "./lifecycle.js";
import { assessHistoryDispositions } from "./disposition.js";
import type { EvaluationSummary, HistoryDisposition, HistoryDispositionClassification, PolicyProof, PolicySpec, ProofClass } from "./schema.js";
import type { ShadowPrecisionReport } from "./shadow.js";

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
    candidate: PolicySpec["candidate"];
    exception_of: string | null;
  };
  proof: { id: string; proof_class: ProofClass; plan_hash: string; generated_at: string };
  evidence_vector: {
    current: EvaluationSummary;
    known_bad: EvaluationSummary;
    known_good: EvaluationSummary;
    accepted_history: PolicyProof["accepted_history"];
    mutations: PolicyProof["mutations"];
    mutation_controls: PolicyProof["mutation_controls"];
  };
  project_checks: PolicyProof["project_checks"];
  composition: PolicyProof["composition"] | null;
  shadow_precision: ShadowPrecisionReport | null;
  history_dispositions: {
    current: HistoryDisposition[];
    counts: Record<HistoryDispositionClassification, number>;
    missing_commits: string[];
    unresolved_count: number;
  };
  uncertainty: {
    unclassified_history_hits: number;
    unknown_results: number;
    error_results: number;
    limitations: string[];
    compiler_uncertainty: string[];
    candidate_conflicts: string[];
  };
  authority: {
    current: PolicySpec["authority"];
    eligible_for_human_blocking_approval: boolean;
    can_block_now: boolean;
    blocking_evidence_error: string | null;
  };
  actions: string[];
}

export function buildProofCard(
  policy: PolicySpec,
  proof: PolicyProof,
  dispositions: HistoryDisposition[] = [],
  composition: PolicySpec[] = [],
  shadowPrecision: ShadowPrecisionReport | null = null,
): ProofCard {
  let semanticMatch = proof.policy_hash === policyProofHash(policy, composition);
  try {
    assertCompositionBinding(policy, composition, proof.composition);
  } catch {
    semanticMatch = false;
  }
  const baselineClean = proof.current.total === 1 && proof.current.satisfied === 1 && proof.current.unknown === 0 && proof.current.error === 0;
  const dispositionAssessment = assessHistoryDispositions(proof, dispositions);
  const evidenceError = blockingEvidenceError(proof, dispositions);
  const proofStrongEnough = proofRank[proof.proof_class] >= proofRank.P3;
  const eligible = semanticMatch && baselineClean && proofStrongEnough && !evidenceError;
  const canBlock = eligible && policy.state === "active_blocking" && policy.severity === "blocking" && policy.authority?.kind === "human";
  const unknownResults = proof.current.unknown + proof.known_bad.unknown + proof.known_good.unknown + proof.accepted_history.unknown + proof.mutations.unknown;
  const errorResults = proof.current.error + proof.known_bad.error + proof.known_good.error + proof.accepted_history.error + proof.mutations.error;
  const actions: string[] = [];
  if (!semanticMatch) actions.push("Regenerate the plan and proof for the current policy semantics.");
  if (dispositionAssessment.unresolved_count) actions.push("Classify every accepted-history violation with an exact human disposition before considering blocking approval.");
  if (dispositionAssessment.counts.false_positive_selector + dispositionAssessment.counts.false_positive_semantics + dispositionAssessment.counts.false_positive_stale > 0) actions.push("Repair and re-prove the policy before blocking because a human classified a historical hit as a false positive.");
  if (dispositionAssessment.counts.true_positive_accepted_exception > 0) actions.push("Prove combined parent/exception semantics before treating an accepted exception as resolved.");
  if (dispositionAssessment.counts.unknown_insufficient_parser > 0) actions.push("Improve parser support and re-prove before resolving an unknown historical hit.");
  if (unknownResults || errorResults) actions.push("Repair or explicitly resolve every unknown/error proof result.");
  if (proof.mutation_controls.failed) actions.push("Repair every failed required mutation control before considering blocking approval.");
  if (policy.candidate.conflicts.length) actions.push("Resolve every direct candidate conflict with a human disposition before lifecycle promotion.");
  if (shadowPrecision?.recommendation === "eligible_for_p4_review") actions.push("Shadow thresholds are met; a human may review P4 evidence, but measurement grants no authority.");
  else if (shadowPrecision) actions.push("Continue bounded shadow review until every reported precision threshold is met.");
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
      candidate: policy.candidate,
      exception_of: policy.exception_of,
    },
    proof: { id: proof.id, proof_class: proof.proof_class, plan_hash: proof.plan_hash, generated_at: proof.generated_at },
    evidence_vector: {
      current: proof.current,
      known_bad: proof.known_bad,
      known_good: proof.known_good,
      accepted_history: proof.accepted_history,
      mutations: proof.mutations,
      mutation_controls: proof.mutation_controls,
    },
    project_checks: proof.project_checks,
    composition: proof.composition ?? null,
    shadow_precision: shadowPrecision,
    history_dispositions: {
      current: dispositionAssessment.current,
      counts: dispositionAssessment.counts,
      missing_commits: dispositionAssessment.missing_commits,
      unresolved_count: dispositionAssessment.unresolved_count,
    },
    uncertainty: {
      unclassified_history_hits: dispositionAssessment.unresolved_count,
      unknown_results: unknownResults,
      error_results: errorResults,
      limitations: [...proof.limitations],
      compiler_uncertainty: [...policy.candidate.uncertainty],
      candidate_conflicts: [...policy.candidate.conflicts],
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
    `  candidate alternatives: ${card.policy.candidate.alternatives.length} · conflicts: ${card.policy.candidate.conflicts.length} · incumbent: ${card.policy.candidate.incumbent ?? "none"}`,
    `  scope suggestion: ${card.policy.candidate.scope_suggestion ? JSON.stringify(card.policy.candidate.scope_suggestion) : "none — narrow compiled scope retained"}`,
    `  exception parent: ${card.policy.exception_of ?? "none"}`,
    `  ${line("current", card.evidence_vector.current)}`,
    `  ${line("known bad", card.evidence_vector.known_bad)}`,
    `  ${line("known good", card.evidence_vector.known_good)}`,
    `  ${line("accepted history", card.evidence_vector.accepted_history)}`,
    `  history dispositions: ${card.history_dispositions.current.length} current · ${card.history_dispositions.counts.true_positive_actionable} actionable true positive · ${card.history_dispositions.unresolved_count} unresolved`,
    `  ${line("mutations", card.evidence_vector.mutations)}`,
    `  mutation controls: ${card.evidence_vector.mutation_controls.passed}/${card.evidence_vector.mutation_controls.total} passed · ${card.evidence_vector.mutation_controls.failed} failed`,
    `  project checks: build ${card.project_checks.build} · test ${card.project_checks.test} · never required for evaluator sensitivity`,
    ...(card.composition ? [`  composition: ${card.composition.root_policy_id} + ${card.composition.members.length} exception(s) · ${card.composition.composite_hash}`] : []),
    ...(card.shadow_precision ? [`  shadow: ${card.shadow_precision.window.applicable} recent applicable · ${card.shadow_precision.window.violated} violated · precision ${card.shadow_precision.precision.confirmed == null ? "n/a" : (card.shadow_precision.precision.confirmed * 100).toFixed(1) + "%"} · ${card.shadow_precision.recommendation}`] : []),
    `  uncertainty: ${card.uncertainty.unclassified_history_hits} unclassified history hit · ${card.uncertainty.unknown_results} unknown · ${card.uncertainty.error_results} error`,
    `  blocking readiness: ${card.authority.eligible_for_human_blocking_approval ? "eligible for explicit human review" : `not eligible${card.authority.blocking_evidence_error ? ` — ${card.authority.blocking_evidence_error}` : ""}`}`,
    `  authority: ${card.authority.current?.kind === "human" ? card.authority.current.actor : "none — proof cannot activate policy"}`,
    ...card.uncertainty.limitations.map((limitation) => `  limitation: ${limitation}`),
    ...card.uncertainty.compiler_uncertainty.map((uncertainty) => `  compiler uncertainty: ${uncertainty}`),
    ...card.uncertainty.candidate_conflicts.map((conflict) => `  candidate conflict: ${conflict}`),
    ...card.history_dispositions.current.map((disposition) => `  history disposition: ${disposition.commit} · ${disposition.classification} · ${disposition.actor} · ${disposition.id}`),
    ...card.policy.candidate.counterexamples.map((counterexample) => `  counterexample: ${counterexample}`),
    ...card.actions.map((action) => `  action: ${action}`),
    `  card: ${card.card_hash}`,
  ].join("\n");
}
