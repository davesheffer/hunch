# Project DNA

Project DNA is Hunch's evidence-bound model of **how a repository communicates and works**. It is not a model persona and it is not a second memory store.

The current repository capability is shipped and remains authoritative for repository-scoped DNA. The broader deterministic-state roadmap extends the same idea to user, team and organization scopes; it does not replace repository Project DNA.

Read [Deterministic organizational state](deterministic-state.md) for the current product direction.

## Durable architecture

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
any authorized agent / host
```

Hunch owns the profile, evidence, seals, matching and bounded delivery. A host owns source authorization, final context assembly and execution. No separate transport product or privileged orchestrator is required by the contract.

Future hosted state service work should serve the same profile through the one state graph and one versioned state contract rather than introducing a second Project DNA authority.

## Authority boundary

A Project DNA trait is an **observation** until separately promoted through Hunch's existing reviewed durable-knowledge mechanisms. DNA may influence orientation, wording and advisory match scoring. It may not create or override a Decision, Constraint, Finding, policy, conformance rule, connector permission or execution authorization.

The baseline discovery path is intentionally network-free and model-free. `discoverProjectDna(root, revision)` reads only:

- up to 200 non-merge commit subjects reachable from one exact commit;
- bounded committed convention files such as `CONTRIBUTING.md`, PR templates, `AGENTS.md` and `CLAUDE.md`;
- no dirty worktree state;
- no GitHub API, review comments, user profile, transcript, model output or private global state.

This makes the profile reproducible for a source revision and safe to deliver as evidence.

An authorized host may separately call `sealProjectDnaHostEvidence(revision, candidates)` and pass the resulting `hunch.project-dna-host-evidence/1` batch to `discoverProjectDna(root, revision, { hostEvidence })`.

The bounded contract accepts merged pull requests and review comments with an explicit maintainer/contributor/unknown role. Hunch validates the exact revision, canonical item identities and content seal before inference. It performs no provider request and receives no credential, account session or provider URL.

Only aggregate traits, sample counts, the opaque evidence-set ID and its hash enter the profile. Raw PR titles, bodies and review comments do not. Omitting the host batch produces the exact baseline profile, so provider evidence is opt-in rather than ambient state.

## Contract

The canonical repository contract is `hunch.project-dna/1` in `src/core/projectDna.ts`.

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

Committed evidence is labelled `committed-repository`; explicitly supplied provider evidence is labelled `host-provided` and uses an opaque `host:pdnah_…` reference. Both have repository visibility.

Hunch never puts dirty-worktree bytes, credentials, filesystem paths, ambient GitHub data, raw PR/review text or model output in the profile.

## Discovery signals

The deterministic discovery model can observe, when evidence crosses bounded thresholds:

- Conventional Commit prevalence;
- title terminal-punctuation convention;
- lowercase descriptive-title convention;
- issue-reference prevalence when strongly established;
- repeated repository vocabulary in commit subjects;
- explicit committed expectations around tests, focused changes, backward compatibility, documentation and explaining PR rationale;
- PR-title conventions and rationale practice from an explicitly supplied host-evidence batch;
- recurring maintainer review expectations from authorized review evidence.

Candidate dispositions and author roles are structural evidence inputs; Hunch does not pretend contributor frequency is maintainer authority.

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

Programmatic consumers import the stable, declaration-backed `@davesheffer/hunch/project-dna` entry point. It exports discovery, matching, deltas, host-evidence sealing/validation and their public types.

MCP clients use `hunch_project_dna` for the sealed profile, `hunch_project_dna_delta` for drift and `hunch_project_match` for explainable artifact evaluation. Normal `hunch_context` delivery may add the same bounded DNA supplement after ranked memory when budget remains.

These surfaces never adopt traits, mutate the graph or grant enforcement authority.

## Drift and currentness

DNA does not mutate in place. A profile belongs to one exact repository revision. A newer revision produces a newly sealed profile.

Consumers can therefore distinguish:

```text
same profile_id          -> exact same observed DNA
new profile_id           -> evidence set and/or derived traits changed
old repository_revision  -> stale for a newer checkout unless explicitly requested for history
```

`diffProjectDna(from, to)` surfaces the sealed trait delta. Historical profiles are never rewritten.

Host outcome evidence follows the same rule: a new authorized evidence batch creates a new profile, not an in-place mutation or automatic graph write.

## Usefulness observations

`hunch.project-dna-usefulness-observation/1` is a separate outcome contract; it does not broaden the record-bound `hunch.usefulness-observation/1` schema.

It seals the exact delivery receipt, profile/snapshot/retrieval hashes, role-shaped trait projection, downstream artifact and Project Match assessment. Project Match remains explicitly non-causal.

A terminal run can therefore produce `unknown`. Every classified signal requires a content-free reference to an explicit human observation or independent review. Contradiction and staleness may create an open advisory Finding, but no observation changes ranking, mutates a profile, promotes knowledge or grants authority on its own.

## Relationship to deterministic organizational state

Repository Project DNA answers:

> **How does this repository demonstrably communicate and work?**

The organizational-state roadmap adds related but distinct scopes:

- **user DNA** — explicit durable working preferences/rules for one principal;
- **team DNA** — reviewed team-level working conventions;
- **organization DNA** — reviewed organization-wide conventions and boundaries.

These scopes should use the same core properties: stable identity, provenance, confidence/currentness, contradiction visibility, reviewable history and explicit authority.

Repository DNA must remain revision-bound to repository evidence. A team or organization convention must not silently rewrite an observed repository profile.

## State-service boundary

The future state service may host and deliver DNA partitions, but it must not become a connector gateway or ambient scraper.

For repository DNA:

```text
repository evidence -> Hunch DNA profile -> state/delivery contract -> agent
```

For user/team/org DNA:

```text
explicit reviewed state -> authorized partition -> state/delivery contract -> agent
```

The agent remains responsible for live source access and execution. DNA remains context/evidence, not connector authority.

## Production status

The original repository Project DNA production path is complete:

1. read-only CLI/MCP projections share the canonical sealed library contract;
2. normal delivery can include a bounded DNA orientation budget;
3. exact-revision profile/delta/currentness behavior is implemented;
4. optional bounded host-provided PR/review evidence is implemented without ambient provider scraping;
5. cross-repository validation covered scale, isolation and malformed input;
6. receipt-bound usefulness observation is implemented without turning Project Match into causal authority.

Previous Hunch Memory and ORC integrations remain historical proof that the contract could survive transport and consumption by another process. They are no longer the future product topology.

## Non-goals

- Generic persona cloning.
- Pretending an agent is a specific human maintainer.
- Blindly copying slang or superficial writing quirks.
- Treating frequency as truth.
- Letting generated agent output train the repository profile without an evidence/authority boundary.
- Creating another source of truth beside the Hunch graph.
- Giving Project DNA connector permissions or execution authority.
- Requiring ORC or a separate Hunch Memory product to use Project DNA.
