import type { HunchStore } from "../store/hunchStore.js";
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
import { MUTATION_ENGINE, POLICY_EVALUATOR } from "./schema.js";
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
  type G2ShadowSweepReport,
  type RunbookRehearsal,
} from "./g2.js";

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

export class ConstitutionService {
  readonly repository: PolicyRepository;
  readonly g2Repository: G2EvidenceRepository;

  constructor(private readonly store: HunchStore, private readonly root: string) {
    this.repository = new PolicyRepository(root, store);
    this.g2Repository = new G2EvidenceRepository(store);
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
        const composition = compositionDescendants(policy, privatePolicies);
        const proof = this.repository.getProof(policy.proof, { privateOnly: true });
        proofId = proof?.id ?? null;
        if (!proof) {
          reasons.push(`linked proof ${policy.proof} is missing from the private overlay`);
        } else {
          if (proof.policy_hash !== policyProofHash(policy, composition)) reasons.push("proof does not bind current policy/composite semantics");
          if (proof.evaluator.name !== POLICY_EVALUATOR.name || proof.evaluator.version !== POLICY_EVALUATOR.version) reasons.push("proof evaluator version is stale");
          if (proof.mutation_engine?.name !== MUTATION_ENGINE.name || proof.mutation_engine.version !== MUTATION_ENGINE.version) reasons.push("proof mutation engine version is stale");
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
    const publicOnly = policy.data_class === "public" && this.repository.homeOfPolicy(id) === "public";
    const homeOpts = publicOnly ? { publicOnly: true } : { privateOnly: true };
    const composition = this.composition(policy, homeOpts);
    const plan = this.plan(id, { publicOnly, now: opts.now });
    const proof = provePolicy(this.store, this.root, policy, { publicOnly, now: opts.now, plan, composition });
    this.repository.putProof(proof, policy.id);
    const proposed = proposeProvedPolicy(policy, proof, opts.now ?? proof.generated_at, composition);
    return { policy: this.repository.putPolicy(proposed), proof };
  }

  approve(id: string, mode: "advisory" | "blocking", actor: string, opts: { now?: string } = {}): PolicySpec {
    const policy = this.get(id);
    if (!policy.proof) throw new Error(`policy ${id} has no proof`);
    const home = this.repository.homeOfPolicy(id);
    const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
    const proof = this.proof(policy.proof, homeOpts);
    const dispositions = this.repository.listDispositions(homeOpts).filter((record) => record.policy_id === id && record.proof_id === proof.id);
    const composition = this.composition(policy, homeOpts);
    const approved = approvePolicy(policy, proof, mode, actor, opts.now ?? new Date().toISOString(), dispositions, composition);
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

  recordShadow(id: string, opts: { now?: string; latencyMs?: number } = {}): ShadowEvaluationRecord {
    const policy = this.get(id);
    if (!policy.proof) throw new Error(`policy ${id} has no proof`);
    const home = this.repository.homeOfPolicy(id);
    const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
    const proof = this.proof(policy.proof, homeOpts);
    const composition = this.composition(policy, homeOpts);
    const expectedHash = policyProofHash(policy, composition);
    if (proof.policy_hash !== expectedHash) throw new Error(`proof ${proof.id} does not match current policy semantics`);
    const started = performance.now();
    const evaluation = evaluatePolicy(this.store, this.root, policy, { publicOnly: home === "public", composition });
    const latencyMs = opts.latencyMs ?? performance.now() - started;
    const sameMatches = canonicalJson(evaluation.matches);
    const alsoDetectedBy = evaluation.result === "violated"
      ? this.evaluate({ activeOnly: true, publicOnly: home === "public" })
        .filter((candidate) => candidate.policy.id !== id
          && candidate.evaluation.result === "violated"
          && canonicalJson(candidate.evaluation.matches) === sameMatches)
        .map((candidate) => candidate.policy.id)
      : [];
    const record = compileShadowEvaluation(policy, proof, expectedHash, evaluation, alsoDetectedBy, latencyMs, opts.now);
    return this.repository.putShadowEvaluation(record, policy.id);
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
    const report = scoreShadowPrecision(policy, proof, records, audit, history, thresholds);
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

  evaluate(opts: { id?: string; activeOnly?: boolean; publicOnly?: boolean } = {}): PolicyEvaluationSet[] {
    let policies = opts.id ? [this.get(opts.id, opts)] : this.list(opts);
    if (opts.activeOnly) policies = policies.filter(policyIsActive);
    return policies.map((policy) => {
      const composition = this.composition(policy, opts);
      const evaluation = evaluatePolicy(this.store, this.root, policy, { publicOnly: opts.publicOnly, composition });
      let proof: PolicyProof | undefined;
      let dispositions: HistoryDisposition[] = [];
      if (policy.state === "active_blocking" && policy.proof) {
        const home = opts.publicOnly ? "public" : this.repository.homeOfPolicy(policy.id);
        const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
        proof = this.repository.getProof(policy.proof, homeOpts);
        dispositions = this.repository.listDispositions(homeOpts).filter((record) => record.policy_id === policy.id && record.proof_id === policy.proof);
      }
      const gateError = blockingProofError(policy, proof, dispositions, composition);
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
