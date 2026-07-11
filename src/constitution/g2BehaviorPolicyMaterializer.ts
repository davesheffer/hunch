import { basename } from "node:path";
import { z } from "zod";
import { shortHash } from "../core/ids.js";
import type { HunchStore } from "../store/hunchStore.js";
import { headSha } from "../extractors/git.js";
import { canonicalHash, policyId, policySemanticHash } from "./canonical.js";
import { compileProofCorpus } from "./corpus.js";
import { assessG2BehaviorMaterialization, type G2BehaviorMaterializationAssessment } from "./g2BehaviorMaterialization.js";
import {
  dependencySnapshotById,
  dependencySnapshotForCommit,
  provisionG2BehaviorDependencySnapshotsForCommits,
  type G2BehaviorDependencySnapshot,
} from "./g2BehaviorDependencies.js";
import {
  g2BehaviorCandidateHash,
  type G2BehaviorCandidate,
  type G2BehaviorCandidateReview,
} from "./g2BehaviorCandidates.js";
import type { G2BehaviorAttestation } from "./g2BehaviorAttestation.js";
import { executableBehaviorAttestationError } from "./behaviorAttestationBinding.js";
import { proposeProvedPolicy } from "./lifecycle.js";
import { createProofPlan } from "./plan.js";
import { provePolicy } from "./proof.js";
import type { PolicyRepository } from "./repository.js";
import {
  EXECUTABLE_BEHAVIOR_IR_VERSION,
  PolicySpecSchema,
  type PolicyProof,
  type PolicySpec,
} from "./schema.js";

const HASH = /^sha1:[a-f0-9]{40}$/;

const MaterializedItemSchema = z.object({
  candidate_id: z.string().regex(/^g2behavior_[a-f0-9]{10}$/),
  attestation_id: z.string().regex(/^g2behaviorattest_[a-f0-9]{10}$/),
  policy_id: z.string().regex(/^pol_[a-f0-9]{10}$/),
  policy_hash: z.string().regex(HASH),
  corpus_id: z.string().regex(/^corpus_[a-f0-9]{10}$/),
  corpus_hash: z.string().regex(HASH),
  plan_id: z.string().regex(/^plan_[a-f0-9]{10}$/),
  plan_hash: z.string().regex(HASH),
  proof_id: z.string().regex(/^proof_[a-f0-9]{10}$/),
  proof_hash: z.string().regex(HASH),
  proof_class: z.literal("P3"),
  policy_state: z.enum(["proposed", "active_advisory", "active_blocking"]),
}).strict();

export const G2BehaviorPolicyMaterializationSchema = z.object({
  id: z.string().regex(/^g2behaviorpolicies_[a-f0-9]{10}$/),
  content_hash: z.string().regex(HASH),
  assessment_id: z.string().regex(/^g2behaviormaterialization_[a-f0-9]{10}$/),
  assessment_hash: z.string().regex(HASH),
  source_review_id: z.string().regex(/^g2behaviorcandidates_[a-f0-9]{10}$/),
  source_review_hash: z.string().regex(HASH),
  current_commit: z.string().regex(/^[a-f0-9]{40}$/),
  dependency_snapshots: z.array(z.object({ id: z.string().regex(/^g2deps_[a-f0-9]{10}$/), content_hash: z.string().regex(HASH) }).strict()).min(1),
  materialized_policies: z.number().int().min(1),
  items: z.array(MaterializedItemSchema).min(1),
  data_class: z.literal("private"),
  authority: z.literal("none"),
  effects: z.literal("policy_proposal_only"),
  writes: z.literal("private_policy_artifacts"),
  activation: z.literal("separate_human_action_required"),
}).strict();

export type G2BehaviorPolicyMaterialization = z.infer<typeof G2BehaviorPolicyMaterializationSchema>;

function compileBehaviorPolicy(
  root: string,
  candidate: G2BehaviorCandidate,
  attestation: G2BehaviorAttestation,
  dependencySnapshotIds: string[],
  now: string,
): PolicySpec {
  const assertion = {
    kind: "executable-behavior" as const,
    test: {
      file: candidate.test.file,
      name: candidate.test.name,
      source_commit: candidate.proposed_corpus.known_good.ref,
      source_hash: candidate.test.source_hash,
    },
    runner: candidate.runner.kind,
    attestation: {
      id: attestation.id,
      content_hash: attestation.content_hash,
      candidate_id: attestation.candidate_id,
      candidate_hash: attestation.candidate_hash,
      replay_id: attestation.replay_id,
      replay_hash: attestation.replay_hash,
    },
    dependency_snapshot_ids: [...new Set(dependencySnapshotIds)].sort(),
    timeout_ms: 30_000,
  };
  const id = policyId({ assertion, repository: basename(root), data_class: "private" });
  const evidence = [...new Set([
    attestation.id,
    attestation.replay_id,
    candidate.id,
    ...candidate.decision_ids,
    ...candidate.source_attestation_ids,
  ])].sort();
  return PolicySpecSchema.parse({
    id,
    topic: `g2.behavior.${candidate.id}`,
    ir_version: EXECUTABLE_BEHAVIOR_IR_VERSION,
    revision: 1,
    state: "compiled",
    statement: attestation.reason,
    rationale: `Human-selected executable regression ${candidate.test.file} :: ${candidate.test.name}`,
    scope: { repos: [basename(root)], paths: [], components: [] },
    assertion,
    severity: "warning",
    surfaces: ["pre_commit", "ci", "mcp", "cli"],
    authority: null,
    evidence,
    proof: null,
    reversal_conditions: [`Behavior attestation ${attestation.id} is superseded, rejected, or its exact test/replay binding no longer verifies.`],
    supersedes: null,
    superseded_by: null,
    exception_of: null,
    valid_from: null,
    valid_to: null,
    data_class: "private",
    limitations: [
      "The assertion executes one exact hash-pinned node:test case from a human-selected fixing commit; it does not encode a helper symbol or call-edge proxy.",
      "Proof and history replay use committed Git states; advisory delivery may evaluate a content-addressed staged or working snapshot in a disposable checkout.",
      "Executable evidence creates no authority. Advisory or blocking activation requires a separate explicit human lifecycle action.",
    ],
    candidate: {
      alternatives: [],
      uncertainty: [],
      conflicts: [],
      incumbent: null,
      scope_suggestion: null,
      counterexamples: [],
    },
    legacy_refs: candidate.decision_ids,
    audit: [{
      action: "compiled",
      actor_kind: "system",
      actor: "hunch:behavior-materializer",
      at: now,
      reason: `Compiled only from current selected behavior attestation ${attestation.id}.`,
      proof: null,
    }],
    created_at: now,
    updated_at: now,
    provenance: {
      source: "human_confirmed+executable_regression",
      confidence: 1,
      evidence,
      last_verified: now,
    },
  });
}

function exactSnapshotProjection(snapshots: G2BehaviorDependencySnapshot[]): Array<{ id: string; content_hash: string }> {
  return snapshots.map((snapshot) => ({ id: snapshot.id, content_hash: snapshot.content_hash }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function materializeSelectedG2BehaviorPolicies(
  store: HunchStore,
  root: string,
  repository: PolicyRepository,
  report: G2BehaviorCandidateReview,
  currentAttestations: G2BehaviorAttestation[],
  opts: { now?: string; allowInstallScripts?: string[]; dependencyTimeoutMs?: number } = {},
): G2BehaviorPolicyMaterialization {
  if (!store.hasPrivate) throw new Error("selected executable behavior materialization requires a configured private Hunch overlay");
  const assessment: G2BehaviorMaterializationAssessment = assessG2BehaviorMaterialization(report, currentAttestations);
  if (assessment.readiness !== "ready_for_materialization") throw new Error(`behavior assessment ${assessment.id} is not ready for materialization`);
  const currentCommit = headSha(root);
  if (!/^[a-f0-9]{40}$/.test(currentCommit)) throw new Error("behavior materialization requires a current full-SHA HEAD");
  const candidateHashes = new Map(report.items.map((candidate) => [candidate.id, g2BehaviorCandidateHash(candidate)]));
  const selected = currentAttestations.filter((attestation) => attestation.disposition === "selected"
      && candidateHashes.get(attestation.candidate_id) === attestation.candidate_hash)
    .sort((left, right) => left.candidate_id.localeCompare(right.candidate_id));
  const dependencies = provisionG2BehaviorDependencySnapshotsForCommits(
    root,
    [currentCommit],
    opts.allowInstallScripts ?? [],
    opts.dependencyTimeoutMs ?? 300_000,
  );
  const currentDependencyId = dependencies.commits[0]!.dependency_snapshot_id;
  const attestedSnapshots = selected.flatMap((attestation) => attestation.dependency_snapshot_ids.map((id) => {
    const snapshot = dependencySnapshotById(root, id);
    if (!snapshot) throw new Error(`selected behavior attestation ${attestation.id} binds unavailable dependency snapshot ${id}`);
    return snapshot.snapshot;
  }));
  for (const attestation of selected) {
    const candidate = report.items.find((item) => item.id === attestation.candidate_id)!;
    for (const commit of [candidate.proposed_corpus.known_bad.ref, candidate.proposed_corpus.known_good.ref]) {
      if (!dependencySnapshotForCommit(root, commit, attestation.dependency_snapshot_ids)) {
        throw new Error(`selected behavior attestation ${attestation.id} has no exact bound dependency snapshot for ${commit}`);
      }
    }
  }
  const allSnapshots = [...new Map([...dependencies.snapshots, ...attestedSnapshots].map((snapshot) => [snapshot.id, snapshot])).values()];
  const now = opts.now ?? new Date().toISOString();
  const items = selected.map((attestation) => {
    const candidate = report.items.find((item) => item.id === attestation.candidate_id)!;
    const compiled = compileBehaviorPolicy(root, candidate, attestation, [currentDependencyId, ...attestation.dependency_snapshot_ids], now);
    const existingPolicy = repository.getPolicy(compiled.id, { privateOnly: true });
    if (existingPolicy && policySemanticHash(existingPolicy) !== policySemanticHash(compiled)) {
      throw new Error(`existing behavior policy ${compiled.id} has different semantics`);
    }
    let policy = existingPolicy ?? repository.putPolicy(compiled, { private: true });
    const compiledCorpus = compileProofCorpus(root, policy, {
      known_bad: [{ ref: candidate.proposed_corpus.known_bad.ref, label: `known-bad behavior before ${candidate.commit}` }],
      known_good: [{
        ref: candidate.proposed_corpus.known_good.ref,
        label: `human-selected fixing behavior ${candidate.commit}`,
        attestation: { actor: attestation.actor, reason: attestation.reason },
      }],
    }, { now });
    const existingCorpus = repository.getCorpus(policy.id, { privateOnly: true });
    if (existingCorpus && existingCorpus.content_hash !== compiledCorpus.content_hash) {
      throw new Error(`existing behavior corpus ${existingCorpus.id} differs from exact selected evidence`);
    }
    const corpus = existingCorpus ?? repository.putCorpus(compiledCorpus, policy.id);
    const generatedPlan = createProofPlan(store, root, repository, policy, { privateOnly: true, maxCommits: 0, maxMutations: 2, now });
    const plan = repository.getPlan(generatedPlan.id, { privateOnly: true }) ?? repository.putPlan(generatedPlan, policy.id, { private: true });
    const generatedProof = provePolicy(store, root, policy, { plan, now });
    if (generatedProof.proof_class !== "P3") {
      const outcomes = generatedProof.replay_receipts
        .map((receipt) => `${receipt.leg}:${receipt.result}${receipt.error_code ? `(${receipt.error_code})` : ""}`)
        .join(", ");
      throw new Error(`behavior policy ${policy.id} proof is ${generatedProof.proof_class}; exact P3 is required for materialization (${outcomes})`);
    }
    const proof: PolicyProof = repository.getProof(generatedProof.id, { privateOnly: true }) ?? repository.putProof(generatedProof, policy.id);
    if (policy.state === "compiled" || policy.state === "validating" || policy.state === "proposed") {
      const proposed = policy.state === "proposed" && policy.proof === proof.id
        ? policy
        : proposeProvedPolicy(policy, proof, now, [], currentAttestations);
      policy = proposed === policy ? policy : repository.putPolicy(proposed, { private: true });
    } else if (policy.proof !== proof.id) {
      throw new Error(`behavior policy ${policy.id} is ${policy.state} with a different proof`);
    }
    return {
      candidate_id: candidate.id,
      attestation_id: attestation.id,
      policy_id: policy.id,
      policy_hash: policySemanticHash(policy),
      corpus_id: corpus.id,
      corpus_hash: corpus.content_hash,
      plan_id: plan.id,
      plan_hash: plan.content_hash,
      proof_id: proof.id,
      proof_hash: canonicalHash(proof),
      proof_class: proof.proof_class as "P3",
      policy_state: policy.state as "proposed" | "active_advisory" | "active_blocking",
    };
  });
  const body = {
    assessment_id: assessment.id,
    assessment_hash: assessment.content_hash,
    source_review_id: report.id,
    source_review_hash: report.content_hash,
    current_commit: currentCommit,
    dependency_snapshots: exactSnapshotProjection(allSnapshots),
    materialized_policies: items.length,
    items,
    data_class: "private" as const,
    authority: "none" as const,
    effects: "policy_proposal_only" as const,
    writes: "private_policy_artifacts" as const,
    activation: "separate_human_action_required" as const,
  };
  const contentHash = canonicalHash(body);
  return G2BehaviorPolicyMaterializationSchema.parse({
    id: `g2behaviorpolicies_${shortHash(contentHash)}`,
    content_hash: contentHash,
    ...body,
  });
}
