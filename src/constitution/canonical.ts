import { sha1, shortHash } from "../core/ids.js";
import type { PolicySpec } from "./schema.js";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
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
    ir_version: policy.ir_version,
    statement: policy.statement,
    scope: policy.scope,
    assertion: policy.assertion,
    data_class: policy.data_class,
  });
}

export function policyId(seed: unknown): string {
  return `pol_${shortHash(canonicalJson(seed))}`;
}

export function proofId(seed: unknown): string {
  return `proof_${shortHash(canonicalJson(seed))}`;
}
