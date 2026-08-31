# Project DNA Engine

Project DNA is Hunch's evidence-bound model of **how a repository communicates and works**. It is not a model persona and it is not a second memory store.

The durable architecture remains:

```text
committed repository evidence
explicitly authorized PR/review candidates
        │
        ▼
Hunch Project DNA
  deterministic observed traits
  confidence + exact revision + evidence hashes
        │
        ▼
validated Hunch delivery
        │
        ▼
Hunch Memory
  transport/isolation/durability only
        │
        ▼
host context assembly (for example ORC)
        │
        ▼
policy-selected agent
```

## Authority boundary

A Project DNA trait is an **observation** until separately promoted through Hunch's existing reviewed durable-knowledge mechanisms. DNA may influence orientation, wording and advisory match scoring. It may not create or override a Decision, Constraint, Finding, policy, conformance rule or execution authorization.

The baseline discovery path is intentionally network-free and model-free. `discoverProjectDna(root, revision)` reads only:

- up to 200 non-merge commit subjects reachable from one exact commit;
- bounded committed convention files such as `CONTRIBUTING.md`, PR templates, `AGENTS.md` and `CLAUDE.md`;
- no dirty worktree state;
- no GitHub API, review comments, user profile, transcript, model output or private global state.

This makes the profile reproducible for a source revision and safe to transport as provider evidence.

An authorized host may separately call `sealProjectDnaHostEvidence(revision, candidates)` and pass
the resulting `hunch.project-dna-host-evidence/1` batch to
`discoverProjectDna(root, revision, { hostEvidence })`. The bounded contract accepts merged pull
requests and review comments with an explicit maintainer/contributor/unknown role. Hunch validates
the exact revision, canonical item identities and content seal before inference. It still performs no
provider request and receives no credential, account session or provider URL.

Only aggregate traits, sample counts, the opaque evidence-set ID and its hash enter the profile. Raw
PR titles, bodies and review comments do not. Omitting the batch produces the exact baseline profile,
so provider evidence is opt-in rather than ambient state.

## Contract

The canonical library contract is `hunch.project-dna/1` in `src/core/projectDna.ts`.

A profile contains:

- `profile_id`: content-addressed profile identity;
- `repository_id`: clone-stable, opaque repository-lineage identity derived from root commits;
- `repository_revision`: exact Git commit;
- bounded history/source counts;
- ordered traits;
- a content seal.

Each trait contains:

- stable trait ID;
- category (`communication`, `engineering`, `review`, `culture`, `vocabulary`);
- stable key;
- concise claim;
- confidence;
- explicit observed/current/non-contradicted state;
- one or more exact-revision evidence references with content hashes.

Committed evidence is labelled `committed-repository`; explicitly supplied provider evidence is
labelled `host-provided` and uses an opaque `host:pdnah_…` reference. Both have repository
visibility. Hunch never puts dirty-worktree bytes, credentials, filesystem paths, ambient GitHub
data, raw PR/review text or model output in the profile.

The first deterministic discovery signals include:

- Conventional Commit prevalence;
- title terminal-punctuation convention;
- lowercase descriptive-title convention;
- issue-reference prevalence when strongly established;
- repeated repository vocabulary in commit subjects;
- explicit committed expectations around tests, focused changes, backward compatibility, documentation and explaining PR rationale.

When an authorized host batch is present, the same deterministic threshold model can additionally
observe PR-title conventions, PR vocabulary, rationale practice, and recurring maintainer review
expectations. Candidate dispositions and author roles are structural evidence inputs; Hunch does not
pretend that contributor frequency is maintainer authority.

A signal is emitted only after a bounded threshold is met. Small histories do not manufacture communication culture.

## Project Match

`evaluateProjectDnaMatch(profile, artifact)` produces `hunch.project-dna-match/1`.

Only traits with a deterministic check for that artifact participate in the score. Orientation-only traits are retained with `applicable: false`; they do not silently become pass/fail guesses.

Examples of currently checkable traits:

- commit subject follows the observed Conventional Commit form;
- title follows terminal punctuation convention;
- descriptive title follows observed lowercase convention;
- expected issue reference is present;
- a PR body contains an explicit rationale signal when the repository has an evidence-backed `pr.explain_why` trait.

The match score is advisory. It must never block a commit/PR by itself and must never be presented as proof of maintainer acceptance.

## Agent and CLI surfaces

The same canonical contract is available without writing memory:

```text
hunch dna inspect [--ref <commit>] [--json]
hunch dna match --kind <commit|pull_request|issue|message> --title <text> [--body <text>] [--ref <commit>] [--json]
hunch dna context [--ref <commit>] [--traits <count>] [--json]
hunch dna diff <from> <to> [--json]
```

Programmatic consumers import the stable, declaration-backed `@davesheffer/hunch/project-dna` entry
point. It exports discovery, matching, deltas, host-evidence sealing/validation, and their public
types. MCP clients use
`hunch_project_dna` for the sealed profile, `hunch_project_dna_delta` for drift, and
`hunch_project_match` for an explainable artifact evaluation. Normal `hunch_context` delivery now
adds the same bounded DNA supplement after ranked memory when budget remains. These surfaces never
adopt traits, mutate the graph or grant enforcement authority.

## Drift and currentness

DNA does not mutate in place. A profile belongs to one exact repository revision. A newer revision produces a newly sealed profile. Consumers can therefore distinguish:

```text
same profile_id       -> exact same observed DNA
new profile_id        -> evidence set and/or derived traits changed
old repository_revision -> stale for a newer checkout unless explicitly requested for history
```

This is the anti-drift foundation. Continuous refresh supplies a new exact-revision profile and
`diffProjectDna(from, to)` surfaces the sealed trait delta; historical profiles are never rewritten.
Host outcome evidence follows the same rule: a new authorized evidence batch creates a new profile,
not an in-place mutation or an automatic graph write.

## Relationship to Repository Intelligence

Project DNA answers:

> How does this repository demonstrably communicate and work?

Repository Intelligence may later answer:

> What might those signals imply about risk, trajectory or likely maintainer reaction?

Those inferred hypotheses must live above DNA, carry separate confidence/evidence and never silently write back into the factual DNA profile.

## Cross-product contract map

| Layer | Owns | Must not own |
| --- | --- | --- |
| Hunch | inference, profile/match/delta schemas, seals, bounded delivery | persistence tenancy, final prompts, execution authority |
| Hunch Memory | authenticated store scope, immutable snapshots/deltas, compatibility transport | inference, trait ranking changes, policy promotion |
| ORC | source authorization, revision binding, role-shaped context, receipts, fallback | rewriting Hunch evidence or treating DNA as authority |

## Production roadmap

1. ~~Thin CLI/MCP projections over the canonical library contract.~~ Landed: read-only CLI and structured MCP surfaces share the sealed core contract.
2. ~~Delivery-envelope integration with a bounded DNA orientation budget.~~ Landed in normal MCP context delivery.
3. ~~Hunch Memory additive transport that preserves the Hunch profile/delta envelope without interpreting it.~~ Landed with immutable store-scoped snapshots, history, deltas and currentness.
4. ~~ORC ContextAssembler integration as a distinct Hunch-derived Stage section, preserving provider provenance and host-owned final budget.~~ Landed with role projection, exact receipts and controlled fallback.
5. ~~Optional host-provided review/PR evidence intake through a bounded candidate contract.~~ Landed across Hunch, Memory and ORC without ambient GitHub scraping or raw-text persistence.
6. ~~Profile-delta/currentness and repository-scale validation.~~ Landed with the cross-repository harness and a frozen, exactly reproducible Infection profile over 200 commit subjects.

The production roadmap is complete. The architecture remains deliberately bounded: future empirical
quality studies or reusable public-profile catalogs may extend the product, but they are not missing
runtime wiring in this contract.
