# ORC outcome experience protocol

Updated 2026-08-22. This document defines Hunch's side of the reciprocal outcome/experience loop
with ORC. ORC's owning architecture is
[`docs/OUTCOME-EXPERIENCE-LOOP.md`](https://github.com/davesheffer/orc/blob/main/docs/OUTCOME-EXPERIENCE-LOOP.md).
Hunch remains independently useful without ORC, and this protocol does not make Hunch a workflow,
telemetry or model-training service.

## Purpose

ORC can bind execution to an objective, authority envelope, exact context, verification and observed
outcome. Hunch can deliver reviewed engineering knowledge and deterministic conformance. The
protocol lets independently evidenced ORC outcomes improve later Hunch retrieval and produce
reviewable knowledge candidates without turning a successful run, transcript or reward into truth.

```text
Hunch delivery receipt
  -> ORC authorized execution and independent outcome evidence
  -> provider-neutral ExperienceEpisode
  -> Hunch validates identity, evidence, eligibility and retention
  -> usefulness observations and findings/candidates
  -> normal Hunch review/proof lifecycle
  -> later validated delivery
```

## Ownership boundary

| Capability | ORC owns | Hunch owns |
| --- | --- | --- |
| Objective/outcome | outcome contract, observation window and terminal result | prior knowledge that informs or challenges the contract |
| Execution | planning, agents, tools, side effects, recovery and runtime policy | no execution authority |
| Evidence | exact Run/Stage/attempt lineage and independent outcome evidence | memory provenance/currentness and conformance evidence |
| Feedback | derivation of bounded evidence-bearing episode signals | validation, storage and retrieval use of those signals |
| Knowledge | proposals only | findings/candidates and reviewed promotion into decisions, constraints or policies |
| Adaptation | bounded routing inside existing permission | retrieval/ranking changes and reviewed engineering semantics |

ORC never writes an active Hunch decision, constraint or policy through this protocol. Hunch never
changes ORC authority, agent selection, workflow state or production outcome.

## Accepted episode envelope

Hunch accepts only a versioned provider-neutral episode whose conclusions resolve to explicit
evidence. The initial envelope must include:

```text
episode id and schema version
tenant/project identity and eligibility scope
ORC Run/Stage/attempt identity
OutcomeContract version/hash
exact starting and terminal revisions/state references
optional exact `hunch.change-identity/1` when a branch may land through squash
Hunch graph revision and native delivery receipt
exact delivered record IDs
resolved strategy/runtime/policy references
independent verification and outcome evidence references
result: pass | fail | uncertain | abandoned | rolled_back
bounded efficiency and intervention facts
per-record usefulness observations
privacy, retention, redaction and promotion eligibility
```

Transcript text, hidden reasoning and an executor's self-grade are never required evidence. Unknown
or unsupported conclusions remain `unknown`; absence of evidence is not converted to success.

## Receipt-bound usefulness

Per-record feedback is eligible only when the episode names the exact Hunch delivery receipt and
the record ID occurs in that receipt. Initial signals are:

- `used`: observable execution or verification evidence depended on the record;
- `prevented`: evidence shows the record stopped a known-invalid path before protected effect;
- `near_miss`: an invalid path was attempted but caught before outcome damage;
- `contradicted`: outcome evidence conflicts with the delivered record;
- `stale`: exact revision/currentness evidence invalidates the delivered record's applicability;
- `unused`: the record was delivered but no supported use is observable;
- `unknown`: attribution cannot be established.

`unused` is not negative authority, and correlation is not causation. Signals may affect retrieval
only through a versioned, replayable ranking policy. They never silently demote blocking authority
or promote a candidate into trusted knowledge.

## Findings and knowledge promotion

Contradiction, staleness, recurrent failure and transferable procedure evidence enters Hunch as a
finding or candidate with episode/evidence references. Promotion uses the existing lifecycle:

```text
episode observation
 -> finding/candidate
 -> deduplication and conflict/currentness checks
 -> human review and deterministic proof where applicable
 -> accepted decision/constraint/policy or explicit rejection/supersession
```

A single successful episode is never a universal rule. Strong procedural promotion requires
multiple comparable outcomes or another declared causal design, freshness evidence and held-out or
replay support appropriate to the claim.

## Idempotency and conflicts

- Re-ingestion of the same episode identity and content is idempotent.
- The same identity with different content fails visibly; it is never last-write-wins.
- Usefulness entries are keyed by episode, receipt and record identity.
- A newer episode does not mutate historical evidence; correction uses supersession.
- Deletion/retention changes propagate to derived usefulness and replay projections.

## Isolation and privacy

- Tenant/project scope is resolved from authenticated authorization, never episode prose.
- Cross-tenant aggregation uses only explicitly eligible, sanitized fields.
- Secrets, raw tool inputs, transcripts and hidden reasoning are excluded.
- Evidence references must remain authorized and independently resolvable.
- Hunch Memory may transport one token-resolved store's protocol records; it does not join stores.
- ORC alone authorizes cross-repository traversal and assembles multi-project experience views.

## Dependency-safe implementation

| ID | Hunch deliverable | Exit criterion |
| --- | --- | --- |
| OEL-0 | freeze additive episode/usefulness schemas and ownership fixtures | round-trip preserves identity/evidence with no second authority |
| OEL-1 | validate OutcomeContract and terminal-state references | implemented/verified/deployed/observed states remain distinct |
| OEL-2 | bind episodes to exact Hunch receipt/revision/record IDs | mismatched or absent receipts fail attribution |
| OEL-3 | ingest idempotent usefulness plus findings/candidates | no signal auto-promotes trusted knowledge |
| OEL-4+ | ranking/replay/promotion experiments | changes remain versioned, reversible and evidence-gated |

OEL-0 through OEL-3 are the first valuable slice. Later ranking or policy changes must pass Hunch's
normal deterministic evaluation and authority gates.

OEL-0 through OEL-3 are implemented across the service boundary. The Hunch-owned contract is
`hunch.usefulness-observation/1`: one episode/receipt/record identity has one deterministic key, and
different content under that key is a visible conflict. The seal binds the exact episode, current
Hunch Memory receipt, graph/source revision, record revision/content hash and bounded external
evidence references while excluding transcripts and provider output.

`hunch.change-identity/1` is now the optional squash-stable binding for an episode's exact code
change. It hashes Git's raw tree delta—paths, file modes and blob identities—so commit messages,
authors and squash metadata do not change the ID, while whitespace-only, binary, rename/path and
mode changes remain distinct. Git's looser stable patch ID is carried only for interoperability;
it is never the Hunch authority. `hunch change-id` and `hunch_change_identity` expose the same
sealed contract. When present on a usefulness observation, it changes the observation content seal
but not the episode/receipt/record idempotency key, so conflicting change attribution fails visibly.

Hunch Memory now resolves the authenticated store, proves the named issuance, validates and
idempotently retains the observation, and reports privacy-safe aggregate coverage without exposing
episode, receipt, record or evidence identifiers. ORC derives observations only from eligible
terminal outcomes and delivers them through the exact project connection. Missing connections,
unbound stores and delivery failures remain explicit operational states.

Every observation still has zero behavioral, ranking, promotion or authority effect. Only
`contradicted` and `stale` can become new open advisory Findings, and that conversion does not change
trusted knowledge. OEL-4 ranking and replay experiments remain gated on a meaningful aggregate
coverage baseline and the normal deterministic evaluation and authority checks.

## Non-goals

- an ORC-specific fork of Hunch record semantics;
- transcript mining or hidden-reasoning ingestion;
- automatic policy activation or permission expansion;
- a global organizational data warehouse;
- Hunch-owned workflow, runtime health, deployment or business-outcome observation;
- Hunch Memory-side cross-store joins; or
- mandatory model training.
