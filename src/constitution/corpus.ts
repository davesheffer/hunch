import { basename } from "node:path";
import { shortHash } from "../core/ids.js";
import { revExists, revParse } from "../extractors/git.js";
import { canonicalHash, policySemanticHash } from "./canonical.js";
import {
  ProofCorpusInputSchema,
  ProofCorpusSchema,
  type PolicySpec,
  type ProofCorpus,
  type ProofCorpusInput,
  type ProofFixtureRef,
} from "./schema.js";

function resolveFixture(
  root: string,
  fixture: ProofCorpusInput["known_bad"][number],
  expected: "violated" | "satisfied",
): ProofFixtureRef {
  if (!revExists(fixture.ref, root)) throw new Error(`corpus fixture ref ${fixture.ref} does not resolve to a commit`);
  const ref = revParse(`${fixture.ref}^{commit}`, root);
  if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error(`corpus fixture ref ${fixture.ref} did not resolve to a full commit SHA`);
  return { kind: "commit", ref, label: fixture.label, expected };
}

function sorted(fixtures: ProofFixtureRef[]): ProofFixtureRef[] {
  return fixtures.sort((a, b) => a.ref.localeCompare(b.ref) || a.label.localeCompare(b.label));
}

/** Resolve human-authored Git refs once, then persist an immutable, policy-bound
 * fixture manifest. No checkout, evaluator, model, provider, or project command runs. */
export function compileProofCorpus(
  root: string,
  policy: PolicySpec,
  raw: unknown,
  opts: { now?: string } = {},
): ProofCorpus {
  const input = ProofCorpusInputSchema.parse(raw);
  const knownBad = sorted(input.known_bad.map((fixture) => resolveFixture(root, fixture, "violated")));
  const knownGood = sorted(input.known_good.map((fixture) => resolveFixture(root, fixture, "satisfied")));
  const seen = new Map<string, "known_bad" | "known_good">();
  for (const [leg, fixtures] of [["known_bad", knownBad], ["known_good", knownGood]] as const) {
    for (const fixture of fixtures) {
      const existing = seen.get(fixture.ref);
      if (existing) throw new Error(`corpus fixture commit ${fixture.ref} is duplicated in ${existing} and ${leg}`);
      seen.set(fixture.ref, leg);
    }
  }
  const body = {
    policy_id: policy.id,
    policy_hash: policySemanticHash(policy),
    repository: basename(root),
    data_class: policy.data_class,
    known_bad: knownBad,
    known_good: knownGood,
  };
  const contentHash = canonicalHash(body);
  return ProofCorpusSchema.parse({
    id: `corpus_${shortHash(contentHash)}`,
    content_hash: contentHash,
    ...body,
    created_at: opts.now ?? new Date().toISOString(),
  });
}

export function proofCorpusContentHash(corpus: ProofCorpus): string {
  const { id: _id, content_hash: _contentHash, created_at: _createdAt, ...body } = corpus;
  return canonicalHash(body);
}
