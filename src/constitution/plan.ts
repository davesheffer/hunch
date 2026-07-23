import { shortHash } from "../core/ids.js";
import { stableRepositoryName } from "../extractors/git.js";
import type { HunchStore } from "../store/hunchStore.js";
import { canonicalHash, policySemanticHash } from "./canonical.js";
import { policyCompositionBinding, policyProofHash } from "./composition.js";
import { graphSnapshot, mutationOperatorForPolicy, selectedPolicyForComposition } from "./evaluator.js";
import type { PolicyRepository } from "./repository.js";
import { createExecutableBehaviorProofPlan } from "./behaviorProof.js";
import { canonicalStaticGraphBaseline, isAncestorOrSame } from "./staticGraphBaseline.js";
import { replacementFreeExactCommit, replacementFreeFirstCommitForFile } from "./replacementFreeGit.js";
export { canonicalStaticGraphBaseline } from "./staticGraphBaseline.js";
import {
  POLICY_EVALUATOR,
  MUTATION_ENGINE,
  ProofPlanSchema,
  type EvidenceEvent,
  type PolicySpec,
  type ProofPlan,
  type ProofFixtureRef,
} from "./schema.js";

export interface ProofPlanOptions {
  maxCommits?: number;
  maxMutations?: number;
  maxMinutes?: number;
  now?: string;
  publicOnly?: boolean;
  privateOnly?: boolean;
  composition?: PolicySpec[];
  /** Optional stable artifact label for worktree-agnostic materializers. */
  repositoryName?: string;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function hasBareNameSelector(policy: PolicySpec): boolean {
  const assertion = policy.assertion;
  if (assertion.kind === "executable-behavior") return false;
  const selectors = [assertion.subject, ...(assertion.kind === "exists" ? [] : [assertion.object]), ...(assertion.kind === "must-pass-through" ? [assertion.via] : [])];
  return selectors.some(({ selector }) => selector.startsWith("symbol:") && !selector.slice("symbol:".length).includes(":"));
}

function relevantEvents(repository: PolicyRepository, policy: PolicySpec, opts: ProofPlanOptions): EvidenceEvent[] {
  const refs = new Set(policy.evidence.filter((ref) => ref.startsWith("ev_")));
  return repository.listEvidence(opts)
    .filter((event) => refs.has(event.id) || event.related_records.includes(policy.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function mergeFixtures(groups: ProofFixtureRef[][]): ProofFixtureRef[] {
  const byCommit = new Map<string, ProofFixtureRef>();
  for (const fixture of groups.flat()) {
    const existing = byCommit.get(fixture.ref);
    if (existing && existing.expected !== fixture.expected) {
      throw new Error(`fixture commit ${fixture.ref} has conflicting ${existing.expected}/${fixture.expected} expectations`);
    }
    if (!existing) byCommit.set(fixture.ref, fixture);
  }
  return [...byCommit.values()].sort((a, b) => a.ref.localeCompare(b.ref) || a.label.localeCompare(b.label));
}

/** Deterministic compiler-to-harness contract. It plans replay and mutations but
 * executes neither, grants no authority, and performs no provider/model call. */
export function createProofPlan(
  store: HunchStore,
  root: string,
  repository: PolicyRepository,
  policy: PolicySpec,
  opts: ProofPlanOptions = {},
): ProofPlan {
  if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
  if (policy.assertion.kind === "executable-behavior") {
    if (opts.composition?.length) throw new Error("executable-behavior policies cannot have exception composition");
    return createExecutableBehaviorProofPlan(root, repository, policy, { now: opts.now, privateOnly: true });
  }
  const repositoryHead = replacementFreeExactCommit(root, "HEAD");
  if (!repositoryHead) throw new Error("proof planning needs a Git repository with a current HEAD");
  const head = canonicalStaticGraphBaseline(root, repositoryHead);
  const composition = opts.composition ?? [];
  const parentHash = policySemanticHash(policy);
  const policyHash = policyProofHash(policy, composition);
  const compositionBinding = policyCompositionBinding(policy, composition);
  const corpus = repository.getCorpus(policy.id, opts);
  // Proof plans are shared memory. A clone-local directory basename would mint
  // different plan IDs for Architect, Developer, CI, and linked worktrees even
  // when every one of them is looking at the same repository and policy. An
  // existing immutable corpus remains the compatibility authority for artifacts
  // created before stable repository identities were introduced.
  const repositoryName = opts.repositoryName ?? corpus?.repository ?? stableRepositoryName(root);
  if (corpus) {
    if (corpus.policy_hash !== parentHash) {
      throw new Error(`proof corpus ${corpus.id} is stale for policy ${policy.id}; re-import it after the policy semantic change`);
    }
    if (corpus.repository !== repositoryName || corpus.data_class !== policy.data_class) {
      throw new Error(`proof corpus ${corpus.id} does not match repository/data class for policy ${policy.id}`);
    }
  }
  const events = relevantEvents(repository, policy, opts);
  const sourceEvent = events.find((event) => !!event.commit);
  const readDecision = (id: string) => opts.publicOnly
    ? store.json.get("decisions", id)
    : opts.privateOnly
      ? store.getPrivateRec("decisions", id)
      : store.getRec("decisions", id);
  const decision = [...policy.legacy_refs, ...policy.evidence]
    .filter((ref) => ref.startsWith("dec_"))
    .map(readDecision)
    .find((record) => !!record);
  const policyCommit = replacementFreeFirstCommitForFile(root, `.hunch/policies/${policy.id}.json`);
  const sourceRef = sourceEvent?.commit ?? decision?.commit ?? (policyCommit || head);
  const rawSource = replacementFreeExactCommit(root, sourceRef);
  if (!rawSource) throw new Error(`proof-plan source commit ${sourceRef} does not resolve in this repository`);
  // Canonicalize the source independently of current HEAD. A policy introduced
  // by a Hunch-only publication commit remains anchored to the indexed-code (or
  // merge) boundary immediately before that publication, even after later code
  // commits advance the current baseline.
  const sourceCommit = canonicalStaticGraphBaseline(root, rawSource);
  if (!isAncestorOrSame(root, sourceCommit, head)) {
    throw new Error(`proof-plan source commit ${sourceCommit} is not an ancestor of canonical graph baseline ${head}`);
  }
  const structural = events.find((event) => event.structural_delta && (event.kind === "bug_fix" || event.kind === "revert" || event.kind === "decision"));
  const structuralKnownBad = structural?.structural_delta
    ? [{
        kind: "commit" as const,
        ref: structural.structural_delta.before_commit,
        label: `first parent before linked ${structural.kind.replace("_", " ")}`,
        expected: "violated" as const,
      }]
    : [];
  const knownBad = mergeFixtures([corpus?.known_bad ?? [], structuralKnownBad]);
  const knownGood = mergeFixtures([
    corpus?.known_good ?? [],
    [{ kind: "commit", ref: head, label: "current accepted baseline", expected: "satisfied" }],
  ]);
  const attestedKnownGood = knownGood.filter((fixture) => !!fixture.attestation);
  const maxCommits = clamp(opts.maxCommits, 20, 0, 500);
  const maxMutations = clamp(opts.maxMutations, 3, 0, 100);
  const mutationPolicy = composition.length
    ? selectedPolicyForComposition(policy, composition, graphSnapshot(store, root, { publicOnly: opts.publicOnly }))
    : policy;
  const operator = mutationOperatorForPolicy(mutationPolicy);
  const plannedMutations = [
    { operator, base: head, expected: "violated" as const, required: true },
    { operator: "comment-string-control", base: head, expected: "satisfied" as const, required: true },
    {
      operator: "same-name-ambiguity-control",
      base: head,
      expected: hasBareNameSelector(policy) ? "unknown" as const : "satisfied" as const,
      required: true,
    },
  ].slice(0, maxMutations);
  const body = {
    policy_id: policy.id,
    policy_candidate_hash: policyHash,
    repository: repositoryName,
    data_class: policy.data_class,
    source_commit: sourceCommit,
    valid_from_commit: sourceCommit,
    evaluator: { ...POLICY_EVALUATOR },
    mutation_engine: { ...MUTATION_ENGINE },
    ...(compositionBinding ? { composition: compositionBinding } : {}),
    ...(corpus ? { corpus_manifest: { id: corpus.id, content_hash: corpus.content_hash } } : {}),
    corpus: {
      current_baseline: { kind: "commit" as const, ref: head, label: "current repository baseline", expected: "satisfied" as const },
      accepted_history: {
        from: sourceCommit,
        to: head,
        first_parent: true,
        max_commits: maxCommits,
        exclude: [...new Set([
          ...knownBad.map((fixture) => fixture.ref),
          ...attestedKnownGood.map((fixture) => fixture.ref),
        ])].sort(),
      },
      known_bad: knownBad,
      known_good: knownGood,
    },
    mutations: plannedMutations,
    budgets: {
      max_commits: maxCommits,
      max_mutations: maxMutations,
      max_minutes: clamp(opts.maxMinutes, 5, 1, 120),
    },
    expected: [
      { leg: "current_baseline" as const, result: "satisfied" as const, classification_required: false },
      ...(knownBad.length ? [{ leg: "known_bad" as const, result: "violated" as const, classification_required: false }] : []),
      { leg: "known_good" as const, result: "satisfied" as const, classification_required: false },
      { leg: "accepted_history" as const, classification_required: true },
      ...(maxMutations > 0 ? [{ leg: "mutations" as const, result: "violated" as const, classification_required: false }] : []),
    ],
    evidence_refs: [...new Set([...policy.evidence, ...events.map((event) => event.id)])].sort(),
    limitations: [
      "ProofPlan generation does not execute accepted-history replay or project tests.",
      "Known-bad commits are included only when an attributable fix/revert delta identifies the first parent.",
      ...(attestedKnownGood.length
        ? ["Human-attested known-good fixtures are replayed as explicit corpus evidence and excluded from accepted-history sampling; attestation cannot waive a policy or grant authority."]
        : []),
      ...(compositionBinding
        ? [`Plan binds the broad parent and ${compositionBinding.members.length} explicit scoped exception policy record(s) into one evaluator receipt.`]
        : []),
      ...policy.limitations,
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
