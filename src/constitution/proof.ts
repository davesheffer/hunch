import { canonicalHash, policySemanticHash, proofId } from "./canonical.js";
import { evaluatePolicyOnSnapshot, graphSnapshot, mutateSnapshotForPolicy } from "./evaluator.js";
import {
  POLICY_EVALUATOR,
  PolicyProofSchema,
  type EvaluationSummary,
  type PolicyEvaluation,
  type PolicyProof,
  type PolicySpec,
  type ProofClass,
} from "./schema.js";
import type { HunchStore } from "../store/hunchStore.js";

function summary(results: PolicyEvaluation[]): EvaluationSummary {
  const count = (kind: PolicyEvaluation["result"]): number => results.filter((r) => r.result === kind).length;
  return {
    total: results.length,
    satisfied: count("satisfied"),
    violated: count("violated"),
    not_applicable: count("not_applicable"),
    unknown: count("unknown"),
    error: count("error"),
    receipt_hashes: results.map((r) => r.deterministic_hash),
  };
}

const emptySummary = (): EvaluationSummary => ({
  total: 0,
  satisfied: 0,
  violated: 0,
  not_applicable: 0,
  unknown: 0,
  error: 0,
  receipt_hashes: [],
});

/** Gate-G1 inward proof: current baseline plus one evaluator-specific deterministic
 * mutation. History replay remains a later harness phase, and the limitation is
 * explicit in the artifact. */
export function provePolicy(
  store: HunchStore,
  root: string,
  policy: PolicySpec,
  opts: { publicOnly?: boolean; now?: string } = {},
): PolicyProof {
  const snapshot = graphSnapshot(store, root, opts);
  const current = evaluatePolicyOnSnapshot(policy, snapshot);
  const mutation = mutateSnapshotForPolicy(policy, snapshot);
  const mutationResult = mutation ? evaluatePolicyOnSnapshot(policy, mutation.snapshot) : null;
  let proofClass: ProofClass = "P0";
  if (current.result === "satisfied") proofClass = "P1";
  if (current.result === "satisfied" && mutationResult?.result === "violated") proofClass = "P3";
  const policyHash = policySemanticHash(policy);
  const plan = {
    policy_hash: policyHash,
    evaluator: POLICY_EVALUATOR,
    current_graph: snapshot.graph_hash,
    mutation: mutation?.operator ?? "unavailable",
    budgets: { max_commits: 1, max_mutations: 1, max_minutes: 1 },
  };
  const planHash = canonicalHash(plan);
  const id = proofId({ policy_hash: policyHash, plan_hash: planHash, evaluator: POLICY_EVALUATOR });
  const now = opts.now ?? new Date().toISOString();
  return PolicyProofSchema.parse({
    id,
    plan_hash: planHash,
    policy_hash: policyHash,
    evaluator: { ...POLICY_EVALUATOR },
    generated_at: now,
    current: summary([current]),
    known_bad: emptySummary(),
    known_good: summary(current.result === "satisfied" ? [current] : []),
    accepted_history: { ...emptySummary(), classified_hits: [] },
    mutations: {
      ...summary(mutationResult ? [mutationResult] : []),
      operator_coverage: mutation ? { [mutation.operator]: mutationResult?.result === "violated" ? 1 : 0 } : {},
    },
    limitations: [
      ...policy.limitations,
      "Gate G1 proof covers current baseline and one deterministic mutation; accepted-history replay and shadow outcomes are not yet implemented.",
    ],
    proof_class: proofClass,
    artifact_hashes: {
      policy: policyHash,
      graph: snapshot.graph_hash,
      current_receipt: current.deterministic_hash,
      ...(mutationResult ? { mutation_receipt: mutationResult.deterministic_hash } : {}),
    },
    data_class: policy.data_class,
  });
}
