# Hunch roadmap

Updated 2026-09-09.

Hunch is moving from repository-only engineering memory toward a broader deterministic state layer for organizations that use many probabilistic agents.

The current product remains **Hunch**. Naming is deliberately deferred until the contract and pilot are proven.

> **Agents are probabilistic. Organizations need deterministic state. Hunch is the state layer between them.**

This file is the public execution view. Historical releases and completed implementation details remain in the changelog and dedicated design documents. `hunch now` remains the detailed live decision ledger for the repository.

Read [Deterministic organizational state](docs/deterministic-state.md) for the current architecture.

## Status — 2026-09-08

The category is named **Deterministic State** (blog post in five locales, homepage band).
Gate status against the plan below:

| Gate | Status | Evidence |
| --- | --- | --- |
| 0 — baseline | done for one user; second user not yet instrumented | one week of Sofia: 2 of 3 replies without an observable source; repeated re-summaries of unchanged evidence |
| 1 — additive state contracts | done, 1.25.0 | `nuryel.state/1`: read / write / subscribe, five facets, invariants as tests; `records` verb added in 1.27.0 |
| 2 — fold the state service | done, 1.26.0–1.27.0 | `hunch serve`: served partitions, bearer → principal, cross-process write lock, typed client; Hunch Memory marked folded; `hunch mcp --root` for stdio agents |
| 3 — integrate Sofia | done except UI provenance | receipts, commitments, cited summaries written through the contract; drawer read before summarizing; reuse 50 s → 4.5 s; deterministic action gate preserved; receipts not yet shown in Sofia's UI |
| 4 — second heterogeneous agent | partial; many-agents proven on an emulated organization | Claude Code, opened on a code repository, read the drawer and wrote a commitment through the contract. Three emulated Sofias over ten clinics and a generated year (mail, chat, CRM), one organization drawer: 96 cited summaries, 24 verified receipts, 24 commitments with same-subject duplicates replayed, ledger contiguous, zero contradictions (1.28.0: union read, supersede target must be open, subjects keyed by CRM site). The cross-domain incident → engineering decision → change proof → closure chain is now a contract feature run end to end through the binding by three principals (receipt `rests_on` the decision + change proof, commitment `closed_by` the receipt, `depends_on` answers the chain, `records` resolves the decision grants-first); not yet driven by a live Sofia and a live engineering agent |
| 5 — re-measure, kill criterion | pending | after-measurement runs the week of 2026-09-08 with the second agent writing |
| 6 — naming | deferred | on purpose; a product name is not a category |

Defects found by the first live writers and fixed the same day (1.26.1–1.28.0): served writes
not committing, MCP roots re-homing a served partition, reads without record bodies, a stable
idempotency key with a varying payload, an action kind in the CRM's casing refused by the
contract, two racing writers leaving two current summaries for one subject. Each became a test,
a refusal message, or a verb.

## What stays true

The new direction does not discard the engine that already exists.

Hunch keeps:

- git-native, reviewable and reversible repository state in `.hunch/`;
- decisions, corrections, findings, constraints and bug lineage;
- exact provenance, currentness and contradiction handling;
- validated, role-shaped context delivery with content-addressed receipts;
- Project DNA and Project Match;
- Engineering Landscape resource/relationship primitives;
- Native Change Proof;
- deterministic conformance, Change Gate and Constitution policy primitives;
- public/private overlays and local-first repository use;
- MCP, CLI and library surfaces that remain useful without a hosted service.

Repository `.hunch/` remains authoritative for repository-scoped state. New organization/team/user scopes must extend that model rather than replace it with a second database authority.

## What changed

The previous product framing around a separate **Hunch / Hunch Memory / ORC trio** is retired as the future architecture.

Historical work across those repositories remains valid evidence and implementation material, but the target is now:

```text
one product
one deterministic state graph
one versioned state contract
many independent agents/orchestrators
```

The old ownership model in which ORC was the live cross-repository product and Hunch Memory was a sibling transport product is no longer the roadmap boundary.

Going forward:

- agents/orchestrators own live source access, model execution, discovery and source-specific actions;
- Hunch owns durable state that should remain useful after those processes stop;
- transport/isolation/idempotency/durability code from Hunch Memory is folded into the state product where it fits;
- ORC is not a required product dependency for the new architecture;
- no agent is privileged: Sofia, Codex, Claude Code and future agents should all speak the same state contract.

## Active priority — deterministic organizational state

The current priority is to prove that agents behave better when they act from shared deterministic state instead of independently reconstructing organizational reality each session.

The working future contract name is `nuryel.state/1`; it is **not frozen yet**.

Planned state facets:

```text
decided
  what decision is currently in force

done
  what actually happened

committed
  what someone or some agent has committed to do

changed
  what code/system state changed and the proof for it

entity
  durable identity for customer, incident, repository, service, etc.

relationship
  durable relationship between entities

DNA
  repository / user / team / organization working conventions

current-with-dependencies
  derived state plus exact evidence/version dependencies
```

Planned contract verbs:

```text
read       current authorized state + delivery receipt
write      provenance + idempotency key -> durability result
subscribe  changes to state the principal is authorized to hold
```

HTTP, MCP, CLI and typed clients must be bindings of the same schema, not separate integration models.

## Boundary — Hunch is state, not a connector gateway

Hunch must not become a proxy in the live request path.

Wrong:

```text
agent -> Hunch -> Gmail / CRM / GitHub / WhatsApp
```

Target:

```text
                     Hunch state
                      ↑      ↓
agent -> local policy/action gate -> connector -> source system
```

Agents keep responsibility for:

- connector authentication;
- bounded live reads;
- source discovery;
- in-flight request deduplication;
- model/prompt execution;
- human approval UX;
- source-specific mutations;
- write verification and reconciliation.

Hunch keeps state **about** the work with provenance pointers. It does not mirror raw Gmail, CRM, WhatsApp or GitHub content merely to become a universal cache.

A practical ownership test:

> If the fact should remain useful when every agent and connector process is stopped, Hunch may own it. If it changes simply because a process connects, authenticates or becomes temporarily unavailable, it belongs to the live layer.

## Pilot — Sofia becomes the first state-backed agent

Sofia is the first real-world pilot because it already has concrete cross-system work state over CRM, Gmail and WhatsApp.

Existing Sofia concepts map directly:

| Sofia | Hunch state |
| --- | --- |
| approved external action | action receipt / `done` |
| follow-up | `committed` |
| customer dossier | `entity` |
| CRM event / Gmail thread / WhatsApp chat | external entity + provenance pointer |
| source links | `relationship` |
| user rules | user DNA |
| cited summary | `current-with-dependencies` |
| source fingerprint/version | dependency/currentness evidence |
| uncertain mutation | unresolved receipt, never automatic retry |

### Gate 0 — baseline before architecture code

Instrument at least two Sofia users working on overlapping customers/work.

Measure:

- facts or decisions re-derived across sessions;
- contradictions between the two users' Sofias;
- stale answers after a real CRM/mail/source change;
- source reads and model calls required to reconstruct known state;
- time from one verified action to another agent becoming aware of it.

Do not move the goalposts after the state layer lands.

### Gate 1 — freeze additive state contracts

Add, without breaking repository state:

- action receipt;
- commitment;
- external entity and relationship;
- credential-free provenance pointer;
- user/team DNA beside Project DNA;
- derived state with exact dependencies/invalidation;
- system-of-record query: **what is true now, what does it rest on, and what would invalidate it?**

The contract must preserve optimistic versions/supersession. Shared facts are not last-writer-wins prose.

### Gate 2 — fold the state service into the product

Harvest the proven transport pieces rather than maintaining a sibling memory product:

- authenticated principal -> authorized scope resolution;
- organization/team/user/repository partitions;
- idempotency journal;
- push/durability behavior;
- placement/isolation checks;
- subscribe/change notification surface.

The served graph is the authorized union of git-native partitions. A database may be a projection or write-ahead optimization later; it must not silently become a second source of truth.

### Gate 3 — integrate Sofia

Sofia should:

1. keep CRM/Gmail/WhatsApp source access in Sofia;
2. write verified actions/follow-ups/entities/relationships to Hunch state;
3. read held state before re-deriving organizational facts from source histories;
4. show state provenance/receipts in the UI;
5. preserve its deterministic action gate for real-world writes;
6. treat Hunch state as evidence, not permission granted by model text.

Local Sofia SQLite may remain a UI/cache store during the pilot. It must not become a competing organizational authority.

### Gate 4 — second heterogeneous agent

Add a second, different writer/reader through the same contract — preferably Codex or Claude Code through MCP or a typed binding.

The demo must cross domains:

```text
Sofia records customer incident + commitment
              ↓
engineering agent reads the incident state
              ↓
engineering decision + change proof + shipped receipt
              ↓
Sofia sees verified completion
              ↓
customer follow-up / closure
              ↓
new agent reads the whole chain later
```

Two copies of Sofia are useful for permission testing, but they are not enough to prove orchestrator neutrality.

### Gate 5 — re-measure and apply the kill criterion

The mechanism being tested is not "does storage work?" It is:

> **When agents receive deterministic state before answering or acting, do they actually act from it rather than rebuilding a different reality?**

Accept the broad system-of-record thesis only if the incident -> decision -> change -> closure chain is reproduced by the second agent without contradictory re-derivation.

If agents receive the state but continue to re-derive/contradict it, narrow the product toward enforcement and delivery hooks before expanding the hosted platform.

Target for one complete pilot cycle: **2026-12-31**. A delay in integration is a capacity finding, not by itself a verdict on the thesis.

### Gate 6 — naming decision

Only after the contract and pilot have evidence:

- decide whether the hosted product becomes **Nuryel** while Hunch remains the engine/CLI;
- or keep the Hunch name for the full product.

Do not make rename work the deliverable.

## Security and organizational deployment

The state layer and agent action authority are separate.

For a Sofia-style agent:

```text
agent reasoning
    ↓
held deterministic state
    ↓
proposal
    ↓
deterministic Action Gate
    ↓
connector write
    ↓
readback verification
    ↓
state receipt
```

The state graph must support provenance and policy checks, but it must not silently grant connector permissions.

Organization/team/user scope work must include:

- token -> principal -> authorized partitions;
- per-record visibility where a scope contains mixed sensitivity;
- no caller-selected filesystem paths;
- idempotent writes and optimistic conflict handling;
- auditable supersession;
- source references that do not leak credentials/content;
- an independent kill/suspension path in the agent control plane for consequential automation.

## Existing engineering program status

### Project DNA

The initial repository Project DNA production path is shipped: deterministic exact-revision discovery, authorized bounded PR/review evidence, match/delta surfaces, bounded delivery and usefulness observations.

Project DNA remains a core engine primitive. The state roadmap extends the concept upward to user/team/organization DNA; it does not replace repository DNA.

See [Project DNA](docs/project-dna.md) and [Project DNA Engine](docs/project-dna-engine.md).

### Engineering Landscape

The repository-local resource/relationship primitives and deterministic declaration discovery remain useful and shipped foundations.

The old statement that ORC alone owns cross-repository traversal is retired as product architecture. A live agent may follow authorized provenance pointers; Hunch stores durable relationships and serves only state the principal may see.

See [Engineering Landscape Graph](docs/engineering-landscape.md).

### Native Change Proof / proof-carrying changes

`hunch.change-proof/1` remains the repository-native exact-change proof. It grants no merge/deploy/execution authority.

Previous ORC Change Passport work remains useful evidence of how a different orchestrator can consume Hunch proof. The new roadmap does not require ORC to continue as the assembly product.

See [Native Change Proof](docs/change-proof.md).

### Constitution / deterministic policy

The deterministic gate remains the enforcement edge. Trusted policies must be provenance-backed, inspectable and human-authorized; probabilistic agent output cannot silently become blocking authority.

The organizational-state pilot should reuse this edge when state-backed policy needs to refuse a known-invalid action, while keeping connector permissions in the agent/action-control layer.

## Deliberate non-goals for the pilot

- central source-query computation cache;
- Hunch-managed Gmail/CRM/WhatsApp/GitHub connectors;
- Postgres as authoritative state beside git-native partitions;
- embedding a general orchestrator inside Hunch;
- automatic policy activation from model output;
- raw transcript or private message warehousing;
- broad public network effects as the growth thesis;
- rename-first work.

## Scale assumption

For the first organizational pilot, git-native writes are expected to be adequate for tens of users writing receipts, commitments, decisions and relationships.

High-frequency event streams may later require batching or a write-ahead layer. That optimization is intentionally deferred until real measurements demand it, and it must not erode the git-native source-of-truth property.

## Success condition

The next version of the product is not justified because "AI memory is useful." It is justified only if heterogeneous agents can share one deterministic organizational reality and stop repeatedly reconstructing contradictory state.

The Sofia pilot is the shortest path to finding out.
