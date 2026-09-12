# Outcome experience protocol

Updated 2026-09-07.

This document defines Hunch's provider-neutral boundary for turning independently evidenced agent/runtime outcomes into bounded usefulness observations and reviewable knowledge candidates.

The protocol was originally implemented with ORC as the external producer and Hunch Memory as transport. That integration remains historical evidence. The forward architecture is agent-neutral: any authorized agent/orchestrator may emit compatible outcome evidence through the one Hunch state/delivery contract.

Hunch remains useful without any specific orchestrator, and this protocol does not make Hunch a workflow engine, raw telemetry warehouse or model-training service.

Read [Deterministic organizational state](deterministic-state.md) for the current product topology. The 1.32 [task contribution reports](task-reports.md) build on this boundary: a delivery, an agent-reported application, a rule verdict and an observed command are the evidence grades the report keeps apart.

## Purpose

A live agent/runtime can bind execution to an objective, authority envelope, exact context, verification and observed outcome. Hunch can deliver reviewed knowledge and deterministic conformance.

The outcome protocol lets independently evidenced results improve later Hunch retrieval and create reviewable candidates without turning a successful run, transcript or reward into truth.

```text
Hunch delivery/state receipt
  -> authorized external execution
  -> independent outcome evidence
  -> provider-neutral ExperienceEpisode/usefulness observation
  -> Hunch validates identity, evidence, eligibility and retention
  -> findings/candidates/usefulness state
  -> normal Hunch review/proof lifecycle
  -> later validated delivery/state
```

## Ownership boundary

| Capability | Live agent/runtime owns | Hunch owns |
| --- | --- | --- |
| Objective/outcome | objective contract, observation window and terminal result | prior durable state/knowledge that informs or challenges it |
| Execution | planning, tools, side effects, retries/recovery and runtime policy | no source-system execution authority |
| Evidence | exact execution/attempt lineage and independent outcome evidence | state provenance/currentness, delivery receipts and conformance evidence |
| Feedback | derivation of bounded evidence-bearing outcome signals | validation, storage and controlled retrieval use of those signals |
| Knowledge | proposals/candidates only | findings and reviewed promotion into decisions/constraints/policies |
| Adaptation | routing/execution behavior inside runtime permission | retrieval/ranking changes and reviewed deterministic semantics |

No runtime writes an active Hunch decision, constraint or policy merely because an execution succeeded.

Hunch never changes a runtime's connector permission, agent selection or production outcome through an outcome observation.

## Accepted episode envelope

Hunch accepts only versioned provider-neutral outcome evidence whose conclusions resolve to explicit evidence.

A useful episode/observation may include:

```text
episode id and schema version
principal / authorized scope
agent/runtime request or attempt identity
objective/outcome contract version/hash when available
exact starting and terminal revisions/state references
optional exact hunch.change-identity/1 for code changes
Hunch graph/state revision and native delivery receipt
exact delivered record/state IDs
resolved strategy/runtime/policy references
independent verification and outcome evidence references
result: pass | fail | uncertain | abandoned | rolled_back
bounded efficiency/intervention facts
per-record usefulness observations
privacy, retention and promotion eligibility
```

Transcript text, hidden reasoning and an executor's self-grade are never required evidence.

Unknown or unsupported conclusions remain `unknown`; absence of evidence is not converted into success.

## Receipt-bound usefulness

Per-record feedback is eligible only when the observation names the exact Hunch delivery receipt and the record/state identity occurred in that receipt.

Initial signals remain:

- `used` — observable execution/verification evidence depended on the record;
- `prevented` — evidence shows the record stopped a known-invalid path before protected effect;
- `near_miss` — an invalid path was attempted but caught before outcome damage;
- `contradicted` — outcome evidence conflicts with delivered state;
- `stale` — exact currentness evidence invalidates applicability;
- `unused` — the record was delivered but no supported use is observable;
- `unknown` — attribution cannot be established.

`unused` is not negative authority, and correlation is not causation.

Signals may affect retrieval only through a versioned/replayable policy. They never silently demote blocking authority or promote a candidate into trusted knowledge.

## Findings and knowledge promotion

Contradiction, staleness, recurrent failure and transferable procedure evidence enter Hunch as findings/candidates with exact evidence references.

Promotion follows the normal lifecycle:

```text
outcome observation
 -> finding/candidate
 -> deduplication + contradiction/currentness checks
 -> human review / deterministic proof where applicable
 -> accepted decision/constraint/policy or rejection/supersession
```

A single successful episode is never a universal rule.

Strong procedural promotion requires multiple comparable outcomes or another declared causal design, freshness/currentness evidence and held-out/replay support appropriate to the claim.

## Idempotency and conflicts

- Re-ingestion of the same observation identity/content is idempotent.
- The same identity with different content fails visibly; it is never last-write-wins.
- Usefulness entries bind episode, receipt and record/state identity.
- A newer episode does not mutate historical evidence; correction uses supersession/new state.
- Retention/deletion changes propagate to derived projections where the contract requires them.

These properties become even more important when many independent agents write to shared organizational state.

## Isolation and privacy

- Principal/scope comes from authenticated authorization, never episode prose.
- Cross-scope aggregation uses only explicitly eligible sanitized fields.
- Secrets, raw tool inputs, transcripts and hidden reasoning are excluded.
- Evidence references must remain authorized and independently resolvable.
- Source-system credentials never become outcome state.
- An agent may reference an external CRM/mail/chat/repository entity with a credential-free provenance pointer; Hunch does not fetch the source on its behalf.
- Cross-resource traversal is authorized by the live agent and state-service visibility, not by an ORC-specific rule.

## State-service relationship

Under the deterministic-state roadmap, outcome observations are natural `done`/`changed` state and may also update dependency/currentness information.

Example:

```text
Sofia delivery receipt
  -> approved CRM reply attempted
  -> CRM readback verifies exact comment
  -> action receipt written as done
  -> customer commitment remains open or is closed

engineering agent delivery receipt
  -> exact repository change
  -> hunch.change-proof/1
  -> deployed result independently verified
  -> changed/done receipt linked to customer incident
```

The shared state graph can connect those outcomes without pretending either source system lives inside Hunch.

## Existing Hunch contracts

The shipped repository-side primitives remain valid:

- `hunch.usefulness-observation/1` — receipt/record-bound deterministic usefulness identity;
- `hunch.change-identity/1` — exact tree-delta identity for code changes;
- `hunch.change-proof/1` — sealed exact-change evidence artifact;
- native delivery receipts and graph/source revision identity.

The future organizational state contract should reference or embed these as stable sub-contracts rather than replacing them with prose-only state.

## Historical ORC / Hunch Memory implementation

The original implementation proved several useful properties:

- an external orchestrator could derive observations only from eligible terminal outcomes;
- observations remained bound to exact Hunch receipts/records;
- transport could validate and idempotently retain observations;
- privacy-safe aggregate coverage could be produced without exposing raw identifiers;
- `contradicted`/`stale` could create advisory findings without changing trusted authority;
- missing connections, unbound stores and delivery failures remained explicit states.

Those are retained as evidence and implementation material.

They no longer imply that ORC owns the future live architecture or that a separate Hunch Memory product owns future state transport.

## Non-goals

- an orchestrator-specific fork of Hunch semantics;
- transcript mining or hidden-reasoning ingestion;
- automatic policy activation or permission expansion;
- a raw organizational data warehouse;
- Hunch-owned workflow/runtime-health/business-outcome observation;
- connector execution through Hunch;
- mandatory model training;
- requiring ORC or a separate Hunch Memory service for outcome evidence.
