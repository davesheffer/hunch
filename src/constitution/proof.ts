import { canonicalHash, proofEvaluationHash, proofId } from "./canonical.js";
import { assertCompositionBinding, policyCompositionBinding, policyProofHash } from "./composition.js";
import { evaluateCompositePolicyOnSnapshot, evaluatePolicyOnSnapshot, graphSnapshot, mutationOperatorForPolicy, selectedPolicyForComposition, type GraphSnapshot } from "./evaluator.js";
import { runMutationHarness } from "./mutation.js";
import { replayProofPlan } from "./replay.js";
import {
  POLICY_EVALUATOR,
  MUTATION_ENGINE,
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
  opts: { publicOnly?: boolean; now?: string; plan?: ProofPlan; composition?: PolicySpec[] } = {},
): PolicyProof {
  if (opts.plan && (
    opts.plan.mutation_engine?.name !== MUTATION_ENGINE.name
    || opts.plan.mutation_engine.version !== MUTATION_ENGINE.version
  )) {
    throw new Error(`proof plan ${opts.plan.id} requires regeneration for mutation engine ${MUTATION_ENGINE.name}@${MUTATION_ENGINE.version}`);
  }
  const composition = opts.composition ?? [];
  const compositionBinding = policyCompositionBinding(policy, composition);
  if (opts.plan) assertCompositionBinding(policy, composition, opts.plan.composition);
  const evaluate = (snapshot: GraphSnapshot): PolicyEvaluation => composition.length
    ? evaluateCompositePolicyOnSnapshot(policy, composition, snapshot)
    : evaluatePolicyOnSnapshot(policy, snapshot);
  const replay = opts.plan ? replayProofPlan(root, policy, opts.plan, { composition }) : undefined;
  const snapshot = replay?.current_snapshot ?? graphSnapshot(store, root, opts);
  const fallbackCurrent = replay ? undefined : evaluate(snapshot);
  const mutationBase = replay?.current_snapshot ?? snapshot;
  const mutationPolicy = composition.length ? selectedPolicyForComposition(policy, composition, mutationBase) : policy;
  const plannedMutations = opts.plan?.mutations ?? [{
    operator: mutationOperatorForPolicy(mutationPolicy),
    base: mutationBase.head,
    expected: "violated" as const,
    required: true,
  }];
  const policyHash = policyProofHash(policy, composition);
  const mutationHarness = runMutationHarness(root, policy, mutationBase, plannedMutations, {
    policyHash,
    mutationPolicy,
    evaluate,
  });
  const mutationSummary = summary(mutationHarness.primary_evaluations);
  if (replay) mutationSummary.receipt_hashes = mutationHarness.primary_evaluations.map(proofEvaluationHash);
  const primaryMutationReceipts = mutationHarness.receipts.filter((receipt) => receipt.kind === "primary");
  const controlReceipts = mutationHarness.receipts.filter((receipt) => receipt.kind === "control");
  const currentSummary = replay ? replaySummary([replay.current]) : summary(fallbackCurrent ? [fallbackCurrent] : []);
  const knownBadSummary = replay ? replaySummary(replay.known_bad) : emptySummary();
  const knownGoodSummary = replay ? replaySummary(replay.known_good) : summary(fallbackCurrent?.result === "satisfied" ? [fallbackCurrent] : []);
  const historySummary = replay ? replaySummary(replay.accepted_history) : emptySummary();
  let proofClass: ProofClass = "P0";
  const baselineSatisfied = currentSummary.satisfied === 1 && currentSummary.error === 0 && currentSummary.unknown === 0;
  if (baselineSatisfied) proofClass = "P1";
  if (baselineSatisfied && replay?.history_complete) proofClass = "P2";
  const caughtKnownBad = replay?.known_bad.some((receipt) => receipt.expected === "violated" && receipt.result === "violated") ?? false;
  const caughtMutation = primaryMutationReceipts.some((receipt) => receipt.passed && receipt.result === "violated");
  if (baselineSatisfied && (caughtKnownBad || caughtMutation)) proofClass = "P3";
  const fallbackPlan = {
    policy_hash: policyHash,
    evaluator: POLICY_EVALUATOR,
    mutation_engine: MUTATION_ENGINE,
    ...(compositionBinding ? { composition: compositionBinding } : {}),
    current_graph: snapshot.graph_hash,
    mutations: plannedMutations.map((mutation) => mutation.operator),
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
    mutation_engine: { ...MUTATION_ENGINE },
    ...(compositionBinding ? { composition: compositionBinding } : {}),
    generated_at: now,
    current: currentSummary,
    known_bad: knownBadSummary,
    known_good: knownGoodSummary,
    accepted_history: { ...historySummary, classified_hits: [] },
    mutations: {
      ...mutationSummary,
      operator_coverage: Object.fromEntries(primaryMutationReceipts.map((receipt) => [receipt.operator, receipt.passed ? 1 : 0])),
    },
    replay_receipts: replay?.replay_receipts ?? [],
    mutation_receipts: mutationHarness.receipts,
    mutation_controls: {
      total: controlReceipts.length,
      passed: controlReceipts.filter((receipt) => receipt.passed).length,
      failed: controlReceipts.filter((receipt) => !receipt.passed).length,
      receipt_hashes: controlReceipts.map((receipt) => receipt.deterministic_hash),
    },
    project_checks: { build: "not_run", test: "not_run", required_for_evaluator_sensitivity: false },
    limitations: [
      ...policy.limitations,
      ...(replay ? [
        "Replay uses the pinned static evaluator in disposable Git worktrees; project build/tests and repository code are never executed.",
        replay.selected_history_commits.length
          ? `Accepted-history replay evaluated ${replay.selected_history_commits.length} bounded first-parent commit(s).`
          : "Accepted-history selector resolved to zero non-baseline commits.",
        ...(historyHits ? [`Accepted-history contains ${historyHits} unclassified violation hit(s); no false-positive claim or blocking approval is allowed until classification.`] : []),
        ...(replayProblems ? [`Accepted-history contains ${replayProblems} unknown/error result(s); they remain visible and prevent blocking approval.`] : []),
        "Primary mutation applies to an immutable disposable source checkout and must remain parseable; comment/string and same-name controls are separate, while project build/test outcomes remain non-authoritative follow-on evidence.",
        "Shadow outcomes are tracked as separate append-only measurements and never mutate this immutable proof.",
        ...(compositionBinding ? [`Composite receipts bind ${compositionBinding.members.length} explicit scoped exception policy record(s) to their broad parent.`] : []),
      ] : ["Gate G1 proof covers the current graph and one deterministic mutation; historical replay and shadow outcomes are not available without a ProofPlan."]),
    ],
    proof_class: proofClass,
    artifact_hashes: {
      policy: policyHash,
      ...(opts.plan ? { plan: opts.plan.content_hash } : {}),
      ...(compositionBinding ? { composition: compositionBinding.composite_hash } : {}),
      ...(replay?.current.graph_hash ? { graph: replay.current.graph_hash } : { graph: snapshot.graph_hash }),
      ...(currentSummary.receipt_hashes[0] ? { current_receipt: currentSummary.receipt_hashes[0] } : {}),
      ...(replay ? { replay_manifest: canonicalHash(replay.replay_receipts) } : {}),
      ...(primaryMutationReceipts[0] ? { mutation_receipt: primaryMutationReceipts[0].deterministic_hash } : {}),
      ...(mutationHarness.receipts.length ? { mutation_manifest: canonicalHash(mutationHarness.receipts) } : {}),
    },
    data_class: policy.data_class,
  });
}
