# Deterministic organizational state

Status: **engineering memory and the served state layer ship today, including the read-only shared state view in Hunch 1.33.0; wider organizational impact remains a pilot.** Reviewed 2026-09-14. The [roadmap](../ROADMAP.md) separates shipped capabilities from the remaining Sofia pilot gates.

**A shared record for AI agents: what was decided, what happened, and what still needs doing.** Hunch keeps decisions, rules, action records and commitments with their sources, so another agent can check existing work before starting again.

Engineering memory explains the reasons behind code. The served state layer extends the same approach to repository, user, team and organization records. Both are available today. The broader vision is for agents working across different tools to rely on the same current record.

The thesis is simple:

> **Agents are probabilistic. Organizations need deterministic state. Hunch is the state layer between them.**

Hunch calls this **deterministic state**: defined rules check record identity, conflicting current decisions, access, repeated writes and whether supporting evidence has changed. These checks do not establish that every statement an agent submits is true. Records retain their source and verification status.

The engine is local-first and keeps its durable records in Git-backed files. You can use repository memory directly or run `hunch serve` for authorized partitions. Hunch does not operate a managed connector service; agents still use their own CRM, email, chat and code tools.

## Start with the scope you need

For a coding project, run `hunch init` in its Git repository and connect your assistant. To try a separate state partition locally:

```sh
hunch serve init --config ./hunch-serve.json --partition user:demo --root ./demo-state --principal assistant@demo
hunch serve --config ./hunch-serve.json
```

Initialization prints the agent token once; keep it private. The server binds to `127.0.0.1`. Use a Git repository for the partition when you need committed history; write results distinguish local, committed and pushed records. The [state contract](nuryel-state-contract.md#served-partitions-hunch-serve) explains authenticated HTTP access, MCP and the typed client. The CLI manages the service; [hunch state](state-cli.md) reads and writes through the same HTTP contract.

### Shared state view

Shipped in Hunch 1.33.0 as a read-only browser client. It displays stored state and retained
activity; it does not independently verify claims or provide a complete historical inventory.

With the server running, open `http://127.0.0.1:7474/operator` (use your configured port). Connect with a server-issued token and choose an authorized workspace. The page keeps the token in this tab’s memory; reloading or disconnecting clears it.

Enter an exact subject, such as `customer:c1`, or a decision topic. **Show state** displays current records, open commitments and rules, completed work, and a separate section for observations whose currentness is unverified. **Sources & record details** shows the author or source, evidence, dependencies and stored record. **Inspect record ID** also opens failed, cancelled or stale records that a current-subject view leaves out.

Recent activity shows up to 50 retained changes and lets you open their subjects or inspect their latest stored records. It is not a full inventory or an archive of every revision: earlier history may have been compacted. Observation pages are bound to a snapshot; if records change between pages, restart the subject lookup. **Refresh** retrieves newer state; this page does not continuously poll.

The view is read-only and uses the existing authenticated state API. The token retains its server permissions. Source references are displayed without fetching external systems, and a record’s status is not an independent check of its claims. No hosted account or separate database is needed.

Naming is deliberately not the current deliverable. `Hunch` remains the product name until the state contract and Sofia pilot are validated. A possible hosted-platform name, **Nuryel**, is deferred (roadmap Gate 6); the contract name `nuryel.state/1` and the `nuryel_*` MCP tools already ship under it.

## One product, one graph, one contract

The target architecture replaces the old Hunch / Hunch Memory / ORC product trio with one state product.

```text
repository .hunch/ partitions
organization state partition
team state partitions
user state partitions
          │
          ▼
   one Hunch state graph
          │
          ▼
 one versioned state contract
   HTTP / MCP / CLI / typed clients
          │
    ┌─────┴───────────────┐
    ▼                     ▼
 Sofia / future agents    coding agents / orchestrators
    │                     │
    ▼                     ▼
 CRM / Gmail / WA         Git / CI / repositories
```

Repository `.hunch/` remains authoritative for repository-scoped state. Organization, team and user scopes are additional git-native partitions served by the same product. A token resolves to a principal and authorized scopes; callers never choose arbitrary filesystem paths.

The served graph is the authorized union of those partitions, not a copy in a separate database. Derived indexes may exist for performance, but git-native state remains the durable authority.

## The state contract

The `nuryel.state/1` contract is frozen as code since 1.25.0 (`src/core/stateContract.ts`; specified in [the contract document](nuryel-state-contract.md)) and intentionally small. It exposes state facets rather than connector-specific APIs.

Initial facets:

- `decided` — a decision currently in force, with supersession and provenance;
- `done` — an action record, including its outcome and verification status;
- `committed` — a commitment with owner, due state and lifecycle;
- `changed` — a proven state/code change and its evidence;
- `entity` — a durable non-code or code entity identity;
- `relationship` — a durable relationship between entities;
- `DNA` — working conventions; repository Project DNA ships, while broader personal and organizational profiles remain part of the direction;
- `current-with-dependencies` — derived state plus the exact evidence/version dependencies that keep it current.

The verbs are:

1. **read** — return current authorized state plus a delivery receipt;
2. **write** — submit provenance-bearing state with an idempotency key and receive a durability result;
3. **subscribe** — observe changes to state the principal is authorized to hold;
4. **records** — a subject's records, grants-first (added 1.27.0).

HTTP, MCP and the typed client use the same state rules. CLI commands initialize, serve and inspect partitions; they are not a separate implementation of the read/write contract.

## Boundary: state, not gateway

Hunch must not become the request-path proxy for business systems.

Wrong:

```text
Sofia -> Hunch -> Gmail / CRM / WhatsApp
```

Target:

```text
                 Hunch state
                   ↑     ↓
                   │     │
Sofia -> deterministic Action Gate -> connector -> source system
```

Each agent owns its live mechanics: connector authentication, source discovery, bounded reads, in-flight dedupe, prompt/model execution, approvals UX and source-specific mutation logic.

Hunch owns what should remain useful when those processes stop: what was decided, what is currently held as true, what was already done, what is committed, what changed, which entities relate, what evidence supports the state and what would invalidate it.

A useful ownership test is:

> **If the fact should remain useful when every agent and connector process is stopped, Hunch may own it. If the fact changes merely because a process connects, disconnects, authenticates or becomes temporarily unavailable, it belongs to the live agent/runtime layer.**

## State about work, not mirrored source content

The organizational state graph may reference CRM records, Gmail threads, WhatsApp conversations, repositories, deployments and other external resources, but it should not become a warehouse of their raw contents.

Prefer credential-free provenance pointers and bounded evidence:

```text
entity: customer/example-customer
relationship: customer/example-customer -> crm-event/10017
commitment: obtain-site-budget-tables
receipt: reply-sent
source pointer: gmail-thread/<opaque-id>
dependency: source-version/<hash-or-version>
```

The source system remains the authority for source data. Hunch records durable state **about** the work and the provenance required to verify it.

Secrets, access tokens, raw private messages, unrestricted CRM payloads and connector credentials must not become state simply because an agent observed them.

## Sofia is the first system-of-record pilot

Sofia is the first concrete pilot because it already has the exact state the organizational model needs:

| Sofia today | Deterministic state facet |
| --- | --- |
| approved CRM/Gmail/WhatsApp action | action receipt / `done` |
| pending or completed follow-up | `committed` |
| customer dossier | `entity` |
| CRM event, mail thread, WhatsApp chat | external entity + provenance pointer |
| links among customer and sources | `relationship` |
| user-managed rules | user DNA |
| cited customer summary | `current-with-dependencies` |
| approval/source fingerprint | dependency/currentness evidence |
| `unknown` mutation result | unresolved receipt requiring reconciliation |

The pilot should not start by moving every source query into Hunch. Sofia keeps reading CRM, Gmail and WhatsApp directly.

The pilot sequence is (status per step: the gate table in the [roadmap](../ROADMAP.md)):

1. **Baseline Sofia first.** Measure state re-derived between sessions, contradictions between two users' Sofias and stale answers after real source changes.
2. **Freeze additive contracts.** Add action receipt, commitment, external entity/relationship, user/team DNA and dependency-bound derived state without breaking repository `.hunch/` compatibility.
3. **Make Sofia write state.** External actions and follow-ups produce deterministic receipts/commitments after the source operation is verified.
4. **Read state before re-deriving.** Sofia asks the system-of-record query before reconstructing known organizational facts from source histories.
5. **Add a second different agent.** Codex or Claude Code writes/reads through the same contract so the test is heterogeneous agents sharing one reality, not two copies of Sofia.
6. **Re-measure.** The product thesis passes only if agents actually act from held state and the incident -> decision -> change -> closure chain is reproduced without contradictory re-derivation.

The canonical demonstration is:

```text
Sofia records customer incident + commitment
              ↓
engineering agent reads relevant organizational state
              ↓
engineering decision + change proof + shipped receipt
              ↓
Sofia sees the verified completion
              ↓
customer follow-up / closure with provenance
              ↓
new agent later reads the complete chain in one envelope
```

## Security relationship

Deterministic organizational state does not replace Sofia's action-security boundary.

The layers are distinct:

```text
Sofia / agent        -> reasons and proposes
Hunch state          -> says what is currently held as true and why
Action Gate          -> decides whether a real-world mutation is permitted
Connector            -> performs the exact authorized operation
Verification         -> confirms what actually happened
Hunch receipt        -> records the durable result
SOC / SIEM           -> observes anomalies and can trigger suspension/response
```

A model assertion such as "the customer already approved this" is not organizational truth merely because it appears in a prompt. If approval is a required deterministic fact, the agent should resolve that fact from held state and the Action Gate should enforce the relevant policy independently of model wording.

Hunch is not a permission system by default. Its deterministic gate may enforce state-backed policy, but it must not silently grant connector scopes or turn remembered text into execution authority.

## Existing products and compatibility

The architectural direction does **not** erase shipped history:

- existing repository `.hunch/` records remain valid;
- current CLI/MCP contracts remain compatibility surfaces;
- Project DNA, delivery receipts, Change Proof and deterministic policy/conformance contracts remain engine primitives;
- existing shared-memory and Hunch Memory transport code is implementation material to fold into the single product, not a new source of truth;
- historical ORC integrations remain evidence of prior production work, but ORC is no longer the product architecture owner for future state-layer work.

New organizational record kinds should be additive so older Hunch versions can continue to ignore what they do not understand rather than corrupting existing repository state.

## Deliberate non-goals

- a managed proxy that fetches Gmail, CRM, WhatsApp or GitHub on an agent's behalf;
- a central computation cache for source queries;
- Postgres or another database becoming a second authority beside git-native state;
- an orchestrator embedded inside Hunch;
- automatic promotion of probabilistic model output into trusted state;
- raw transcript storage as organizational truth;
- renaming the product before the contract and pilot are proven.

## Pilot kill criterion

The key question is mechanism, not marketing metrics:

> **When agents are given deterministic state before answering or acting, do they actually use it instead of independently rebuilding a different reality?**

After Sofia and a second different agent use the same contract, if the incident -> decision -> change -> closure chain is still materially re-derived or contradicted despite the state being available and delivered, the broad system-of-record thesis is wrong or incomplete. The work should then narrow toward the enforcement/delivery edge instead of expanding the platform.

The partition service already ships. The remaining pilot work tests whether it helps multiple people and different agents share real work over time. A successful pilot would support broader deployment and finer access controls; a small live trial or an emulated organization does not establish that wider outcome.
