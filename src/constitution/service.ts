import type { HunchStore } from "../store/hunchStore.js";
import { compileDecisionPolicy, type CompilePolicyOptions } from "./compiler.js";
import { evaluatePolicy, policyBlocks, policyIsActive } from "./evaluator.js";
import { approvePolicy, blockingProofError, demotePolicy, proposeProvedPolicy } from "./lifecycle.js";
import { provePolicy } from "./proof.js";
import { PolicyRepository } from "./repository.js";
import type { PolicyEvaluation, PolicyProof, PolicySpec } from "./schema.js";
import { bootstrapPolicies, type BootstrapOptions, type BootstrapReport } from "./bootstrap.js";
import { bootstrapStructuralPolicies, inspectStructuralDecision, type StructuralInspection } from "./structural.js";

export interface PolicyEvaluationSet {
  policy: PolicySpec;
  evaluation: PolicyEvaluation;
  blocks: boolean;
  strict_error: boolean;
  gate_error?: string;
}

export class ConstitutionService {
  readonly repository: PolicyRepository;

  constructor(private readonly store: HunchStore, private readonly root: string) {
    this.repository = new PolicyRepository(root, store);
  }

  list(opts: { publicOnly?: boolean; state?: string } = {}): PolicySpec[] {
    const all = this.repository.listPolicies(opts);
    return opts.state ? all.filter((p) => p.state === opts.state) : all;
  }

  get(id: string, opts: { publicOnly?: boolean } = {}): PolicySpec {
    const policy = this.repository.getPolicy(id, opts);
    if (!policy) throw new Error(`policy ${id} not found`);
    return policy;
  }

  proof(id: string, opts: { publicOnly?: boolean } = {}): PolicyProof {
    const proof = this.repository.getProof(id, opts);
    if (!proof) throw new Error(`proof ${id} not found`);
    return proof;
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

  prove(id: string, opts: { now?: string } = {}): { policy: PolicySpec; proof: PolicyProof } {
    const policy = this.get(id);
    const proof = provePolicy(this.store, this.root, policy, { publicOnly: policy.data_class === "public" && this.repository.homeOfPolicy(id) === "public", now: opts.now });
    this.repository.putProof(proof, policy.id);
    const proposed = proposeProvedPolicy(policy, proof, opts.now ?? proof.generated_at);
    return { policy: this.repository.putPolicy(proposed), proof };
  }

  approve(id: string, mode: "advisory" | "blocking", actor: string, opts: { now?: string } = {}): PolicySpec {
    const policy = this.get(id);
    if (!policy.proof) throw new Error(`policy ${id} has no proof`);
    const proof = this.proof(policy.proof);
    const approved = approvePolicy(policy, proof, mode, actor, opts.now ?? new Date().toISOString());
    return this.repository.putPolicy(approved);
  }

  demote(id: string, actor: string, reason: string, opts: { now?: string } = {}): PolicySpec {
    const policy = this.get(id);
    const demoted = demotePolicy(policy, actor, reason, opts.now ?? new Date().toISOString());
    return this.repository.putPolicy(demoted);
  }

  evaluate(opts: { id?: string; activeOnly?: boolean; publicOnly?: boolean } = {}): PolicyEvaluationSet[] {
    let policies = opts.id ? [this.get(opts.id, opts)] : this.list(opts);
    if (opts.activeOnly) policies = policies.filter(policyIsActive);
    return policies.map((policy) => {
      const evaluation = evaluatePolicy(this.store, this.root, policy, { publicOnly: opts.publicOnly });
      let proof: PolicyProof | undefined;
      if (policy.state === "active_blocking" && policy.proof) proof = this.repository.getProof(policy.proof, opts);
      const gateError = blockingProofError(policy, proof);
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
