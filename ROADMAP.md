# Hunch roadmap

Updated 2026-09-12.

Hunch is moving from repository-only engineering memory toward a broader deterministic state layer for organizations that use many probabilistic agents.

The current product remains **Hunch**. Naming is deliberately deferred until the contract and pilot are proven.

> **Agents are probabilistic. Organizations need deterministic state. Hunch is the state layer between them.**

This file is the public execution view. Historical releases and completed implementation details remain in the changelog and dedicated design documents. `hunch now` remains the detailed live decision ledger for the repository.

Read [Deterministic organizational state](docs/deterministic-state.md) for the current architecture.

## Documents

Every planning, contract and program document, and what it is for. A document not listed here is
not a plan.

| Document | Role |
| --- | --- |
| this file | public execution view: status, gates, landscape items, programs |
| [CHANGELOG.md](CHANGELOG.md) | what shipped, per version; authoritative for "shipped" |
| [Deterministic organizational state](docs/deterministic-state.md) | the architecture, boundary, pilot sequence and kill criterion |
| [The state contract](docs/nuryel-state-contract.md) | `nuryel.state/1`: facets, verbs, invariants, served partitions, replay; indexes the capability notes ([observations](docs/agent-observations.md), [links](docs/observation-links.md), [review](docs/observation-review.md), [pages](docs/observation-pages.md), [ledger read reuse](docs/ledger-read-reuse.md)) |
| [Task contribution reports](docs/task-reports.md) | how the 1.32 reports work; [qualification record](docs/task-report-qualification.md); [release plan](docs/next-release-memory-impact.md) (historical) |
| [Autonomous development](docs/autonomous-development.md) | the red team of 2026-09-09, the promotion ladder, what has been configured since; [autonomy ladder](docs/autonomy-ladder.md) for the in-code ladders |
| [Competitive landscape](docs/competitive-landscape.md) | dated snapshots, append-only |
| [Engineering Landscape](docs/engineering-landscape.md), [Project DNA](docs/project-dna.md), [Project DNA Engine](docs/project-dna-engine.md), [Native change proof](docs/change-proof.md), [Outcome experience protocol](docs/outcome-experience-protocol.md) | shipped engine primitives the state layer builds on |
| [Outreach pipeline](docs/outreach-pipeline.md), [MCP registry](docs/mcp-registry.md) | founder-led pilot recruitment; per-release registry publish |
| Sofia repository: `docs/sofia-baseline.md`, `docs/sofia-state.md` | the pilot's baseline ledger and Sofia's use of the contract |

A private overlay holds the plan of record, the Constitution dossier and product direction; this
file is its public view and lags it by design.

## Next release — see what Hunch contributed

**Next implementation priority, requested 2026-09-11:** make Hunch's contribution visible to repository users in their normal agent workflow. Ship a clear connection check, task-linked memory delivery, a concise contribution card, and an inspectable local evidence view. The defining demonstration is a lesson recorded in one task, received by a fresh agent in the next, and linked to an observed action and verification result without the developer repeating it.

The release must distinguish delivered context, agent-reported application, verified checks, and unsupported attribution. Production acceptance requires the completion card to appear during normal work without the user asking about Hunch or running a report command, plus a real-host rehearsal of the original user's setup. Hunch remains provider- and harness-agnostic: Kimi, Codex, Claude, CCC, and Watchtower are consumers of one task/evidence contract, not required product-specific forks. A harness can own task lifecycle and deterministic presentation; standalone integrations receive the same data. Advertise automatic display only where it has been verified. Shipped in 1.32.0 (2026-09-11); hardened by dogfooding in 1.32.1 and 1.32.2 (2026-09-12): `hunch task verify --timeout`, a bounded MCP report summary, hook runtime evidence in `integrations check`, the first-delivery `Hunch recalled:` line, and `drift --fail-on` in the release gate. Usage: [Task contribution reports](docs/task-reports.md).

1.32.0 ships task-scoped reports, command verification, rule-supported applications, local HTML, and managed completion instructions. [Development qualification](docs/task-report-qualification.md) records the flow in real hosts, the original Claude lifecycle failure and its latest-host regression, and the acceptance items still open after publication: interactive-terminal display, the two repository-user acceptance sessions (not the two Sofia users of Gate 0), a live task showing a rule-supported application, and the MCP registry publish for 1.32.x. The shared harness contract and verified capability boundaries are the shipped surface; individual external integrations are not assumed qualified. The [release execution plan](docs/next-release-memory-impact.md) remains the reference for the experience, evidence rules, and remaining gates. Existing live-pilot measurement continues; the organizational-state direction and gates below remain in force.

## Status — 2026-09-12

The category is named **Deterministic State** (blog post in five locales, homepage band).
Gate status against the plan below:

| Gate | Status | Evidence |
| --- | --- | --- |
| 0 — baseline | done for one user; the second user needs a second participant and a shared task (the CRM credential was repaired on 2026-09-11) | one week of Sofia: 2 of 3 replies without an observable source; repeated re-summaries of unchanged evidence |
| 1 — additive state contracts | done, 1.25.0 | `nuryel.state/1`: read / write / subscribe, five facets, invariants as tests; `records` verb added in 1.27.0; the `changed` facet has its first writer (a current summary written back `stale` with an external cause is an `invalidated` change naming the pointer that moved) |
| 2 — fold the state service | done, 1.26.0–1.27.0 | `hunch serve`: served partitions, bearer → principal, cross-process write lock, typed client; Hunch Memory marked folded; `hunch mcp --root` for stdio agents |
| 3 — integrate Sofia | done in emulation and live for one user | receipts, commitments, cited summaries written through the contract; the drawer read before summarizing AND before answering a status question in chat (held state first, a reply that needed no source read says so under the read's receipt — the baseline's unsourced-reply number turned around: 12 of 12 answered from held state in the emulation; live on 2026-09-12 a chat read of an event becomes held state through Sofia's refresh worker and the next status questions answer from the drawer under a receipt, 0 of 3 unsourced, Sofia PR #14); the summary rests on the drawer's receipts and fulfilled commitments as record dependencies; reuse 50 s → 4.5 s; deterministic action gate preserved; state-layer evidence shown in Sofia's UI as verified records |
| 4 — second heterogeneous agent | live chain run twice on 2026-09-12, the second time by a real Claude Code MCP session; many-agents proven on an emulated organization | Claude Code, opened on a code repository, read the drawer and wrote a commitment through the contract. Three emulated Sofias over ten clinics and a generated year (mail, chat, CRM), one organization drawer: 96 cited summaries, 24 verified receipts, 24 commitments with same-subject duplicates replayed, ledger contiguous, zero contradictions (1.28.0: union read, supersede target must be open, subjects keyed by CRM site). The cross-domain incident → engineering decision → change proof → closure chain is now a contract feature run end to end through the binding by three principals (receipt `rests_on` the decision + change proof, commitment `closed_by` the receipt, `depends_on` answers the chain, `records` resolves the decision grants-first); run on the agent farm every test run (3 sofias raise incidents, the engineer closes each through the chain, every sofia sees the closure, the orc verifies every link, 0 contradictions) and on the Sofia emulation with REAL Sofia code (3 Sofias over the 10-clinic year: 3 escalations closed by the engineer, 5 of 5 closures seen by the Sofias from the drawer alone — Sofia's summary now rests on the drawer's receipts and fulfilled commitments as record dependencies — 7 links per closure verified by the ORC, the receipt resting on a real `hunch prove` proof that binds the decision hash for hash, 0 contradictions); driven live on 2026-09-12 with real material: Sofia's own capture incident and the escalation engineering owed, the engineering decision, a real `hunch prove` change proof of the fix (Sofia PR #15) and a verified `shipped` receipt resting on all three, the escalation closed by that receipt, and two Sofia instances reporting the closure from the drawer alone, unprompted; the partition replays hash for hash. Run a second time the same day with the engineering side as a real headless Claude Code session over `hunch mcp --root` on the partition (principal claude@gate5): it read the escalation in force, recorded the decision, wrote the shipped receipt resting on decision, proof and escalation, and closed the escalation, in six turns with no refusals; the fix was Sofia PR #16 with its own change proof; Sofia then listed both closures from held state. One operator still drove both sides |
| 5 — re-measure, kill criterion | measured live for one user, scripted, both legs (status from held state; approval → receipt → held state); two-user week not run | live on 2026-09-12, real CRM, Claude as planner, isolated partition: before the fix 2 of 3 status replies came from conversation history (the baseline number reproduced); after it, one CRM read then 2 of 2 from held state under the read receipt, 0 of 3 unsourced, worker failures 0. The approval → receipt → held-state leg was measured live the same day: a human-approved comment became a verified receipt, the snapshot re-rested on it, 3 of 3 status questions answered from held state naming the verified action, and a second Sofia principal on the same partition saw it within two and a half minutes (the emulation's 12 of 12 has its live counterpart). The live cross-domain chain ran the same day (Gate 4 row). Not yet run: the two-user week (needs a second participant and a shared task). The emulation's numbers — closures seen by the agent that was not told (5 of 5), status replies from held state (12 of 12) — are a different population from the live ones and are never quoted as them. The planned "week of 2026-09-08" was missed |
| 6 — naming | deferred | on purpose; a product name is not a category. The contract and the MCP tools already carry the name (`nuryel.state/1`, `nuryel_*`); the product stays Hunch |

Defects found by the first live writers and fixed the same day (1.26.1–1.28.0): served writes
not committing, MCP roots re-homing a served partition, reads without record bodies, a stable
idempotency key with a varying payload, an action kind in the CRM's casing refused by the
contract, two racing writers leaving two current summaries for one subject. Each became a test,
a refusal message, or a verb.

## Landscape — 2026-09-09: competing for the deterministic state layer

Hunch competes for the **deterministic state layer** position. It is not alone on the phrase:
Neotoma (MIT, single author) has described itself as "a deterministic state layer for AI agents"
since March 2026, and the dated comparison lives in
[docs/competitive-landscape.md](docs/competitive-landscape.md). The angle Hunch takes is the
organizational one, which every peer lists as future or does not attempt:

- partitions per organization, team, person and repository, with a key per agent that decides
  visibility before lookup;
- a second contradicting live record refused at write time (one live decision per topic, supersede
  target must still be open), not diverging writes repaired by a later merge;
- receipts for verified external actions and commitments with due dates as first-class facts;
- git-tracked JSON as the source of truth, so every fact is reviewable, revertable and mergeable;
- the engineering-memory and code-conformance spoke, which no state-layer peer has.

Material from the same comparison that is worth building here, kept as roadmap items rather than
copied claims:

| Item | Why | Status |
| --- | --- | --- |
| Subject identity by external reference | two agents over one CRM record, thread or chat must land on one subject; 1.28.0 keyed subjects by CRM site | done, 1.30.0 — `externalKey` / `subjectOfRef` frozen in the contract; one active entity per external key per partition (`409`, incumbent named), a subject written as an entity's key refused with the entity id (`422`), reads resolve one explicit hop (`state.entity-identity`) |
| Audited entity merge and split | the cases an external reference cannot settle; recorded as ledger events with provenance, never silent rewrites | done, 1.30.0 — `merged_into` on a retired entity, `retired` ledger event, reads resolve old id and keys to the survivor (chains, cycle-safe), new state refused under the old name; split is the explicit reverse |
| Replay determinism as a check | fold a partition's ledger into the state it implies and compare it hash for hash (canonical bytes) to the stored records; publish the command, not the claim | done, 1.30.0 — `hunch serve replay`, typed divergences, exit 1; every farm run replays every partition (`state.replay-determinism`) |
| Field-level provenance on derived state | a summary today cites its sources as a whole; per-field citation lets a reader see which source a sentence rests on | later, after the second-user measurement |
| Correction outranks later agent writes | prove, with a test, that a human correction on a record is not overridden by a subsequent agent write on the same field; a peer's reducer was observed to lose this | done, 1.30.0 — invariant `human-correction-outranks-agent-writes`, enforced at write time (`409 conflict`, `human-confirmed incumbent`), tested in `test/state-replay.test.ts`; per record, not per field (per-field provenance stays later) |
| Attested principal identity | bearer keys today; key-thumbprint or hardware-attested principals for the organization partition when a second person holds a key | after Gate 5 |
| Read-only operator view | a page over a served partition: current records, ledger, who wrote what; no editing | after Gate 5 |
| Typed clients beyond TypeScript | a Python client for the three verbs, generated from the contract | when a non-TypeScript orchestrator asks for it |

Deliberately not borrowed: file ingestion and copies of external content. Hunch holds pointers and
fingerprints to the systems of record and never fetches into the drawer (see Boundary below).

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

The contract name is `nuryel.state/1`. It is **frozen as code** (`src/core/stateContract.ts`, shipped 1.25.0, bound to the store, MCP and `hunch serve`) and still **proposed** as a public commitment: additive changes only until the pilot number exists. See [the contract](docs/nuryel-state-contract.md).

State facets (`receipts`, `commitments`, `derived`, `entities`, `relationships` are registered store kinds; `decided`, `DNA` and `changed` ride existing records):

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

Contract verbs:

```text
read       current authorized state + delivery receipt
write      provenance + idempotency key -> durability result
subscribe  changes to state the principal is authorized to hold
records    a subject's records, grants-first (added 1.27.0)
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

Measured so far: see the status table above (one user, live, 0 of 3 unsourced after one read). Still to measure: the two-user week, the approval → receipt leg, the live cross-domain chain.

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

Shipped and not otherwise listed here: the preregistered experiment runner (`hunch experiment validate|prepare|create|run|…`, reports carry `authority: none`), the G2/G3 readiness reports (`hunch constitution g2|g3`, `hunch_constitution_g2_readiness` / `g3_readiness`), and the clean-install rehearsal. Gate status: G2 and G3 are signed, and G3 is advisory operation only — the readiness report still says `g3_passed: false`, no policy holds blocking authority, and G4/G5 (external pilots of blocking policy) are not approved. The promotion rules are written down in [the autonomy ladder](docs/autonomy-ladder.md).

The deterministic gate remains the enforcement edge. Trusted policies must be provenance-backed, inspectable and human-authorized; probabilistic agent output cannot silently become blocking authority.

The organizational-state pilot should reuse this edge when state-backed policy needs to refuse a known-invalid action, while keeping connector permissions in the agent/action-control layer.

## Autonomous development

The development loop itself is promoted by the same rule as a policy: rung by rung, on measured numbers, never switched on. The readiness checklist, the red-team findings of 2026-09-09 and the promotion table are in [Autonomous development](docs/autonomous-development.md); since then the required checks and environment reviewers are configured, `drift --fail-on` gates releases, and memory hygiene is a standing agent obligation (`con_039cee7367`). The loop stands at rung 1: the agent authors, a human merges. The items no agent can do are Gate 5's two-user week (a second participant) and the one approved CRM comment for the approval leg; they are the critical path.

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
