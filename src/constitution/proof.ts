import { canonicalHash, proofEvaluationHash, policySemanticHash, proofId } from "./canonical.js";
import { evaluatePolicyOnSnapshot, graphSnapshot, mutateSnapshotForPolicy } from "./evaluator.js";
import { replayProofPlan } from "./replay.js";
import {
  POLICY_EVALUATOR,
  PolicyProofSchema,
  type EvaluationSummary,
  type PolicyEvaluation,
  type PolicyProof,
  type PolicySpec,
  type ProofPlan,
  type ProofClass,
  type ReplayReceipt,
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

function replaySummary(receipts: ReplayReceipt[]): EvaluationSummary {
  const count = (kind: ReplayReceipt["result"]): number => receipts.filter((receipt) => receipt.result === kind).length;
  return {
    total: receipts.length,
    satisfied: count("satisfied"),
    violated: count("violated"),
    not_applicable: count("not_applicable"),
    unknown: count("unknown"),
    error: count("error"),
    receipt_hashes: receipts.map((receipt) => receipt.deterministic_hash),
  };
}

/** Inward proof execution. A canonical plan uses immutable disposable replay
 * snapshots; the no-plan fallback preserves the original Gate-G1 current graph
 * plus one deterministic mutation behavior. */
export function provePolicy(
  store: HunchStore,
  root: string,
  policy: PolicySpec,
  opts: { publicOnly?: boolean; now?: string; plan?: ProofPlan } = {},
): PolicyProof {
  const replay = opts.plan ? replayProofPlan(root, policy, opts.plan) : undefined;
  const snapshot = replay?.current_snapshot ?? graphSnapshot(store, root, opts);
  const fallbackCurrent = replay ? undefined : evaluatePolicyOnSnapshot(policy, snapshot);
  const mutationBase = replay?.current_snapshot ?? snapshot;
  const mutation = !opts.plan || opts.plan.mutations.length > 0 ? mutateSnapshotForPolicy(policy, mutationBase) : null;
  if (opts.plan?.mutations[0] && mutation && opts.plan.mutations[0].operator !== mutation.operator) {
    throw new Error(`proof plan ${opts.plan.id} mutation ${opts.plan.mutations[0].operator} does not match evaluator operator ${mutation.operator}`);
  }
  const mutationResult = mutation ? evaluatePolicyOnSnapshot(policy, mutation.snapshot) : null;
  const mutationSummary = summary(mutationResult ? [mutationResult] : []);
  if (replay && mutationResult) mutationSummary.receipt_hashes = [proofEvaluationHash(mutationResult)];
  const currentSummary = replay ? replaySummary([replay.current]) : summary(fallbackCurrent ? [fallbackCurrent] : []);
  const knownBadSummary = replay ? replaySummary(replay.known_bad) : emptySummary();
  const knownGoodSummary = replay ? replaySummary(replay.known_good) : summary(fallbackCurrent?.result === "satisfied" ? [fallbackCurrent] : []);
  const historySummary = replay ? replaySummary(replay.accepted_history) : emptySummary();
  let proofClass: ProofClass = "P0";
  const baselineSatisfied = currentSummary.satisfied === 1 && currentSummary.error === 0 && currentSummary.unknown === 0;
  if (baselineSatisfied) proofClass = "P1";
  if (baselineSatisfied && replay?.history_complete) proofClass = "P2";
  const caughtKnownBad = replay?.known_bad.some((receipt) => receipt.expected === "violated" && receipt.result === "violated") ?? false;
  if (baselineSatisfied && (caughtKnownBad || mutationResult?.result === "violated")) proofClass = "P3";
  const policyHash = policySemanticHash(policy);
  const fallbackPlan = {
    policy_hash: policyHash,
    evaluator: POLICY_EVALUATOR,
    current_graph: snapshot.graph_hash,
    mutation: mutation?.operator ?? "unavailable",
    budgets: { max_commits: 1, max_mutations: 1, max_minutes: 1 },
  };
  const planHash = opts.plan?.content_hash ?? canonicalHash(fallbackPlan);
  const id = proofId({ policy_hash: policyHash, plan_hash: planHash, evaluator: POLICY_EVALUATOR });
  const now = opts.now ?? new Date().toISOString();
  const historyHits = historySummary.violated;
  const replayProblems = historySummary.error + historySummary.unknown;
  return PolicyProofSchema.parse({
    id,
    plan_hash: planHash,
    policy_hash: policyHash,
    evaluator: { ...POLICY_EVALUATOR },
    generated_at: now,
    current: currentSummary,
    known_bad: knownBadSummary,
    known_good: knownGoodSummary,
    accepted_history: { ...historySummary, classified_hits: [] },
    mutations: {
      ...mutationSummary,
      operator_coverage: mutation ? { [mutation.operator]: mutationResult?.result === "violated" ? 1 : 0 } : {},
    },
    replay_receipts: replay?.replay_receipts ?? [],
    limitations: [
      ...policy.limitations,
      ...(replay ? [
        "Replay uses the pinned static evaluator in disposable Git worktrees; project build/tests and repository code are never executed.",
        replay.selected_history_commits.length
          ? `Accepted-history replay evaluated ${replay.selected_history_commits.length} bounded first-parent commit(s).`
          : "Accepted-history selector resolved to zero non-baseline commits.",
        ...(historyHits ? [`Accepted-history contains ${historyHits} unclassified violation hit(s); no false-positive claim or blocking approval is allowed until classification.`] : []),
        ...(replayProblems ? [`Accepted-history contains ${replayProblems} unknown/error result(s); they remain visible and prevent blocking approval.`] : []),
        "Shadow outcomes remain pending.",
      ] : ["Gate G1 proof covers the current graph and one deterministic mutation; historical replay and shadow outcomes are not available without a ProofPlan."]),
    ],
    proof_class: proofClass,
    artifact_hashes: {
      policy: policyHash,
      ...(opts.plan ? { plan: opts.plan.content_hash } : {}),
      ...(replay?.current.graph_hash ? { graph: replay.current.graph_hash } : { graph: snapshot.graph_hash }),
      ...(currentSummary.receipt_hashes[0] ? { current_receipt: currentSummary.receipt_hashes[0] } : {}),
      ...(replay ? { replay_manifest: canonicalHash(replay.replay_receipts) } : {}),
      ...(mutationResult ? { mutation_receipt: replay ? proofEvaluationHash(mutationResult) : mutationResult.deterministic_hash } : {}),
    },
    data_class: policy.data_class,
  });
}
