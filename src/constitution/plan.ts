import { basename } from "node:path";
import { shortHash } from "../core/ids.js";
import { firstCommitForFile, headSha, revExists, revParse } from "../extractors/git.js";
import type { HunchStore } from "../store/hunchStore.js";
import { canonicalHash, policySemanticHash } from "./canonical.js";
import { mutationOperatorForPolicy } from "./evaluator.js";
import type { PolicyRepository } from "./repository.js";
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
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function hasBareNameSelector(policy: PolicySpec): boolean {
  const assertion = policy.assertion;
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
  const head = headSha(root);
  if (!head) throw new Error("proof planning needs a Git repository with a current HEAD");
  const policyHash = policySemanticHash(policy);
  const corpus = repository.getCorpus(policy.id, opts);
  if (corpus) {
    if (corpus.policy_hash !== policyHash) {
      throw new Error(`proof corpus ${corpus.id} is stale for policy ${policy.id}; re-import it after the policy semantic change`);
    }
    if (corpus.repository !== basename(root) || corpus.data_class !== policy.data_class) {
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
  const policyCommit = firstCommitForFile(`.hunch/policies/${policy.id}.json`, root);
  const sourceRef = sourceEvent?.commit ?? decision?.commit ?? (policyCommit || head);
  if (!revExists(sourceRef, root)) throw new Error(`proof-plan source commit ${sourceRef} does not resolve in this repository`);
  const sourceCommit = revParse(sourceRef, root);
  const structural = events.find((event) => event.structural_delta && (event.kind === "bug_fix" || event.kind === "revert"));
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
  const maxCommits = clamp(opts.maxCommits, 20, 0, 500);
  const maxMutations = clamp(opts.maxMutations, 3, 0, 100);
  const operator = mutationOperatorForPolicy(policy);
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
    repository: basename(root),
    data_class: policy.data_class,
    source_commit: sourceCommit,
    valid_from_commit: sourceCommit,
    evaluator: { ...POLICY_EVALUATOR },
    mutation_engine: { ...MUTATION_ENGINE },
    ...(corpus ? { corpus_manifest: { id: corpus.id, content_hash: corpus.content_hash } } : {}),
    corpus: {
      current_baseline: { kind: "commit" as const, ref: head, label: "current repository baseline", expected: "satisfied" as const },
      accepted_history: {
        from: sourceCommit,
        to: head,
        first_parent: true,
        max_commits: maxCommits,
        exclude: knownBad.map((fixture) => fixture.ref),
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
