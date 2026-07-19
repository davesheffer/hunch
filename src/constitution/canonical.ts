import { sha1, shortHash } from "../core/ids.js";
import { compareCodeUnits } from "../core/canonicalOrder.js";
import type { PolicyEvaluation, PolicySpec, ProofPlan } from "./schema.js";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => compareCodeUnits(a, b))
        .map(([k, v]) => [k, canonicalValue(v)]),
    );
  }
  return value;
}

/** Stable, whitespace-free JSON for hashes and cross-client receipts. Arrays retain
 * semantic order; object keys are recursively sorted. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalHash(value: unknown): string {
  return sha1(canonicalJson(value));
}

/** Proofs bind evaluator semantics, not mutable lifecycle fields such as approval,
 * severity, timestamps, or state. */
export function policySemanticHash(policy: PolicySpec): string {
  return canonicalHash({
    id: policy.id,
    // Preserve existing generic-policy hashes while binding the correction
    // compiler's provenance and permanent MD-1a activation gate into every
    // correction proof. Removing either makes that proof stale.
    ...(policy.origin !== "generic" ? { origin: policy.origin } : {}),
    ...(policy.activation_gate ? { activation_gate: policy.activation_gate } : {}),
    ir_version: policy.ir_version,
    statement: policy.statement,
    scope: policy.scope,
    assertion: policy.assertion,
    exception_of: policy.exception_of,
    data_class: policy.data_class,
  });
}

export function proofPlanContentHash(plan: ProofPlan): string {
  const { id: _id, content_hash: _contentHash, created_at: _createdAt, ...body } = plan;
  return canonicalHash(body);
}

/** A proof rerun is bound to policy semantics, not a mutable lifecycle revision.
 * Live gate receipts keep policy_revision in their own deterministic hash; this
 * projection is only for immutable proof/replay evidence. */
export function proofEvaluationHash(evaluation: PolicyEvaluation): string {
  const { policy_revision: _revision, deterministic_hash: _hash, ...semantic } = evaluation;
  return canonicalHash(semantic);
}

export function policyId(seed: unknown): string {
  return `pol_${shortHash(canonicalJson(seed))}`;
}

export function proofId(seed: unknown): string {
  return `proof_${shortHash(canonicalJson(seed))}`;
}
