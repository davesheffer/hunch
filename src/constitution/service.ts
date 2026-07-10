import type { HunchStore } from "../store/hunchStore.js";
import { canonicalJson } from "./canonical.js";
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
import type { HistoryDisposition, HistoryDispositionClassification, ReplayReceipt } from "./schema.js";

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

  constructor(private readonly store: HunchStore, private readonly root: string) {
    this.repository = new PolicyRepository(root, store);
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
    return buildProofCard(policy, proof, dispositions);
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
    const generated = createProofPlan(this.store, this.root, this.repository, policy, { ...opts, ...homeOpts });
    return this.repository.getPlan(generated.id, homeOpts)
      ?? this.repository.putPlan(generated, policy.id, { private: home === "private", public: home === "public" });
  }

  prove(id: string, opts: { now?: string } = {}): { policy: PolicySpec; proof: PolicyProof } {
    const policy = this.get(id);
    const publicOnly = policy.data_class === "public" && this.repository.homeOfPolicy(id) === "public";
    const plan = this.plan(id, { publicOnly, now: opts.now });
    const proof = provePolicy(this.store, this.root, policy, { publicOnly, now: opts.now, plan });
    this.repository.putProof(proof, policy.id);
    const proposed = proposeProvedPolicy(policy, proof, opts.now ?? proof.generated_at);
    return { policy: this.repository.putPolicy(proposed), proof };
  }

  approve(id: string, mode: "advisory" | "blocking", actor: string, opts: { now?: string } = {}): PolicySpec {
    const policy = this.get(id);
    if (!policy.proof) throw new Error(`policy ${id} has no proof`);
    const home = this.repository.homeOfPolicy(id);
    const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
    const proof = this.proof(policy.proof, homeOpts);
    const dispositions = this.repository.listDispositions(homeOpts).filter((record) => record.policy_id === id && record.proof_id === proof.id);
    const approved = approvePolicy(policy, proof, mode, actor, opts.now ?? new Date().toISOString(), dispositions);
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
    const disposition = compileHistoryDisposition(policy, proof, receipt, classification, actor, reason, opts);
    return this.repository.putDisposition(disposition, policy.id);
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
      const evaluation = evaluatePolicy(this.store, this.root, policy, { publicOnly: opts.publicOnly });
      let proof: PolicyProof | undefined;
      let dispositions: HistoryDisposition[] = [];
      if (policy.state === "active_blocking" && policy.proof) {
        const home = opts.publicOnly ? "public" : this.repository.homeOfPolicy(policy.id);
        const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
        proof = this.repository.getProof(policy.proof, homeOpts);
        dispositions = this.repository.listDispositions(homeOpts).filter((record) => record.policy_id === policy.id && record.proof_id === policy.proof);
      }
      const gateError = blockingProofError(policy, proof, dispositions);
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
