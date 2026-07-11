import { execFileSync, spawnSync } from "node:child_process";
import type { HunchStore } from "../store/hunchStore.js";
import { headSha } from "../extractors/git.js";
import { canonicalHash, canonicalJson } from "./canonical.js";
import { shortHash } from "../core/ids.js";
import { compileDecisionPolicy, type CompilePolicyOptions } from "./compiler.js";
import { evaluatePolicy, policyBlocks, policyIsActive } from "./evaluator.js";
import { approvePolicy, blockingProofError, demotePolicy, linkPolicyException, proposeProvedPolicy } from "./lifecycle.js";
import { provePolicy } from "./proof.js";
import { PolicyRepository } from "./repository.js";
import type { PolicyEvaluation, PolicyProof, PolicySpec, ProofCorpus } from "./schema.js";
import type { ProofPlan } from "./schema.js";
import { bootstrapPolicies, type BootstrapOptions, type BootstrapReport } from "./bootstrap.js";
import { bootstrapStructuralPolicies, inspectStructuralDecision, type StructuralInspection } from "./structural.js";
import { createProofPlan, type ProofPlanOptions } from "./plan.js";
import { ingestLocalEvidence, type LocalEvidenceOptions, type LocalEvidenceReport } from "./adapters.js";
import { buildProofCard, type ProofCard } from "./card.js";
import { compileProofCorpus } from "./corpus.js";
import { compileHistoryDisposition, currentHistoryDispositions } from "./disposition.js";
import { compositionDescendants, policyProofHash } from "./composition.js";
import {
  compileShadowDisposition,
  compileShadowEvaluation,
  currentShadowDispositions,
  scoreShadowPrecision,
  type ShadowPrecisionReport,
  type ShadowPrecisionThresholds,
} from "./shadow.js";
import type { HistoryDisposition, HistoryDispositionClassification, ReplayReceipt, ShadowDisposition, ShadowEvaluationRecord } from "./schema.js";
import { assessHistoryDispositions } from "./disposition.js";
import { evaluatorForPolicy, mutationEngineForPolicy } from "./policyRuntime.js";
import {
  G2_RUNBOOK_CATEGORIES,
  G2EvidenceRepository,
  compileG2Plan,
  compileRunbookRehearsal,
  currentRunbookRehearsals,
  runbookContentHash,
  scoreG2Readiness,
  type CompileG2PlanInput,
  type G2PolicyEvidence,
  type G2ReadinessReport,
  type G2RunbookEvidence,
  type G2ShadowQueue,
  type G2ShadowQueueItem,
  type G2ShadowBackfillReport,
  type G2ShadowSweepReport,
  type RunbookRehearsal,
} from "./g2.js";
import { buildG2CandidateReview, type G2CandidateReviewOptions, type G2CandidateReviewReport } from "./g2Candidates.js";
import {
  G2CandidateAttestationRepository,
  compileG2CandidateAttestation,
  type G2CandidateAttestation,
} from "./g2CandidateAttestation.js";
import {
  buildG2BehaviorCandidateReview,
  replayG2BehaviorCandidate,
  type G2BehaviorCandidateReviewOptions,
  type G2BehaviorCandidateReview,
  type G2BehaviorReplayReceipt,
} from "./g2BehaviorCandidates.js";
import {
  provisionG2BehaviorDependencySnapshots,
  type G2BehaviorDependencySnapshotReceipt,
} from "./g2BehaviorDependencies.js";
import {
  G2BehaviorAttestationRepository,
  compileG2BehaviorAttestation,
  type G2BehaviorAttestation,
} from "./g2BehaviorAttestation.js";
import {
  assessG2BehaviorMaterialization,
  type G2BehaviorMaterializationAssessment,
} from "./g2BehaviorMaterialization.js";
import {
  materializeSelectedG2BehaviorPolicies,
  type G2BehaviorPolicyMaterialization,
} from "./g2BehaviorPolicyMaterializer.js";
import { executableBehaviorAttestationError } from "./behaviorAttestationBinding.js";
import { evaluateExecutableBehaviorPolicy, type BehaviorEvaluationOptions } from "./behaviorEvaluator.js";
import { executeG2OperationalDrill, type G2OperationalDrillReceipt } from "./g2Drills.js";
import {
  G3_REQUIRED_EXPERIMENTS,
  G3EvidenceRepository,
  compileExperimentPreregistration,
  compileG3Plan,
  compileProofReviewMeasurement,
  scoreG3Readiness,
  type CompileExperimentPreregistrationInput,
  type CompileG3PlanInput,
  type G3PolicyEvidence,
  type G3ReadinessReport,
  type ProofReviewMeasurement,
  type ExperimentPreregistration,
  type AdapterConformanceReceipt,
} from "./g3.js";
import { executeG3AdapterConformance, g3ConformanceSourceHash } from "./g3Conformance.js";
import {
  ExperimentRepository,
  assignmentTreatment,
  buildExperimentReport,
  compileExperimentCaseBank,
  compileExperimentFollowup,
  compileExperimentOutcome,
  compileExperimentReviewStart,
  compileExperimentRun,
  compileExperimentStop,
  currentExperimentOutcomes,
  normalizedEditDistance,
  type CompileExperimentCaseBankInput,
  type CompileExperimentRunInput,
  type ExperimentCaseBank,
  type ExperimentFollowup,
  type ExperimentOutcome,
  type ExperimentReport,
  type ExperimentReviewStart,
  type ExperimentRun,
  type ExperimentStop,
} from "./experiment.js";
import { executeExp01Assignment } from "./experimentRunner.js";

export interface PolicyEvaluationSet {
  policy: PolicySpec;
  evaluation: PolicyEvaluation;
  blocks: boolean;
  strict_error: boolean;
  gate_error?: string;
}

export interface PolicyRelationSummary {
  id: string;
  statement: string;
  state: PolicySpec["state"];
  severity: PolicySpec["severity"];
  data_class: PolicySpec["data_class"];
  scope: PolicySpec["scope"];
  exception_of: string | null;
}

export interface PolicyExceptionRelations {
  policy: PolicyRelationSummary;
  exception_parent: PolicyRelationSummary | null;
  missing_exception_parent: string | null;
  exceptions: PolicyRelationSummary[];
}

export interface PolicyConsolidationCandidate {
  anchor: PolicyRelationSummary;
  suggested_scope: PolicySpec["scope"] | null;
  status: "unavailable" | "reviewable" | "challenged";
  members: PolicyRelationSummary[];
  independent_decisions: string[];
  counterexamples: string[];
  conflicts: string[];
  exception_linked_members: string[];
  reasons: string[];
}

export interface PolicyHistoryDispositionView {
  policy_id: string;
  proof_id: string;
  violations: Array<{
    commit: string;
    receipt_hash: string;
    disposition: HistoryDisposition | null;
  }>;
  current: HistoryDisposition[];
  audit: HistoryDisposition[];
}

export interface PolicyShadowView extends ShadowPrecisionReport {
  evaluations: Array<{ record: ShadowEvaluationRecord; disposition: ShadowDisposition | null }>;
  disposition_audit: ShadowDisposition[];
}

function relationSummary(policy: PolicySpec): PolicyRelationSummary {
  return {
    id: policy.id,
    statement: policy.statement,
    state: policy.state,
    severity: policy.severity,
    data_class: policy.data_class,
    scope: policy.scope,
    exception_of: policy.exception_of,
  };
}

function sameStringSet(left: string[], right: string[]): boolean {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.length === rightSorted.length
    && leftSorted.every((value, index) => value === rightSorted[index]);
}

function pathFallsWithin(path: string, broader: string): boolean {
  if (path === broader) return true;
  if (!broader.endsWith("/**")) return false;
  const prefix = broader.slice(0, -3);
  return path.startsWith(`${prefix}/`);
}

/** Conservative, syntactic containment for advisory consolidation only. A
 * suggestion that uses another glob shape stays non-reviewable rather than
 * guessing glob semantics. */
function scopeFallsWithin(scope: PolicySpec["scope"], suggestion: PolicySpec["scope"]): boolean {
  if (!sameStringSet(scope.repos, suggestion.repos)) return false;
  if (!scope.components.every((component) => suggestion.components.includes(component))) return false;
  return scope.paths.length > 0
    && suggestion.paths.length > 0
    && scope.paths.every((path) => suggestion.paths.some((broader) => pathFallsWithin(path, broader)));
}

export function shadowCommitEligible(root: string, policy: PolicySpec, commit: string): boolean {
  if (policy.assertion.kind !== "executable-behavior") return true;
  const sourceCommit = policy.assertion.test.source_commit;
  const check = spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", sourceCommit, commit], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (check.status === 0) return true;
  if (check.status === 1) return false;
  throw new Error(`cannot compare shadow commit ${commit} with policy introduction ${sourceCommit}: ${(check.stderr ?? "").trim() || `git exited ${check.status}`}`);
}

export class ConstitutionService {
  readonly repository: PolicyRepository;
  readonly g2Repository: G2EvidenceRepository;
  readonly g3Repository: G3EvidenceRepository;
  readonly experimentRepository: ExperimentRepository;
  readonly g2CandidateRepository: G2CandidateAttestationRepository;
  readonly g2BehaviorAttestationRepository: G2BehaviorAttestationRepository;

  constructor(private readonly store: HunchStore, private readonly root: string) {
    this.repository = new PolicyRepository(root, store);
    this.g2Repository = new G2EvidenceRepository(store);
    this.g3Repository = new G3EvidenceRepository(store);
    this.experimentRepository = new ExperimentRepository(store);
    this.g2CandidateRepository = new G2CandidateAttestationRepository(store);
    this.g2BehaviorAttestationRepository = new G2BehaviorAttestationRepository(store);
  }

  createG2Plan(input: CompileG2PlanInput, opts: { now?: string } = {}) {
    const plan = compileG2Plan(input, opts);
    for (const policyId of plan.policy_ids) {
      const policy = this.repository.getPolicy(policyId, { privateOnly: true });
      const publicDuplicate = this.repository.getPolicy(policyId, { publicOnly: true });
      if (!policy || publicDuplicate || this.repository.homeOfPolicy(policyId) !== "private" || policy.data_class === "public") {
        throw new Error(`G2 selected policy ${policyId} must exist only in the configured private overlay`);
      }
    }
    for (const [category, runbookId] of Object.entries(plan.runbooks)) {
      const publicDuplicate = this.store.recsInHome("runbooks", "public").some((runbook) => runbook.id === runbookId);
      if (!this.store.getPrivateRec("runbooks", runbookId) || publicDuplicate) {
        throw new Error(`G2 ${category} runbook ${runbookId} must exist in the configured private overlay`);
      }
    }
    return this.g2Repository.putPlan(plan);
  }

  recordRunbookRehearsal(
    runbookId: string,
    result: "passed" | "failed",
    actor: string,
    evidenceHashes: string[],
    notes: string,
    opts: { now?: string; supersedes?: string | null } = {},
  ): RunbookRehearsal {
    const runbook = this.store.getPrivateRec("runbooks", runbookId);
    if (!runbook) throw new Error(`private runbook ${runbookId} not found`);
    const receipt = compileRunbookRehearsal({
      runbook_id: runbookId,
      runbook_hash: runbookContentHash(runbook),
      result,
      actor,
      evidence_hashes: evidenceHashes,
      notes,
      supersedes: opts.supersedes,
    }, { now: opts.now });
    return this.g2Repository.putRehearsal(receipt);
  }

  g2Readiness(): G2ReadinessReport {
    const manifest = this.g2Repository.currentPlan();
    const privatePolicies = this.repository.listPolicies({ privateOnly: true });
    const publicPolicies = this.repository.listPolicies({ publicOnly: true });
    const privateRunbooks = this.store.recsInHome("runbooks", "private");
    const publicRunbooks = this.store.recsInHome("runbooks", "public");
    const rehearsals = this.g2Repository.listRehearsals();
    const currentRehearsals = currentRunbookRehearsals(rehearsals);
    const activeBlocking = this.repository.listPolicies().filter((policy) => policy.state === "active_blocking").map((policy) => policy.id);
    const policyEvidence: G2PolicyEvidence[] = [];
    const runbookEvidence: G2RunbookEvidence[] = [];

    for (const policyId of manifest?.policy_ids ?? []) {
      const reasons: string[] = [];
      const policy = privatePolicies.find((candidate) => candidate.id === policyId);
      const publicDuplicate = publicPolicies.some((candidate) => candidate.id === policyId);
      let proofId: string | null = null;
      let corpusId: string | null = null;
      let shadowApplicable = 0;
      let shadowViolations = 0;
      let shadowUnclassified = 0;
      let confirmedPrecision: number | null = null;
      if (!policy || publicDuplicate || this.repository.homeOfPolicy(policyId) !== "private" || policy.data_class === "public") {
        reasons.push("selected policy is missing from its exact private home");
      } else if (!policy.proof) {
        reasons.push("selected policy has no current proof");
      } else {
        const behaviorAttestationError = executableBehaviorAttestationError(policy, this.g2BehaviorAttestationRepository.current());
        if (behaviorAttestationError) reasons.push(behaviorAttestationError);
        const composition = compositionDescendants(policy, privatePolicies);
        const proof = this.repository.getProof(policy.proof, { privateOnly: true });
        proofId = proof?.id ?? null;
        if (!proof) {
          reasons.push(`linked proof ${policy.proof} is missing from the private overlay`);
        } else {
          if (proof.policy_hash !== policyProofHash(policy, composition)) reasons.push("proof does not bind current policy/composite semantics");
          const expectedEvaluator = evaluatorForPolicy(policy);
          const expectedMutationEngine = mutationEngineForPolicy(policy);
          if (proof.evaluator.name !== expectedEvaluator.name || proof.evaluator.version !== expectedEvaluator.version) reasons.push("proof evaluator version is stale");
          if (proof.mutation_engine?.name !== expectedMutationEngine.name || proof.mutation_engine.version !== expectedMutationEngine.version) reasons.push("proof mutation engine version is stale");
          if (!["P3", "P4", "P5"].includes(proof.proof_class)) reasons.push(`proof class ${proof.proof_class} is below P3`);
          if (proof.current.satisfied !== 1 || proof.current.total !== 1 || proof.current.violated || proof.current.unknown || proof.current.error) reasons.push("proof has no exact clean satisfied baseline");

          const plan = this.repository.listPlans({ privateOnly: true }).find((candidate) => candidate.content_hash === proof.plan_hash && candidate.policy_id === policy.id);
          if (!plan) reasons.push("proof has no exact bound private proof plan");
          const corpus = this.repository.getCorpus(policy.id, { privateOnly: true });
          corpusId = corpus?.id ?? null;
          if (!corpus) {
            reasons.push("policy has no imported private proof corpus");
          } else {
            if (!plan?.corpus_manifest || plan.corpus_manifest.id !== corpus.id || plan.corpus_manifest.content_hash !== corpus.content_hash) reasons.push("proof plan does not bind the exact imported corpus manifest");
            if (corpus.known_bad.length < 1) reasons.push("corpus has no declared known-bad fixture");
            else if (proof.known_bad.total !== corpus.known_bad.length || proof.known_bad.violated !== proof.known_bad.total) reasons.push("proof did not catch every imported known-bad fixture");
            if (corpus.known_good.length < 1) reasons.push("corpus has no declared known-good fixture");
            else if (proof.known_good.total !== corpus.known_good.length || proof.known_good.satisfied !== proof.known_good.total) reasons.push("proof did not satisfy every imported known-good fixture");
          }

          if (!plan?.mutations.length) reasons.push("proof plan has no mutation corpus");
          else {
            const available = [...proof.mutation_receipts];
            for (const mutation of plan.mutations.filter((candidate) => candidate.required)) {
              const index = available.findIndex((receipt) => receipt.operator === mutation.operator && receipt.required);
              const receipt = index >= 0 ? available.splice(index, 1)[0] : undefined;
              if (!receipt) reasons.push(`required mutation ${mutation.operator} has no exact receipt`);
              else if (!receipt.passed) reasons.push(`required mutation ${mutation.operator} failed`);
            }
          }
          if (proof.mutation_controls.total < 1) reasons.push("proof has no mutation controls");
          if (proof.mutation_controls.failed > 0 || proof.mutation_controls.passed !== proof.mutation_controls.total) reasons.push("proof mutation controls are incomplete or failed");

          const dispositionAssessment = assessHistoryDispositions(
            proof,
            this.repository.listDispositions({ privateOnly: true }).filter((record) => record.policy_id === policy.id && record.proof_id === proof.id),
          );
          if (dispositionAssessment.blocking_error) reasons.push(dispositionAssessment.blocking_error);

          try {
            const shadow = this.shadowReport(policy.id, { minApplicable: manifest?.min_shadow_applicable ?? 20 }, { privateOnly: true });
            shadowApplicable = shadow.counts.applicable;
            shadowViolations = shadow.counts.violated;
            shadowUnclassified = shadow.dispositions.unclassified;
            confirmedPrecision = shadow.precision.confirmed;
            if (shadowApplicable < (manifest?.min_shadow_applicable ?? 20)) reasons.push(`shadow baseline has ${shadowApplicable}/${manifest?.min_shadow_applicable ?? 20} applicable observations`);
            if (shadowUnclassified > 0) reasons.push(`shadow baseline has ${shadowUnclassified} unclassified violation(s)`);
          } catch (error) {
            reasons.push(`shadow precision baseline unavailable: ${(error as Error).message}`);
          }
        }
      }
      policyEvidence.push({
        policy_id: policyId,
        complete: reasons.length === 0,
        proof_id: proofId,
        corpus_id: corpusId,
        shadow_applicable: shadowApplicable,
        shadow_violations: shadowViolations,
        shadow_unclassified: shadowUnclassified,
        confirmed_precision: confirmedPrecision,
        reasons,
      });
    }

    for (const category of G2_RUNBOOK_CATEGORIES) {
      const runbookId = manifest?.runbooks[category];
      if (!runbookId) continue;
      const reasons: string[] = [];
      const runbook = privateRunbooks.find((candidate) => candidate.id === runbookId);
      const publicDuplicate = publicRunbooks.some((candidate) => candidate.id === runbookId);
      const hash = runbook ? runbookContentHash(runbook) : null;
      const rehearsal = hash ? currentRehearsals.find((candidate) => candidate.runbook_id === runbookId && candidate.runbook_hash === hash) : undefined;
      if (!runbook || publicDuplicate) reasons.push("selected runbook is missing from its exact private-only home");
      else if (!rehearsal) reasons.push("exact runbook content has no current rehearsal receipt");
      else if (rehearsal.result !== "passed") reasons.push(`current rehearsal result is ${rehearsal.result}`);
      runbookEvidence.push({ category, runbook_id: runbookId, runbook_hash: hash, rehearsal_id: rehearsal?.id ?? null, passed: rehearsal?.result === "passed", reasons });
    }

    return scoreG2Readiness({
      manifest,
      policy_evidence: policyEvidence,
      runbook_evidence: runbookEvidence,
      active_blocking_policy_ids: activeBlocking,
      inventory: {
        private_policies: privatePolicies.length,
        public_policies: publicPolicies.length,
        private_proofs: this.repository.listProofs({ privateOnly: true }).length,
        private_corpora: this.repository.listCorpora({ privateOnly: true }).length,
        private_shadow_evaluations: this.repository.listShadowEvaluations({ privateOnly: true }).length,
        private_shadow_dispositions: this.repository.listShadowDispositions({ privateOnly: true }).length,
        private_runbooks: privateRunbooks.length,
        public_runbooks: publicRunbooks.length,
        private_plans: this.g2Repository.listPlans().length,
        private_rehearsals: rehearsals.length,
      },
    });
  }

  registerG3Experiment(input: CompileExperimentPreregistrationInput, opts: { now?: string } = {}): ExperimentPreregistration {
    return this.g3Repository.putExperiment(compileExperimentPreregistration(input, opts));
  }

  createG3Plan(input: CompileG3PlanInput, opts: { now?: string } = {}) {
    const g2 = this.g2Readiness();
    if (g2.recommendation !== "eligible_for_human_g2_signoff" || !g2.manifest) {
      throw new Error("G3 plan requires an exact currently eligible private G2 packet");
    }
    const plan = compileG3Plan(input, opts);
    if (plan.g2_readiness_hash !== g2.content_hash) throw new Error(`G3 plan must bind current G2 readiness hash ${g2.content_hash}`);
    if (canonicalJson(plan.policy_ids) !== canonicalJson([...g2.manifest.policy_ids].sort())) {
      throw new Error("G3 plan must carry the complete exact G2 policy set; cherry-picked subsets cannot clear the advisory gate");
    }
    const currentExperiments = this.g3Repository.currentExperiments();
    const retrieval = currentExperiments.find((record) => record.experiment === "EXP-01");
    const compiler = currentExperiments.find((record) => record.experiment === "EXP-03");
    if (!retrieval || plan.experiments.retrieval !== retrieval.id) throw new Error("G3 plan must bind the exact current EXP-01 retrieval preregistration");
    if (!compiler || plan.experiments.compiler !== compiler.id) throw new Error("G3 plan must bind the exact current EXP-03 compiler preregistration");
    for (const policyId of plan.policy_ids) {
      const policy = this.repository.getPolicy(policyId, { privateOnly: true });
      const publicDuplicate = this.repository.getPolicy(policyId, { publicOnly: true });
      if (!policy || publicDuplicate || this.repository.homeOfPolicy(policyId) !== "private" || policy.data_class !== "private") {
        throw new Error(`G3 selected policy ${policyId} must exist only in the configured private overlay`);
      }
    }
    return this.g3Repository.putPlan(plan);
  }

  recordG3ProofReview(
    input: {
      policy_id: string;
      reviewer: string;
      duration_ms: number;
      comprehension: { requirement: "correct" | "incorrect"; limitations: "correct" | "incorrect"; authority: "correct" | "incorrect" };
      notes: string;
      supersedes?: string | null;
    },
    opts: { now?: string } = {},
  ): ProofReviewMeasurement {
    const plan = this.g3Repository.currentPlan();
    if (!plan) throw new Error("No current private G3 plan; proof review cannot bind an exact policy packet");
    if (!plan.policy_ids.includes(input.policy_id)) throw new Error(`policy ${input.policy_id} is not selected by current G3 plan ${plan.id}`);
    const policy = this.get(input.policy_id, { privateOnly: true });
    if (this.repository.getPolicy(input.policy_id, { publicOnly: true }) || this.repository.homeOfPolicy(input.policy_id) !== "private" || policy.data_class !== "private") {
      throw new Error(`G3 proof review policy ${input.policy_id} must exist only in the configured private overlay`);
    }
    if (!policy.proof) throw new Error(`policy ${input.policy_id} has no proof to review`);
    const proof = this.proof(policy.proof, { privateOnly: true });
    const card = this.card(policy.id, { privateOnly: true });
    return this.g3Repository.putReview(compileProofReviewMeasurement({
      plan_id: plan.id,
      policy_id: policy.id,
      policy_hash: policyProofHash(policy, this.composition(policy, { privateOnly: true })),
      proof_id: proof.id,
      proof_hash: canonicalHash(proof),
      card_hash: card.card_hash,
      reviewer: input.reviewer,
      duration_ms: input.duration_ms,
      comprehension: input.comprehension,
      notes: input.notes,
      supersedes: input.supersedes,
    }, opts));
  }

  g3AdapterConformance(opts: { timeoutMs?: number; now?: string } = {}): AdapterConformanceReceipt {
    const plan = this.g3Repository.currentPlan();
    if (!plan) throw new Error("No current private G3 plan; adapter conformance cannot bind an exact client set");
    const current = this.g3Repository.currentConformance().find((record) => record.plan_id === plan.id);
    const receipt = executeG3AdapterConformance(this.root, plan, { ...opts, supersedes: current?.id ?? null });
    return this.g3Repository.putConformance(receipt);
  }

  g3Readiness(): G3ReadinessReport {
    const manifest = this.g3Repository.currentPlan();
    const g2 = this.g2Readiness();
    const g2Evidence = new Map(g2.policy_evidence.map((evidence) => [evidence.policy_id, evidence]));
    const currentReviews = this.g3Repository.currentReviews();
    const policyEvidence: G3PolicyEvidence[] = [];
    for (const policyId of manifest?.policy_ids ?? []) {
      const reasons: string[] = [];
      const policy = this.repository.getPolicy(policyId, { privateOnly: true });
      const publicDuplicate = this.repository.getPolicy(policyId, { publicOnly: true });
      const g2Policy = g2Evidence.get(policyId);
      let cardHash: string | null = null;
      let proofCurrent = false;
      let review: ProofReviewMeasurement | null = null;
      if (!policy || publicDuplicate || this.repository.homeOfPolicy(policyId) !== "private" || policy.data_class !== "private") {
        reasons.push("selected policy is missing from its exact private-only home");
      } else {
        if (policy.state !== "active_advisory") reasons.push(`policy state is ${policy.state}, not active_advisory under explicit human authority`);
        if (policy.authority?.kind !== "human") reasons.push("policy has no explicit human advisory authority");
        if (!g2Policy?.complete) reasons.push("current G2 proof/corpus/shadow evidence is incomplete");
        try {
          const card = this.card(policyId, { privateOnly: true });
          cardHash = card.card_hash;
          proofCurrent = !!policy.proof && g2Policy?.proof_id === policy.proof;
          const matching = currentReviews.filter((candidate) => candidate.plan_id === manifest!.id && candidate.policy_id === policyId && candidate.card_hash === card.card_hash);
          if (matching.length !== 1) reasons.push(matching.length ? "multiple current proof reviews make the measurement target ambiguous" : "current proof card has no exact human review measurement");
          else {
            review = matching[0]!;
            if (review.policy_hash !== policyProofHash(policy, this.composition(policy, { privateOnly: true }))) reasons.push("proof review does not bind current policy/composite semantics");
            const proof = policy.proof ? this.proof(policy.proof, { privateOnly: true }) : null;
            if (!proof || review.proof_id !== proof.id || review.proof_hash !== canonicalHash(proof)) reasons.push("proof review does not bind the exact current proof artifact");
            if (Object.values(review.comprehension).some((answer) => answer !== "correct")) reasons.push("proof-card comprehension measurement contains an incorrect answer");
          }
        } catch (error) {
          reasons.push(`proof card is unavailable: ${(error as Error).message}`);
        }
      }
      policyEvidence.push({
        policy_id: policyId,
        state: policy?.state ?? null,
        authority_kind: policy?.authority?.kind ?? null,
        proof_current: proofCurrent,
        card_hash: cardHash,
        review_id: review?.id ?? null,
        review_duration_ms: review?.duration_ms ?? null,
        comprehension_correct: review ? Object.values(review.comprehension).every((answer) => answer === "correct") : null,
        reasons,
      });
    }
    const currentExperiments = this.g3Repository.currentExperiments();
    const experiments = G3_REQUIRED_EXPERIMENTS.map((experiment) => {
      const record = currentExperiments.find((candidate) => candidate.experiment === experiment);
      const expectedId = experiment === "EXP-01" ? manifest?.experiments.retrieval : manifest?.experiments.compiler;
      const reasons: string[] = [];
      if (!record) reasons.push("no current immutable preregistration exists");
      else if (expectedId && record.id !== expectedId) reasons.push(`current preregistration ${record.id} differs from plan-bound ${expectedId}`);
      if (!manifest) reasons.push("no G3 plan binds this preregistration");
      return { experiment, id: record?.id ?? null, content_hash: record?.content_hash ?? null, current: !!record && !!manifest && record.id === expectedId, reasons };
    });
    const conformance = manifest
      ? this.g3Repository.currentConformance().find((record) => record.plan_id === manifest.id
        && record.test.source_hash === g3ConformanceSourceHash(this.root)
        && record.test.file === "test/behavior-workspace.test.ts") ?? null
      : null;
    const activeBlocking = this.repository.listPolicies().filter((policy) => policy.state === "active_blocking").map((policy) => policy.id);
    return scoreG3Readiness({ manifest, g2_readiness: g2, policy_evidence: policyEvidence, experiments, conformance, active_blocking_policy_ids: activeBlocking });
  }

  validateExperimentCaseBank(input: CompileExperimentCaseBankInput, opts: { now?: string } = {}): ExperimentCaseBank {
    const preregistration = this.g3Repository.currentExperiments().find((item) => item.id === input.preregistration_id);
    if (!preregistration) throw new Error(`case bank must bind a current G3 preregistration: ${input.preregistration_id}`);
    return compileExperimentCaseBank(input, preregistration, opts);
  }

  lockExperimentCaseBank(input: CompileExperimentCaseBankInput, opts: { now?: string } = {}): ExperimentCaseBank {
    return this.experimentRepository.putCaseBank(this.validateExperimentCaseBank(input, opts));
  }

  createExperimentRun(caseBankId: string, input: CompileExperimentRunInput, opts: { now?: string } = {}): ExperimentRun {
    const bank = this.experimentRepository.listCaseBanks().find((item) => item.id === caseBankId);
    if (!bank) throw new Error(`unknown private experiment case bank: ${caseBankId}`);
    const preregistration = this.g3Repository.currentExperiments().find((item) => item.id === bank.preregistration_id);
    if (!preregistration) throw new Error(`case bank ${caseBankId} is not bound to a current preregistration`);
    return this.experimentRepository.putRun(compileExperimentRun(input, preregistration, bank, opts));
  }

  experimentRun(runId: string): ExperimentRun {
    const run = this.experimentRepository.listRuns().find((item) => item.id === runId);
    if (!run) throw new Error(`unknown private experiment run: ${runId}`);
    return run;
  }

  executeExperimentRun(runId: string, opts: { limit?: number; timeoutMs?: number; now?: string } = {}): { outcomes: ExperimentOutcome[]; report: ExperimentReport } {
    const run = this.experimentRun(runId);
    if (run.experiment !== "EXP-01") throw new Error("automated run execution is available only for EXP-01; use the timed review queue for EXP-03");
    const bank = this.experimentRepository.listCaseBanks().find((item) => item.id === run.case_bank_id);
    if (!bank) throw new Error(`run ${run.id} is missing exact case bank ${run.case_bank_id}`);
    const current = new Set(currentExperimentOutcomes(this.experimentRepository.listOutcomes()).filter((item) => item.run_id === run.id).map((item) => item.assignment_id));
    if (this.experimentReport(run.id).status === "guardrail_stopped") throw new Error("experiment is stopped by an independently recorded safety/privacy guardrail");
    const limit = opts.limit ?? 1;
    if (!Number.isInteger(limit) || limit < 1 || limit > run.assignments.length) throw new Error("experiment execution limit must be a positive integer within the assignment count");
    const outcomes: ExperimentOutcome[] = [];
    for (const assignment of [...run.assignments].sort((a, b) => a.order - b.order)) {
      if (outcomes.length >= limit) break;
      if (current.has(assignment.id)) continue;
      outcomes.push(executeExp01Assignment(this.experimentRepository, run, bank, assignment, { timeoutMs: opts.timeoutMs, now: opts.now }));
      if (this.experimentReport(run.id).status === "guardrail_stopped") break;
    }
    return { outcomes, report: this.experimentReport(run.id) };
  }

  nextExperimentReview(runId: string, reviewer: string, opts: { now?: string } = {}): { start: ExperimentReviewStart; assignment: ExperimentRun["assignments"][number]; treatment: unknown } {
    const run = this.experimentRun(runId);
    if (run.experiment !== "EXP-03") throw new Error("timed review queue is available only for EXP-03");
    if (this.experimentReport(run.id).status === "guardrail_stopped") throw new Error("experiment is stopped by an independently recorded safety/privacy guardrail");
    const bank = this.experimentRepository.listCaseBanks().find((item) => item.id === run.case_bank_id);
    if (!bank) throw new Error(`run ${run.id} is missing exact case bank ${run.case_bank_id}`);
    const current = new Set(currentExperimentOutcomes(this.experimentRepository.listOutcomes()).filter((item) => item.run_id === run.id).map((item) => item.assignment_id));
    const starts = this.experimentRepository.listReviewStarts().filter((item) => item.run_id === run.id);
    const existing = starts.find((item) => item.reviewer === reviewer && !current.has(item.assignment_id));
    const assignment = existing
      ? run.assignments.find((item) => item.id === existing.assignment_id)
      : [...run.assignments].sort((a, b) => a.order - b.order).find((item) => {
          if (current.has(item.id) || starts.some((start) => start.assignment_id === item.id)) return false;
          const c = bank.cases.find((candidate) => candidate.id === item.case_id);
          const assignedReviewer = c?.strata.reviewer;
          return !assignedReviewer || assignedReviewer === reviewer || assignedReviewer === reviewer.replace(/^human:/i, "");
        });
    if (!assignment) throw new Error(`no unreviewed EXP-03 assignment is available for ${reviewer}`);
    const start = existing ?? this.experimentRepository.putReviewStart(compileExperimentReviewStart(run, assignment, reviewer, opts));
    return { start, assignment, treatment: assignmentTreatment(bank, run, assignment) };
  }

  submitExperimentReview(
    runId: string,
    assignmentId: string,
    input: {
      reviewer: string;
      decision: "accepted_precise" | "accepted_edited" | "rejected" | "uncompilable" | "abandoned" | "timeout";
      precise: boolean;
      proof_inspected: boolean;
      result: string | null;
      silent_semantic_substitution: boolean;
      rejection_reason: string | null;
      confirmed_private_leak: boolean;
      data_loss_or_corruption: boolean;
      unsafe_evaluator_behavior: boolean;
      reason: string;
    },
    opts: { now?: string } = {},
  ): ExperimentOutcome {
    const run = this.experimentRun(runId);
    if (run.experiment !== "EXP-03") throw new Error("human review submission is available only for EXP-03");
    const start = this.experimentRepository.listReviewStarts().find((item) => item.run_id === run.id && item.assignment_id === assignmentId);
    if (!start || start.reviewer !== input.reviewer) throw new Error("review submission must bind the machine-recorded start and exact reviewer");
    const recordedAt = opts.now ?? new Date().toISOString();
    const duration = Date.parse(recordedAt) - Date.parse(start.started_at);
    if (!Number.isFinite(duration) || duration < 1) throw new Error("review completion must occur after the machine-recorded start");
    const current = currentExperimentOutcomes(this.experimentRepository.listOutcomes()).find((item) => item.run_id === run.id && item.assignment_id === assignmentId);
    if (current) throw new Error(`assignment ${assignmentId} already has current outcome ${current.id}; use an explicit append-only correction workflow`);
    const assignment = run.assignments.find((item) => item.id === assignmentId);
    const bank = this.experimentRepository.listCaseBanks().find((item) => item.id === run.case_bank_id);
    const item = bank?.cases.find((candidate) => candidate.id === assignment?.case_id);
    if (!assignment || !bank || !item || !("compiler_candidate" in item)) throw new Error("review submission cannot resolve the exact assigned case and treatment");
    const accepted = input.decision.startsWith("accepted");
    const result = input.result?.trim() || null;
    if (accepted !== (result !== null)) throw new Error("accepted reviews require a result; non-accepted reviews must not claim one");
    const editDistance = accepted && assignment.arm !== "A" ? normalizedEditDistance(item.compiler_candidate, result!) : null;
    return this.experimentRepository.putOutcome(compileExperimentOutcome({
      run_id: run.id,
      assignment_id: assignmentId,
      status: "completed",
      invocation_started: true,
      metrics: {
        decision: input.decision,
        precise: input.precise,
        proof_inspected: input.proof_inspected,
        result_hash: result ? canonicalHash(result) : null,
        semantic_edit_distance: editDistance,
        silent_semantic_substitution: input.silent_semantic_substitution,
        rejection_reason: input.rejection_reason,
        duration_ms: duration,
      },
      output_hash: canonicalHash({ decision: input.decision, precise: input.precise, rejection_reason: input.rejection_reason, result_hash: result ? canonicalHash(result) : null }),
      diff_hash: null,
      evaluator_hash: start.treatment_hash,
      error_code: null,
      incidents: {
        confirmed_private_leak: input.confirmed_private_leak,
        data_loss_or_corruption: input.data_loss_or_corruption,
        unsafe_evaluator_behavior: input.unsafe_evaluator_behavior,
      },
      recorder: input.reviewer,
      reason: input.reason,
      supersedes: null,
    }, run, { now: recordedAt }));
  }

  recordExperimentFollowup(
    runId: string,
    assignmentId: string,
    input: { reviewer: string; reversed: boolean | null; missing_reason: string | null; notes: string; supersedes?: string | null },
    opts: { now?: string } = {},
  ): ExperimentFollowup {
    const run = this.experimentRun(runId);
    const outcome = currentExperimentOutcomes(this.experimentRepository.listOutcomes()).find((item) => item.run_id === run.id && item.assignment_id === assignmentId);
    if (!outcome) throw new Error(`assignment ${assignmentId} has no current outcome to follow up`);
    return this.experimentRepository.putFollowup(compileExperimentFollowup({ ...input, supersedes: input.supersedes ?? null }, run, outcome, opts));
  }

  stopExperiment(
    runId: string,
    input: { category: ExperimentStop["category"]; actor: string; reason: string; evidence_hashes: string[] },
    opts: { now?: string } = {},
  ): ExperimentStop {
    const run = this.experimentRun(runId);
    return this.experimentRepository.putStop(compileExperimentStop(input, run, opts));
  }

  experimentReport(runId: string): ExperimentReport {
    const run = this.experimentRun(runId);
    const bank = this.experimentRepository.listCaseBanks().find((item) => item.id === run.case_bank_id);
    if (!bank) throw new Error(`run ${run.id} is missing exact case bank ${run.case_bank_id}`);
    return buildExperimentReport(run, bank, this.experimentRepository.listOutcomes(), this.experimentRepository.listFollowups(), this.experimentRepository.listStops());
  }

  g2ShadowSweep(opts: { now?: string } = {}): G2ShadowSweepReport {
    const manifest = this.g2Repository.currentPlan();
    const recorded: string[] = [];
    const existing: string[] = [];
    const failures: Array<{ policy_id: string; error: string }> = [];
    if (manifest) {
      const before = new Set(this.repository.listShadowEvaluations({ privateOnly: true }).map((record) => record.id));
      for (const policyId of manifest.policy_ids) {
        try {
          const policy = this.repository.getPolicy(policyId, { privateOnly: true });
          const publicDuplicate = this.repository.getPolicy(policyId, { publicOnly: true });
          if (!policy || publicDuplicate || this.repository.homeOfPolicy(policyId) !== "private" || policy.data_class === "public") {
            throw new Error("selected policy is not in one exact private-only home");
          }
          const record = this.recordShadow(policyId, { now: opts.now });
          if (before.has(record.id)) existing.push(record.id);
          else {
            recorded.push(record.id);
            before.add(record.id);
          }
        } catch (error) {
          failures.push({ policy_id: policyId, error: (error as Error).message });
        }
      }
    }
    const body = {
      plan_id: manifest?.id ?? null,
      selected: manifest?.policy_ids.length ?? 0,
      recorded: recorded.sort(),
      existing: existing.sort(),
      failures: failures.sort((left, right) => left.policy_id.localeCompare(right.policy_id)),
      skipped_reason: manifest ? null : "No current private G2 plan; shadow sweep wrote nothing.",
      authority: "none" as const,
      effects: "shadow_only" as const,
    };
    const contentHash = canonicalHash(body);
    return { id: `g2sweep_${shortHash(contentHash)}`, content_hash: contentHash, ...body };
  }

  g2ShadowBackfill(maxCommits = 20, opts: { now?: string } = {}): G2ShadowBackfillReport {
    if (!Number.isInteger(maxCommits) || maxCommits < 1 || maxCommits > 100) {
      throw new Error("G2 shadow backfill maxCommits must be a positive integer no greater than 100");
    }
    const manifest = this.g2Repository.currentPlan();
    const commits = manifest ? execFileSync("git", ["-C", this.root, "rev-list", "--first-parent", `--max-count=${maxCommits}`, "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().split("\n").filter((commit) => /^[a-f0-9]{40}$/.test(commit)) : [];
    const attempted = (manifest?.policy_ids.length ?? 0) * commits.length;
    const preflightFailures: G2ShadowBackfillReport["preflight_failures"] = [];
    const ineligible: G2ShadowBackfillReport["ineligible"] = [];
    const candidates: ShadowEvaluationRecord[] = [];
    if (manifest) {
      for (const commit of commits) {
        for (const policyId of manifest.policy_ids) {
          try {
            const policy = this.repository.getPolicy(policyId, { privateOnly: true });
            if (!policy) throw new Error("selected policy is missing from the private overlay");
            if (!shadowCommitEligible(this.root, policy, commit)) {
              ineligible.push({ policy_id: policyId, commit, reason: "commit predates the executable policy fixing commit" });
              continue;
            }
            const record = this.compileShadowRecord(policyId, { commit, now: opts.now });
            if (record.evaluation.result === "unknown" || record.evaluation.result === "error") {
              preflightFailures.push({ policy_id: policyId, commit, error: record.evaluation.explanation });
            } else {
              candidates.push(record);
            }
          } catch (error) {
            preflightFailures.push({ policy_id: policyId, commit, error: (error as Error).message });
          }
        }
      }
    }
    const recorded: string[] = [];
    const existing: string[] = [];
    if (manifest && !preflightFailures.length) {
      const before = new Set(this.repository.listShadowEvaluations({ privateOnly: true }).map((record) => record.id));
      for (const candidate of candidates) {
        const stored = this.repository.putShadowEvaluation(candidate, candidate.policy_id);
        if (before.has(stored.id)) existing.push(stored.id);
        else {
          recorded.push(stored.id);
          before.add(stored.id);
        }
      }
    }
    const skippedReason = !manifest
      ? "No current private G2 plan; historical shadow backfill wrote nothing."
      : preflightFailures.length
        ? "Historical shadow preflight produced unknown/error evidence; the batch wrote nothing."
        : null;
    const body = {
      plan_id: manifest?.id ?? null,
      max_commits: maxCommits,
      commits,
      selected: manifest?.policy_ids.length ?? 0,
      attempted,
      recorded: recorded.sort(),
      existing: existing.sort(),
      ineligible: ineligible.sort((left, right) => left.commit.localeCompare(right.commit) || left.policy_id.localeCompare(right.policy_id)),
      preflight_failures: preflightFailures.sort((left, right) => left.commit.localeCompare(right.commit) || left.policy_id.localeCompare(right.policy_id)),
      skipped_reason: skippedReason,
      authority: "none" as const,
      effects: "shadow_only" as const,
      writes: manifest && !preflightFailures.length ? "atomic_after_preflight" as const : "none" as const,
    };
    const contentHash = canonicalHash(body);
    return { id: `g2backfill_${shortHash(contentHash)}`, content_hash: contentHash, ...body };
  }

  g2OperationalDrill(category: (typeof G2_RUNBOOK_CATEGORIES)[number]): G2OperationalDrillReceipt {
    const manifest = this.g2Repository.currentPlan();
    if (!manifest) throw new Error("No current private G2 plan; operational drill cannot bind an exact runbook");
    if (!G2_RUNBOOK_CATEGORIES.includes(category)) throw new Error(`unknown G2 operational drill category ${category}`);
    const runbookId = manifest.runbooks[category];
    const runbook = this.store.getPrivateRec("runbooks", runbookId);
    const publicDuplicate = this.store.recsInHome("runbooks", "public").some((candidate) => candidate.id === runbookId);
    if (!runbook || publicDuplicate) throw new Error(`G2 ${category} runbook ${runbookId} is not in one exact private-only home`);
    return executeG2OperationalDrill(this.root, manifest, runbook, category);
  }

  g2CandidateReview(opts: G2CandidateReviewOptions = {}): G2CandidateReviewReport {
    return buildG2CandidateReview(this.store, this.root, opts, this.g2CandidateRepository.resolutions());
  }

  attestG2Candidate(
    candidateId: string,
    reviewHash: string,
    disposition: "selected" | "rejected",
    actor: string,
    reason: string,
    opts: G2CandidateReviewOptions & { now?: string; supersedes?: string | null } = {},
  ): G2CandidateAttestation {
    const existing = this.g2CandidateRepository.current().find((record) => (
      record.candidate_id === candidateId
      && record.review_hash === reviewHash
      && record.disposition === disposition
      && record.actor === actor
      && record.reason === reason.trim()
      && record.supersedes === (opts.supersedes ?? null)
    ));
    if (existing) return existing;
    const report = this.g2CandidateReview(opts);
    const attestation = compileG2CandidateAttestation(report, candidateId, reviewHash, disposition, actor, reason, opts);
    return this.g2CandidateRepository.put(attestation);
  }

  g2BehaviorCandidateReview(opts: G2BehaviorCandidateReviewOptions = {}): G2BehaviorCandidateReview {
    return buildG2BehaviorCandidateReview(
      this.store,
      this.root,
      opts,
      this.g2CandidateRepository.resolutions(),
      this.g2BehaviorAttestationRepository.resolutions(),
    );
  }

  g2BehaviorCandidateReplay(
    candidateId: string,
    reviewHash: string,
    opts: G2BehaviorCandidateReviewOptions & { timeoutMs?: number } = {},
  ): G2BehaviorReplayReceipt {
    const report = this.g2BehaviorCandidateReview(opts);
    return replayG2BehaviorCandidate(this.root, report, candidateId, reviewHash, { timeoutMs: opts.timeoutMs });
  }

  g2BehaviorMaterializationAssessment(
    opts: G2BehaviorCandidateReviewOptions = {},
  ): G2BehaviorMaterializationAssessment {
    const report = this.g2BehaviorCandidateReview(opts);
    return assessG2BehaviorMaterialization(report, this.g2BehaviorAttestationRepository.current());
  }

  g2BehaviorPolicyMaterialize(
    opts: G2BehaviorCandidateReviewOptions & { allowInstallScripts?: string[]; dependencyTimeoutMs?: number; now?: string } = {},
  ): G2BehaviorPolicyMaterialization {
    const report = this.g2BehaviorCandidateReview(opts);
    return materializeSelectedG2BehaviorPolicies(
      this.store,
      this.root,
      this.repository,
      report,
      this.g2BehaviorAttestationRepository.current(),
      opts,
    );
  }

  g2BehaviorDependencySnapshots(
    candidateId: string,
    reviewHash: string,
    opts: G2BehaviorCandidateReviewOptions & { allowInstallScripts?: string[]; timeoutMs?: number } = {},
  ): G2BehaviorDependencySnapshotReceipt {
    const report = this.g2BehaviorCandidateReview(opts);
    if (reviewHash !== report.content_hash) throw new Error("behavior candidate review hash does not match the exact current review packet");
    const candidate = report.items.find((item) => item.id === candidateId);
    if (!candidate) throw new Error(`behavior candidate ${candidateId} is not present in review ${report.id}`);
    return provisionG2BehaviorDependencySnapshots(
      this.root,
      report,
      candidate,
      opts.allowInstallScripts ?? [],
      opts.timeoutMs ?? 300_000,
    );
  }

  attestG2BehaviorCandidate(
    candidateId: string,
    reviewHash: string,
    disposition: "selected" | "rejected",
    actor: string,
    reason: string,
    opts: G2BehaviorCandidateReviewOptions & { timeoutMs?: number; now?: string; supersedes?: string | null } = {},
  ): G2BehaviorAttestation {
    const existing = this.g2BehaviorAttestationRepository.current().find((record) => (
      record.candidate_id === candidateId
      && record.review_hash === reviewHash
      && record.disposition === disposition
      && record.actor === actor
      && record.reason === reason.trim()
      && record.supersedes === (opts.supersedes ?? null)
    ));
    if (existing) return existing;
    const report = this.g2BehaviorCandidateReview(opts);
    const replay = replayG2BehaviorCandidate(this.root, report, candidateId, reviewHash, { timeoutMs: opts.timeoutMs });
    const attestation = compileG2BehaviorAttestation(report, candidateId, reviewHash, replay, disposition, actor, reason, opts);
    return this.g2BehaviorAttestationRepository.put(attestation);
  }

  g2ShadowQueue(limit = 20): G2ShadowQueue {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("G2 shadow queue limit must be a positive integer no greater than 100");
    const manifest = this.g2Repository.currentPlan();
    const policies = this.repository.listPolicies({ privateOnly: true });
    const proofs = this.repository.listProofs({ privateOnly: true });
    const currentDispositions = currentShadowDispositions(this.repository.listShadowDispositions({ privateOnly: true }));
    const exactRecords = this.repository.listShadowEvaluations({ privateOnly: true }).filter((record) => {
      if (!manifest?.policy_ids.includes(record.policy_id)) return false;
      const policy = policies.find((candidate) => candidate.id === record.policy_id);
      const publicDuplicate = this.repository.getPolicy(record.policy_id, { publicOnly: true });
      if (!policy || publicDuplicate || policy.proof !== record.proof_id) return false;
      const proof = proofs.find((candidate) => candidate.id === record.proof_id);
      if (!proof || proof.policy_hash !== record.policy_hash) return false;
      if (!shadowCommitEligible(this.root, policy, record.evaluation.repository.head)) return false;
      const composition = compositionDescendants(policy, policies);
      return proof.policy_hash === policyProofHash(policy, composition);
    });
    const unclassified = exactRecords
      .filter((record) => record.evaluation.result === "violated")
      .filter((record) => !currentDispositions.some((disposition) => disposition.shadow_id === record.id
        && disposition.policy_id === record.policy_id
        && disposition.proof_id === record.proof_id
        && disposition.policy_hash === record.policy_hash
        && disposition.evaluation_hash === record.evaluation.deterministic_hash))
      .sort((left, right) => left.observed_at.localeCompare(right.observed_at) || left.id.localeCompare(right.id));
    const items: G2ShadowQueueItem[] = unclassified.slice(0, limit).map((record) => ({
      policy_id: record.policy_id,
      shadow_id: record.id,
      proof_id: record.proof_id,
      policy_hash: record.policy_hash,
      evaluation_hash: record.evaluation.deterministic_hash,
      observed_at: record.observed_at,
      result: "violated",
      explanation: record.evaluation.explanation,
      matches: record.evaluation.matches,
    }));
    const body = {
      plan_id: manifest?.id ?? null,
      total_unclassified: unclassified.length,
      unresolved_unknown_error: exactRecords.filter((record) => record.evaluation.result === "unknown" || record.evaluation.result === "error").length,
      limit,
      items,
      has_more: unclassified.length > items.length,
      authority: "none" as const,
    };
    const contentHash = canonicalHash(body);
    return { id: `g2queue_${shortHash(contentHash)}`, content_hash: contentHash, ...body };
  }

  list(opts: { publicOnly?: boolean; privateOnly?: boolean; state?: string } = {}): PolicySpec[] {
    const all = this.repository.listPolicies(opts);
    return opts.state ? all.filter((p) => p.state === opts.state) : all;
  }

  get(id: string, opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): PolicySpec {
    const policy = this.repository.getPolicy(id, opts);
    if (!policy) throw new Error(`policy ${id} not found`);
    return policy;
  }

  private composition(policy: PolicySpec, opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): PolicySpec[] {
    return compositionDescendants(policy, this.list(opts));
  }

  proof(id: string, opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): PolicyProof {
    const proof = this.repository.getProof(id, opts);
    if (!proof) throw new Error(`proof ${id} not found`);
    return proof;
  }

  card(id: string, opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): ProofCard {
    const policy = this.get(id, opts);
    if (!policy.proof) throw new Error(`policy ${id} has no proof`);
    const proof = this.proof(policy.proof, opts);
    const dispositions = this.repository.listDispositions(opts).filter((record) => record.policy_id === policy.id && record.proof_id === proof.id);
    const shadow = this.shadowReport(id, {}, opts);
    return buildProofCard(policy, proof, dispositions, this.composition(policy, opts), shadow.counts.total || shadow.counts.stale_excluded ? shadow : null);
  }

  corpus(id: string, opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): ProofCorpus {
    this.get(id, opts);
    const corpus = this.repository.getCorpus(id, opts);
    if (!corpus) throw new Error(`policy ${id} has no imported proof corpus`);
    return corpus;
  }

  importCorpus(id: string, raw: unknown, opts: { now?: string } = {}): ProofCorpus {
    const policy = this.get(id);
    const compiled = compileProofCorpus(this.root, policy, raw, opts);
    const home = this.repository.homeOfPolicy(policy.id);
    const existing = this.repository.getCorpus(policy.id, home === "public" ? { publicOnly: true } : { privateOnly: true });
    return existing?.id === compiled.id ? existing : this.repository.putCorpus(compiled, policy.id);
  }

  compile(decisionId: string, opts: CompilePolicyOptions = {}): PolicySpec {
    const compiled = compileDecisionPolicy(this.store, decisionId, opts);
    const home = compiled.private || this.store.unified
      ? { privateOnly: true }
      : { publicOnly: true };
    const existing = this.repository.getPolicy(compiled.policy.id, home);
    if (existing) return existing;
    return this.repository.putPolicy(compiled.policy, { private: compiled.private });
  }

  bootstrap(opts: BootstrapOptions = {}): BootstrapReport {
    return opts.history
      ? bootstrapStructuralPolicies(this.store, this.root, this.repository, opts)
      : bootstrapPolicies(this.store, this.root, this.repository, opts);
  }

  inspectStructural(decisionId: string, opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): StructuralInspection {
    return inspectStructuralDecision(this.store, this.root, decisionId, opts);
  }

  ingest(opts: LocalEvidenceOptions = {}): LocalEvidenceReport {
    return ingestLocalEvidence(this.store, this.root, this.repository, opts);
  }

  plan(id: string, opts: ProofPlanOptions = {}): ProofPlan {
    const policy = this.get(id, opts);
    const home = opts.publicOnly ? "public" : opts.privateOnly ? "private" : this.repository.homeOfPolicy(id);
    const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
    const composition = this.composition(policy, homeOpts);
    const generated = createProofPlan(this.store, this.root, this.repository, policy, { ...opts, ...homeOpts, composition });
    return this.repository.getPlan(generated.id, homeOpts)
      ?? this.repository.putPlan(generated, policy.id, { private: home === "private", public: home === "public" });
  }

  prove(id: string, opts: { now?: string } = {}): { policy: PolicySpec; proof: PolicyProof } {
    const policy = this.get(id);
    const behaviorBindingError = executableBehaviorAttestationError(policy, this.g2BehaviorAttestationRepository.current());
    if (behaviorBindingError) throw new Error(behaviorBindingError);
    const publicOnly = policy.data_class === "public" && this.repository.homeOfPolicy(id) === "public";
    const homeOpts = publicOnly ? { publicOnly: true } : { privateOnly: true };
    const composition = this.composition(policy, homeOpts);
    const plan = this.plan(id, { publicOnly, now: opts.now });
    const proof = provePolicy(this.store, this.root, policy, { publicOnly, now: opts.now, plan, composition });
    this.repository.putProof(proof, policy.id);
    const proposed = proposeProvedPolicy(policy, proof, opts.now ?? proof.generated_at, composition, this.g2BehaviorAttestationRepository.current());
    return { policy: this.repository.putPolicy(proposed), proof };
  }

  approve(id: string, mode: "advisory" | "blocking", actor: string, opts: { now?: string } = {}): PolicySpec {
    const policy = this.get(id);
    const behaviorBindingError = executableBehaviorAttestationError(policy, this.g2BehaviorAttestationRepository.current());
    if (behaviorBindingError) throw new Error(behaviorBindingError);
    if (!policy.proof) throw new Error(`policy ${id} has no proof`);
    const home = this.repository.homeOfPolicy(id);
    const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
    const proof = this.proof(policy.proof, homeOpts);
    const dispositions = this.repository.listDispositions(homeOpts).filter((record) => record.policy_id === id && record.proof_id === proof.id);
    const composition = this.composition(policy, homeOpts);
    const approved = approvePolicy(policy, proof, mode, actor, opts.now ?? new Date().toISOString(), dispositions, composition, this.g2BehaviorAttestationRepository.current());
    return this.repository.putPolicy(approved);
  }

  historyDispositions(id: string, opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): PolicyHistoryDispositionView {
    const policy = this.get(id, opts);
    if (!policy.proof) throw new Error(`policy ${id} has no proof`);
    const proof = this.proof(policy.proof, opts);
    const audit = this.repository.listDispositions(opts).filter((record) => record.policy_id === id && record.proof_id === proof.id);
    const current = currentHistoryDispositions(audit);
    const violations = proof.replay_receipts
      .filter((receipt) => receipt.leg === "accepted_history" && receipt.result === "violated")
      .map((receipt) => ({
        commit: receipt.commit,
        receipt_hash: receipt.deterministic_hash,
        disposition: current.find((record) => record.commit === receipt.commit && record.receipt_hash === receipt.deterministic_hash) ?? null,
      }));
    return { policy_id: id, proof_id: proof.id, violations, current, audit };
  }

  classifyHistory(
    id: string,
    commit: string,
    classification: HistoryDispositionClassification,
    actor: string,
    reason: string,
    opts: { now?: string; supersedes?: string | null } = {},
  ): HistoryDisposition {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("history disposition commit must be a full lowercase 40-character SHA");
    const policy = this.get(id);
    if (!policy.proof) throw new Error(`policy ${id} has no proof`);
    const home = this.repository.homeOfPolicy(id);
    const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
    const proof = this.proof(policy.proof, homeOpts);
    const receipt = proof.replay_receipts.find((candidate): candidate is ReplayReceipt => candidate.leg === "accepted_history" && candidate.result === "violated" && candidate.commit === commit);
    if (!receipt) throw new Error(`proof ${proof.id} has no violated accepted-history receipt for commit ${commit}`);
    const disposition = compileHistoryDisposition(policy, proof, receipt, classification, actor, reason, {
      ...opts,
      composition: this.composition(policy, homeOpts),
    });
    return this.repository.putDisposition(disposition, policy.id);
  }

  private compileShadowRecord(id: string, opts: { now?: string; latencyMs?: number; commit?: string } = {}): ShadowEvaluationRecord {
    const policy = this.get(id);
    if (!policy.proof) throw new Error(`policy ${id} has no proof`);
    const home = this.repository.homeOfPolicy(id);
    const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
    const proof = this.proof(policy.proof, homeOpts);
    const composition = this.composition(policy, homeOpts);
    const expectedHash = policyProofHash(policy, composition);
    if (proof.policy_hash !== expectedHash) throw new Error(`proof ${proof.id} does not match current policy semantics`);
    const started = performance.now();
    const currentHead = headSha(this.root);
    let evaluation: PolicyEvaluation;
    if (opts.commit && policy.assertion.kind === "executable-behavior") {
      evaluation = evaluateExecutableBehaviorPolicy(this.root, policy, { commit: opts.commit });
    } else if (opts.commit && opts.commit !== currentHead) {
      throw new Error(`historical shadow backfill supports executable-behavior policies only; ${policy.id} is ${policy.assertion.kind}`);
    } else {
      evaluation = evaluatePolicy(this.store, this.root, policy, { publicOnly: home === "public", composition });
    }
    const latencyMs = opts.latencyMs ?? performance.now() - started;
    const sameMatches = canonicalJson(evaluation.matches);
    const alsoDetectedBy = evaluation.result === "violated"
      && (!opts.commit || opts.commit === currentHead)
      ? this.evaluate({ activeOnly: true, publicOnly: home === "public" })
        .filter((candidate) => candidate.policy.id !== id
          && candidate.evaluation.result === "violated"
          && canonicalJson(candidate.evaluation.matches) === sameMatches)
        .map((candidate) => candidate.policy.id)
      : [];
    const record = compileShadowEvaluation(policy, proof, expectedHash, evaluation, alsoDetectedBy, latencyMs, opts.now);
    return record;
  }

  recordShadow(id: string, opts: { now?: string; latencyMs?: number; commit?: string } = {}): ShadowEvaluationRecord {
    const record = this.compileShadowRecord(id, opts);
    return this.repository.putShadowEvaluation(record, record.policy_id);
  }

  classifyShadow(
    id: string,
    shadowId: string,
    classification: HistoryDispositionClassification,
    actor: string,
    reason: string,
    opts: { now?: string; supersedes?: string | null } = {},
  ): ShadowDisposition {
    const policy = this.get(id);
    const home = this.repository.homeOfPolicy(id);
    const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
    const evaluation = this.repository.listShadowEvaluations(homeOpts).find((record) => record.id === shadowId && record.policy_id === id);
    if (!evaluation) throw new Error(`shadow evaluation ${shadowId} not found for policy ${id}`);
    return this.repository.putShadowDisposition(compileShadowDisposition(evaluation, classification, actor, reason, opts), policy.id);
  }

  shadowReport(
    id: string,
    thresholds: Partial<ShadowPrecisionThresholds> = {},
    opts: { publicOnly?: boolean; privateOnly?: boolean } = {},
  ): PolicyShadowView {
    const policy = this.get(id, opts);
    if (!policy.proof) throw new Error(`policy ${id} has no proof`);
    const proof = this.proof(policy.proof, opts);
    const records = this.repository.listShadowEvaluations(opts).filter((record) => record.policy_id === id);
    const audit = this.repository.listShadowDispositions(opts).filter((record) => record.policy_id === id);
    const current = currentShadowDispositions(audit);
    const history = this.repository.listDispositions(opts).filter((record) => record.policy_id === id && record.proof_id === proof.id);
    const scoringRecords = records.filter((record) => shadowCommitEligible(this.root, policy, record.evaluation.repository.head));
    const report = scoreShadowPrecision(policy, proof, scoringRecords, audit, history, thresholds);
    return {
      ...report,
      evaluations: records.map((record) => ({
        record,
        disposition: current.find((candidate) => candidate.shadow_id === record.id) ?? null,
      })),
      disposition_audit: audit,
    };
  }

  demote(id: string, actor: string, reason: string, opts: { now?: string } = {}): PolicySpec {
    const policy = this.get(id);
    const demoted = demotePolicy(policy, actor, reason, opts.now ?? new Date().toISOString());
    return this.repository.putPolicy(demoted);
  }

  linkException(id: string, parentId: string, actor: string, reason: string, opts: { now?: string } = {}): PolicySpec {
    const child = this.get(id);
    const parent = this.get(parentId);
    const childHome = this.repository.homeOfPolicy(child.id);
    const parentHome = this.repository.homeOfPolicy(parent.id);
    if (childHome !== parentHome) throw new Error("exception and parent must live in the same public/private policy home");
    const linked = linkPolicyException(child, parent, actor, reason, opts.now ?? new Date().toISOString());
    return this.repository.putPolicy(linked, { private: childHome === "private" });
  }

  relations(id: string, opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): PolicyExceptionRelations {
    const policy = this.get(id, opts);
    const policies = this.list(opts);
    const parent = policy.exception_of
      ? policies.find((candidate) => candidate.id === policy.exception_of)
      : undefined;
    return {
      policy: relationSummary(policy),
      exception_parent: parent ? relationSummary(parent) : null,
      missing_exception_parent: policy.exception_of && !parent ? policy.exception_of : null,
      exceptions: policies
        .filter((candidate) => candidate.exception_of === policy.id)
        .map(relationSummary),
    };
  }

  consolidation(id: string, opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): PolicyConsolidationCandidate {
    const anchor = this.get(id, opts);
    const suggestion = anchor.candidate.scope_suggestion;
    if (!suggestion) {
      return {
        anchor: relationSummary(anchor),
        suggested_scope: null,
        status: "unavailable",
        members: [],
        independent_decisions: [],
        counterexamples: [],
        conflicts: [],
        exception_linked_members: [],
        reasons: ["Policy has no compiler-produced advisory scope suggestion; consolidation is unavailable."],
      };
    }
    if (anchor.exception_of) {
      return {
        anchor: relationSummary(anchor),
        suggested_scope: suggestion,
        status: "unavailable",
        members: [],
        independent_decisions: [],
        counterexamples: [],
        conflicts: [],
        exception_linked_members: [anchor.id],
        reasons: ["An explicit exception policy cannot anchor consolidation until combined exception semantics are implemented and proved."],
      };
    }
    const assertion = canonicalJson(anchor.assertion);
    const policies = this.list(opts);
    const members = policies
      .filter((candidate) => candidate.data_class === anchor.data_class)
      .filter((candidate) => canonicalJson(candidate.assertion) === assertion)
      .filter((candidate) => candidate.exception_of === null)
      .filter((candidate) => scopeFallsWithin(candidate.scope, suggestion));
    const independentDecisions = [...new Set(members.flatMap((candidate) => candidate.legacy_refs.filter((ref) => ref.startsWith("dec_"))))].sort();
    const counterexamples = [...new Set(members.flatMap((candidate) => candidate.candidate.counterexamples))].sort();
    const conflicts = [...new Set(members.flatMap((candidate) => candidate.candidate.conflicts))].sort();
    const exceptionLinkedMembers = members
      .filter((candidate) => policies.some((other) => other.exception_of === candidate.id))
      .map((candidate) => candidate.id);
    const active = members.filter((candidate) => candidate.state === "active_advisory" || candidate.state === "active_blocking").map((candidate) => candidate.id);
    const reasons = [
      "Candidate is an advisory review packet only; no policy is merged, widened, evaluated, activated, or enforced.",
      ...(members.length < 3 ? [`Only ${members.length} matching narrow policy record(s) fall within the suggested scope; at least three are required.`] : []),
      ...(independentDecisions.length < 3 ? [`Only ${independentDecisions.length} independent decision reference(s) support the group; at least three are required.`] : []),
      ...(counterexamples.length ? [`${counterexamples.length} counterexample signal(s) challenge broader consolidation.`] : []),
      ...(conflicts.length ? [`${conflicts.length} direct conflict signal(s) require human disposition first.`] : []),
      ...(exceptionLinkedMembers.length ? [`Exception-linked policy member(s) require combined exception semantics first: ${exceptionLinkedMembers.join(", ")}.`] : []),
      ...(active.length ? [`Active policy member(s) require explicit human migration rather than consolidation: ${active.join(", ")}.`] : []),
    ];
    const reviewable = members.length >= 3
      && independentDecisions.length >= 3
      && counterexamples.length === 0
      && conflicts.length === 0
      && exceptionLinkedMembers.length === 0
      && active.length === 0;
    return {
      anchor: relationSummary(anchor),
      suggested_scope: suggestion,
      status: reviewable ? "reviewable" : "challenged",
      members: members.map(relationSummary),
      independent_decisions: independentDecisions,
      counterexamples,
      conflicts,
      exception_linked_members: exceptionLinkedMembers,
      reasons,
    };
  }

  evaluate(opts: { id?: string; activeOnly?: boolean; publicOnly?: boolean; behavior?: BehaviorEvaluationOptions } = {}): PolicyEvaluationSet[] {
    let policies = opts.id ? [this.get(opts.id, opts)] : this.list(opts);
    if (opts.activeOnly) policies = policies.filter(policyIsActive);
    return policies.map((policy) => {
      const composition = this.composition(policy, opts);
      const evaluation = evaluatePolicy(this.store, this.root, policy, { publicOnly: opts.publicOnly, composition, behavior: opts.behavior });
      let proof: PolicyProof | undefined;
      let dispositions: HistoryDisposition[] = [];
      if (policy.state === "active_blocking" && policy.proof) {
        const home = opts.publicOnly ? "public" : this.repository.homeOfPolicy(policy.id);
        const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
        proof = this.repository.getProof(policy.proof, homeOpts);
        dispositions = this.repository.listDispositions(homeOpts).filter((record) => record.policy_id === policy.id && record.proof_id === policy.proof);
      }
      const behaviorBindingError = executableBehaviorAttestationError(policy, this.g2BehaviorAttestationRepository.current());
      const gateError = behaviorBindingError ?? blockingProofError(policy, proof, dispositions, composition, this.g2BehaviorAttestationRepository.current());
      return {
        policy,
        evaluation,
        blocks: !gateError && policyBlocks(policy, evaluation),
        strict_error: policy.state === "active_blocking" && (evaluation.result === "error" || !!gateError),
        ...(gateError ? { gate_error: gateError } : {}),
      };
    });
  }
}
