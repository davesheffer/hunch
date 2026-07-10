import { policySemanticHash } from "./canonical.js";
import { pathMatchesGlob } from "../core/glob.js";
import type { PolicyProof, PolicySpec, ProofClass } from "./schema.js";

function isHumanActor(actor: string): boolean {
  return /^(human|github|git):[^\s]+$/i.test(actor);
}

export function blockingEvidenceError(proof: PolicyProof): string | null {
  if (proof.mutation_receipts.some((receipt) => receipt.required && !receipt.passed)) {
    return "blocking proof has a failed required mutation receipt";
  }
  if (proof.mutation_controls.failed > 0) {
    return "blocking proof has failed required mutation controls";
  }
  if (proof.known_bad.total > 0 && proof.known_bad.violated !== proof.known_bad.total) {
    return "blocking proof did not catch every declared known-bad fixture";
  }
  if (proof.known_good.total > 0 && proof.known_good.satisfied !== proof.known_good.total) {
    return "blocking proof did not satisfy every declared known-good fixture";
  }
  if (proof.accepted_history.error || proof.accepted_history.unknown) {
    return "blocking proof has unresolved accepted-history unknown/error results";
  }
  if (proof.accepted_history.classified_hits.length < proof.accepted_history.violated) {
    return "blocking proof has unclassified accepted-history violation hits";
  }
  return null;
}

const proofRank: Record<ProofClass, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };

/** Rechecked on every blocking evaluation; a hand-edited lifecycle flag without
 * a current P3 proof is a configuration error, never authority. */
export function blockingProofError(policy: PolicySpec, proof: PolicyProof | undefined): string | null {
  if (policy.state !== "active_blocking") return null;
  if (policy.authority?.kind !== "human") return "active blocking policy has no human authority event";
  if (!policy.proof || !proof) return "active blocking policy has no readable proof artifact";
  if (proofRank[proof.proof_class] < proofRank.P3) return `blocking proof is ${proof.proof_class}; P3+ is required`;
  if (proof.policy_hash !== policySemanticHash(policy)) return "blocking proof does not match current policy semantics";
  if (proof.current.satisfied !== 1 || proof.current.error || proof.current.unknown) return "blocking proof has no clean satisfied baseline";
  const replayError = blockingEvidenceError(proof);
  if (replayError) return replayError;
  return null;
}

function requireHuman(actor: string): void {
  if (!isHumanActor(actor)) throw new Error("policy authority requires an explicit human actor (human:, github:, or git:); machine/model identities cannot activate policy");
}

function requireCurrentProof(policy: PolicySpec, proof: PolicyProof): void {
  if (proof.policy_hash !== policySemanticHash(policy)) throw new Error(`proof ${proof.id} does not match the current policy semantics`);
  if (proof.current.satisfied !== 1 || proof.current.error || proof.current.unknown) throw new Error(`proof ${proof.id} has no clean satisfied baseline`);
}

export function proposeProvedPolicy(policy: PolicySpec, proof: PolicyProof, at: string): PolicySpec {
  if (policy.state !== "compiled" && policy.state !== "validating" && policy.state !== "proposed") throw new Error(`cannot attach proof while policy is ${policy.state}`);
  if (proofRank[proof.proof_class] < proofRank.P1) throw new Error(`proof ${proof.id} is ${proof.proof_class}; a clean current baseline is required`);
  requireCurrentProof(policy, proof);
  return {
    ...policy,
    revision: policy.revision + 1,
    state: "proposed",
    proof: proof.id,
    updated_at: at,
    audit: [...policy.audit, { action: "proved", actor_kind: "system", actor: "hunch:evidence-harness", at, reason: `Proof ${proof.id} reached ${proof.proof_class}.`, proof: proof.id }],
  };
}

export function approvePolicy(
  policy: PolicySpec,
  proof: PolicyProof,
  mode: "advisory" | "blocking",
  actor: string,
  at: string,
): PolicySpec {
  requireHuman(actor);
  if (policy.exception_of && mode === "blocking") throw new Error(`exception policy ${policy.id} cannot block until exception composition has its own proved evaluator semantics`);
  if (policy.state !== "proposed") throw new Error(`policy ${policy.id} is ${policy.state}; only a proposed policy can be activated`);
  requireCurrentProof(policy, proof);
  if (mode === "blocking" && proofRank[proof.proof_class] < proofRank.P3) {
    throw new Error(`blocking activation requires P3+ proof; ${proof.id} is ${proof.proof_class}`);
  }
  if (mode === "blocking") {
    const replayError = blockingEvidenceError(proof);
    if (replayError) throw new Error(replayError);
  }
  const event = `${mode === "blocking" ? "approval-blocking" : "approval-advisory"}:${at}`;
  return {
    ...policy,
    revision: policy.revision + 1,
    state: mode === "blocking" ? "active_blocking" : "active_advisory",
    severity: mode === "blocking" ? "blocking" : "warning",
    surfaces: mode === "blocking" ? ["pre_commit", "ci", "mcp", "cli"] : ["pre_edit", "pre_commit", "ci", "mcp", "cli"],
    authority: { kind: "human", actor, event, at },
    valid_from: at,
    valid_to: null,
    updated_at: at,
    audit: [...policy.audit, {
      action: mode === "blocking" ? "approved_blocking" : "approved_advisory",
      actor_kind: "human",
      actor,
      at,
      reason: `Human activated policy as ${mode}.`,
      proof: proof.id,
    }],
  };
}

function oppositeAssertions(child: PolicySpec, parent: PolicySpec): boolean {
  const left = child.assertion;
  const right = parent.assertion;
  if (!((left.kind === "reaches" && right.kind === "not-reaches") || (left.kind === "not-reaches" && right.kind === "reaches"))) return false;
  return left.subject.selector === right.subject.selector
    && left.object.selector === right.object.selector
    && JSON.stringify(left.relation) === JSON.stringify(right.relation);
}

function narrowerScope(child: PolicySpec, parent: PolicySpec): boolean {
  const reposInside = !parent.scope.repos.length || child.scope.repos.every((repo) => parent.scope.repos.includes(repo));
  const componentsInside = !parent.scope.components.length || child.scope.components.every((component) => parent.scope.components.includes(component));
  const pathsInside = !parent.scope.paths.length || child.scope.paths.every((path) => parent.scope.paths.some((glob) => path === glob || pathMatchesGlob(path, glob)));
  const strict = JSON.stringify(child.scope) !== JSON.stringify(parent.scope);
  return reposInside && componentsInside && pathsInside && strict;
}

/** Human-authored exception relationship only. It invalidates the child's old
 * proof/authority and stays non-blocking until a future composition evaluator
 * can prove parent+exception behavior together. */
export function linkPolicyException(child: PolicySpec, parent: PolicySpec, actor: string, reason: string, at: string): PolicySpec {
  requireHuman(actor);
  if (child.id === parent.id) throw new Error("a policy cannot be its own exception parent");
  if (child.data_class !== parent.data_class) throw new Error("exception and parent must have the same data class");
  if (child.exception_of && child.exception_of !== parent.id) throw new Error(`policy ${child.id} is already linked to exception parent ${child.exception_of}`);
  if (!oppositeAssertions(child, parent)) throw new Error("exception must be the exact opposite reaches/not-reaches assertion over the same bindings and relation");
  if (!narrowerScope(child, parent)) throw new Error("exception scope must be strictly narrower than and contained by its parent scope");
  if (!reason.trim()) throw new Error("exception link requires an audited human reason");
  if (child.exception_of === parent.id) return child;
  return {
    ...child,
    revision: child.revision + 1,
    state: "compiled",
    severity: "warning",
    authority: null,
    proof: null,
    exception_of: parent.id,
    updated_at: at,
    audit: [...child.audit, {
      action: "linked_exception",
      actor_kind: "human",
      actor,
      at,
      reason,
      proof: null,
    }],
  };
}

export function demotePolicy(policy: PolicySpec, actor: string, reason: string, at: string): PolicySpec {
  requireHuman(actor);
  if (policy.state !== "active_blocking") throw new Error(`policy ${policy.id} is ${policy.state}; only active blocking policy can be demoted`);
  return {
    ...policy,
    revision: policy.revision + 1,
    state: "active_advisory",
    severity: "warning",
    authority: { kind: "human", actor, event: `demotion:${at}`, at },
    updated_at: at,
    audit: [...policy.audit, { action: "demoted", actor_kind: "human", actor, at, reason, proof: policy.proof }],
  };
}
