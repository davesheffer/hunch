import { basename } from "node:path";
import { shortHash } from "../core/ids.js";
import { headSha } from "../extractors/git.js";
import { evaluateExecutableBehaviorPolicy } from "./behaviorEvaluator.js";
import { canonicalHash, policySemanticHash, proofEvaluationHash, proofId, proofPlanContentHash } from "./canonical.js";
import type { PolicyRepository } from "./repository.js";
import {
  BEHAVIOR_MUTATION_ENGINE,
  BEHAVIOR_POLICY_EVALUATOR,
  MutationReceiptSchema,
  PolicyProofSchema,
  ProofPlanSchema,
  ReplayReceiptSchema,
  type EvaluationSummary,
  type MutationReceipt,
  type PolicyEvaluation,
  type PolicyProof,
  type PolicySpec,
  type ProofPlan,
  type ReplayReceipt,
} from "./schema.js";

function summary(evaluations: PolicyEvaluation[]): EvaluationSummary {
  const count = (result: PolicyEvaluation["result"]): number => evaluations.filter((evaluation) => evaluation.result === result).length;
  return {
    total: evaluations.length,
    satisfied: count("satisfied"),
    violated: count("violated"),
    not_applicable: count("not_applicable"),
    unknown: count("unknown"),
    error: count("error"),
    receipt_hashes: evaluations.map(proofEvaluationHash),
  };
}

function replayReceipt(
  leg: ReplayReceipt["leg"],
  policyHash: string,
  expected: PolicyEvaluation["result"],
  evaluation: PolicyEvaluation,
): ReplayReceipt {
  const body = {
    leg,
    commit: evaluation.behavior!.commit,
    expected,
    policy_hash: policyHash,
    evaluator: { ...BEHAVIOR_POLICY_EVALUATOR },
    result: evaluation.result,
    graph_hash: evaluation.behavior!.execution_hash,
    evaluation_hash: proofEvaluationHash(evaluation),
    ...(evaluation.behavior!.error_code ? { error_code: evaluation.behavior!.error_code } : {}),
    behavior: evaluation.behavior!,
  };
  return ReplayReceiptSchema.parse({ ...body, deterministic_hash: canonicalHash(body) });
}

function mutationReceipt(
  policyHash: string,
  planned: ProofPlan["mutations"][number],
  kind: "primary" | "control",
  evaluation: PolicyEvaluation,
  passed: boolean,
): MutationReceipt {
  const seed = {
    engine: BEHAVIOR_MUTATION_ENGINE,
    policy_hash: policyHash,
    base_commit: evaluation.behavior!.commit,
    base_graph_hash: evaluation.behavior!.execution_hash,
    kind,
    operator: planned.operator,
  };
  const body = {
    id: `mut_${shortHash(canonicalHash(seed))}`,
    kind,
    operator: planned.operator,
    required: planned.required,
    engine: { ...BEHAVIOR_MUTATION_ENGINE },
    policy_hash: policyHash,
    base_commit: evaluation.behavior!.commit,
    base_graph_hash: evaluation.behavior!.execution_hash,
    mutated_graph_hash: evaluation.behavior!.execution_hash,
    expected: planned.expected,
    result: evaluation.result,
    passed,
    parseability: "not_applicable" as const,
    graph_diff: { added_symbols: [], removed_symbols: [], added_edges: [], removed_edges: [] },
    evaluation_hash: proofEvaluationHash(evaluation),
    ...(evaluation.behavior!.error_code ? { error_code: evaluation.behavior!.error_code } : {}),
    behavior: evaluation.behavior!,
  };
  return MutationReceiptSchema.parse({ ...body, deterministic_hash: canonicalHash(body) });
}

export function createExecutableBehaviorProofPlan(
  root: string,
  repository: PolicyRepository,
  policy: PolicySpec,
  opts: { now?: string; privateOnly?: boolean } = {},
): ProofPlan {
  if (policy.assertion.kind !== "executable-behavior") throw new Error(`policy ${policy.id} is not executable behavior`);
  if (policy.data_class === "public") throw new Error("executable-behavior policy materialization requires private storage");
  const head = headSha(root);
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("executable behavior proof planning requires a current full-SHA HEAD");
  const corpus = repository.getCorpus(policy.id, { privateOnly: opts.privateOnly ?? true });
  if (!corpus || corpus.known_bad.length !== 1 || corpus.known_good.length !== 1) {
    throw new Error("executable behavior proof requires exactly one imported known-bad and one known-good commit");
  }
  const policyHash = policySemanticHash(policy);
  if (corpus.policy_hash !== policyHash) throw new Error(`behavior corpus ${corpus.id} is stale for policy ${policy.id}`);
  const bad = corpus.known_bad[0]!;
  const good = corpus.known_good[0]!;
  const body = {
    policy_id: policy.id,
    policy_candidate_hash: policyHash,
    repository: basename(root),
    data_class: policy.data_class,
    source_commit: policy.assertion.test.source_commit,
    valid_from_commit: policy.assertion.test.source_commit,
    evaluator: { ...BEHAVIOR_POLICY_EVALUATOR },
    mutation_engine: { ...BEHAVIOR_MUTATION_ENGINE },
    corpus_manifest: { id: corpus.id, content_hash: corpus.content_hash },
    corpus: {
      current_baseline: { kind: "commit" as const, ref: head, label: "current committed executable behavior baseline", expected: "satisfied" as const },
      accepted_history: { from: head, to: head, first_parent: true, max_commits: 0, exclude: [bad.ref, good.ref].sort() },
      known_bad: [bad],
      known_good: [good],
    },
    mutations: [
      { operator: "known-bad-regression", base: bad.ref, expected: "violated" as const, required: true },
      { operator: "selected-test-execution-control", base: good.ref, expected: "error" as const, required: true },
    ],
    budgets: { max_commits: 0, max_mutations: 2, max_minutes: 5 },
    expected: [
      { leg: "current_baseline" as const, result: "satisfied" as const, classification_required: false },
      { leg: "known_bad" as const, result: "violated" as const, classification_required: false },
      { leg: "known_good" as const, result: "satisfied" as const, classification_required: false },
      { leg: "mutations" as const, result: "violated" as const, classification_required: false },
    ],
    evidence_refs: [...policy.evidence].sort(),
    limitations: [
      "Executable behavior proof runs only a hash-pinned node:test case through an allowlisted runner in disposable committed worktrees.",
      "The proof baseline is committed HEAD; advisory delivery may separately evaluate a content-addressed staged or working snapshot.",
      "Known-bad replay is the primary historical regression mutation; a missing-name control proves that zero executed tests cannot satisfy the evaluator.",
      "Repository test code executes as evidence but grants no authority; policy activation remains a separate explicit human action.",
    ],
  };
  const contentHash = canonicalHash(body);
  return ProofPlanSchema.parse({
    id: `plan_${shortHash(contentHash)}`,
    content_hash: contentHash,
    ...body,
    created_at: opts.now ?? new Date().toISOString(),
  });
}

export function proveExecutableBehaviorPolicy(
  root: string,
  policy: PolicySpec,
  plan: ProofPlan,
  opts: { now?: string } = {},
): PolicyProof {
  if (policy.assertion.kind !== "executable-behavior") throw new Error(`policy ${policy.id} is not executable behavior`);
  if (plan.content_hash !== proofPlanContentHash(plan)) throw new Error(`proof plan ${plan.id} content hash mismatch`);
  const policyHash = policySemanticHash(policy);
  if (plan.policy_id !== policy.id || plan.policy_candidate_hash !== policyHash) throw new Error(`proof plan ${plan.id} does not match behavior policy semantics`);
  if (plan.evaluator.name !== BEHAVIOR_POLICY_EVALUATOR.name || plan.evaluator.version !== BEHAVIOR_POLICY_EVALUATOR.version) throw new Error(`proof plan ${plan.id} behavior evaluator is stale`);
  if (plan.mutation_engine?.name !== BEHAVIOR_MUTATION_ENGINE.name || plan.mutation_engine.version !== BEHAVIOR_MUTATION_ENGINE.version) throw new Error(`proof plan ${plan.id} behavior mutation engine is stale`);
  const primaryPlan = plan.mutations.find((mutation) => mutation.operator === "known-bad-regression");
  const controlPlan = plan.mutations.find((mutation) => mutation.operator === "selected-test-execution-control");
  if (!primaryPlan || !controlPlan) throw new Error("executable behavior proof plan lacks required mutation/control operators");

  const current = evaluateExecutableBehaviorPolicy(root, policy, { commit: plan.corpus.current_baseline.ref });
  const knownBad = plan.corpus.known_bad.map((fixture) => evaluateExecutableBehaviorPolicy(root, policy, { commit: fixture.ref }));
  const knownGood = plan.corpus.known_good.map((fixture) => evaluateExecutableBehaviorPolicy(root, policy, { commit: fixture.ref }));
  const controlName = `__hunch_missing_${shortHash(policyHash)}`;
  const control = evaluateExecutableBehaviorPolicy(root, policy, { commit: controlPlan.base, selectedName: controlName });
  const replayReceipts = [
    replayReceipt("current_baseline", policyHash, "satisfied", current),
    ...knownBad.map((evaluation) => replayReceipt("known_bad", policyHash, "violated", evaluation)),
    ...knownGood.map((evaluation) => replayReceipt("known_good", policyHash, "satisfied", evaluation)),
  ];
  const primaryEvaluation = knownBad.find((evaluation) => evaluation.behavior?.commit === primaryPlan.base) ?? knownBad[0]!;
  const primaryReceipt = mutationReceipt(policyHash, primaryPlan, "primary", primaryEvaluation, primaryEvaluation.result === primaryPlan.expected);
  const controlPassed = control.result === "error" && control.behavior?.error_code === "selected-test-not-executed";
  const controlReceipt = mutationReceipt(policyHash, controlPlan, "control", control, controlPassed);
  const mutationReceipts = [primaryReceipt, controlReceipt];
  const currentSummary = summary([current]);
  const badSummary = summary(knownBad);
  const goodSummary = summary(knownGood);
  const baselineSatisfied = currentSummary.satisfied === 1 && currentSummary.error === 0 && currentSummary.unknown === 0;
  const exactBad = badSummary.total > 0 && badSummary.violated === badSummary.total;
  const exactGood = goodSummary.total > 0 && goodSummary.satisfied === goodSummary.total;
  const controlsPassed = mutationReceipts.every((receipt) => receipt.passed);
  const proofClass = baselineSatisfied && exactBad && exactGood && controlsPassed ? "P3" as const : baselineSatisfied ? "P1" as const : "P0" as const;
  const generatedAt = opts.now ?? new Date().toISOString();
  const id = proofId({ policy_hash: policyHash, plan_hash: plan.content_hash, evaluator: BEHAVIOR_POLICY_EVALUATOR });
  return PolicyProofSchema.parse({
    id,
    plan_hash: plan.content_hash,
    policy_hash: policyHash,
    evaluator: { ...BEHAVIOR_POLICY_EVALUATOR },
    mutation_engine: { ...BEHAVIOR_MUTATION_ENGINE },
    generated_at: generatedAt,
    current: currentSummary,
    known_bad: badSummary,
    known_good: goodSummary,
    accepted_history: { ...summary([]), classified_hits: [] },
    mutations: { ...summary([primaryEvaluation]), operator_coverage: { [primaryReceipt.operator]: primaryReceipt.passed ? 1 : 0 } },
    replay_receipts: replayReceipts,
    mutation_receipts: mutationReceipts,
    mutation_controls: {
      total: 1,
      passed: controlReceipt.passed ? 1 : 0,
      failed: controlReceipt.passed ? 0 : 1,
      receipt_hashes: [controlReceipt.deterministic_hash],
    },
    project_checks: {
      build: "not_run",
      test: baselineSatisfied && exactBad && exactGood ? "passed" : "failed",
      required_for_evaluator_sensitivity: true,
    },
    limitations: [...plan.limitations],
    proof_class: proofClass,
    artifact_hashes: {
      policy: policyHash,
      plan: plan.content_hash,
      attestation: policy.assertion.attestation.content_hash,
      replay: policy.assertion.attestation.replay_hash,
      test_source: policy.assertion.test.source_hash,
      replay_manifest: canonicalHash(replayReceipts),
      mutation_manifest: canonicalHash(mutationReceipts),
      current_receipt: replayReceipts[0]!.deterministic_hash,
    },
    data_class: policy.data_class,
  });
}
