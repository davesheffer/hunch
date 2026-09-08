# nuryel.state/1 — the state contract

Status: **proposed, frozen as code.** Verbs, canonical hashing, id derivation and invariants
live in `src/core/stateContract.ts`; the record schemas (facets) in `src/core/stateRecords.ts`,
a leaf module so the store's kind registry can reference them without an import cycle
(`stateContract` re-exports them — one module to import). Tests: `test/state-contract.test.ts`,
`test/state-kinds.test.ts`.

The five new facets **are registered store kinds** (`receipts`, `commitments`, `derived`,
`entities`, `relationships`) — additively: `ENTITY_KINDS` grows at the end, every registry-driven
path (store, overlay safety, private migrate, reindex, `dropAll`) picks them up unchanged,
entities and relationships are index-file stored like resources because their ids are not safe
file names, and the gitignore writer whitelists the new directories. The verbs are **not** wired
into the store, CLI or MCP yet. Bindings — HTTP, MCP, CLI, typed client — are generated from
these schemas in the next step; the contract is the thing to read and reject before anything
depends on it.

> Agents are probabilistic. Organizations need deterministic state. Nuryel is the state layer
> between them.

Every orchestrator and agent — Sofia, Codex, Claude Code, whatever comes next — speaks this one
contract to one state graph. Protocols are bindings of it, never separate integrations. No
adapters live in Nuryel: the orchestrator owns the mapping from its world to the contract.

## Scope model

One graph, partitioned: `organization › team › user › repository`. A record carries its scope;
legacy repository records default to the repository scope with no schema change. Repository
partitions are today's git-native `.hunch/`; organization, team and user partitions are more git
partitions the product serves — never written into a repository's `.hunch/`, which is also the
privacy rule (organization state does not ride a public repo).

A **principal** (human, agent, service) carries **grants** — the scopes it may see. Authorization
is decided against grants *before* retrieval; the read assertion checks it again on the way out.

## Facets

| Facet | Question it answers | Record | Exists today |
| --- | --- | --- | --- |
| decided | what was decided | `Decision` | yes |
| in force | what still holds | `Constraint`, `valid_to` windows | yes |
| done | what was already done | `nuryel.receipt/1` — `ActionReceipt` | **new** |
| committed | what someone owes by when | `nuryel.commitment/1` — `Commitment` | **new** |
| changed | what moved in an external system | `ExternalRef` — credential-free version pointer | **new** |
| current | what is true now, and on what it rests | `nuryel.derived/1` — `DerivedState` with mandatory dependencies | **new** |
| entity / relationship | who and what, and how they connect | `nuryel.entity/1`, `nuryel.relationship/1` (Landscape-shaped ids) | **new** |
| DNA | how this user / team / organization works | `hunch.project-dna/1` profiles keyed by scope | profile exists; scope keying new |

Each new facet is lifted from a record Sofia already keeps:

| Sofia today | Facet |
| --- | --- |
| approvals (`pending → executing → succeeded / unknown`, verified after execution) | `ActionReceipt` — identity is *the action* (actor, kind, target, request fingerprint, idempotency key), so a re-sent action replays the same receipt |
| follow-ups (title, due, open / done, evidence excerpt) | `Commitment` — in-force window via `valid_from / valid_to` |
| cited summary drafts, discarded when the customer version changed | `DerivedState` — dependencies are the citations; identity ignores dependency order |
| customer dossiers + source links (CRM event, Gmail thread, WhatsApp chat) | `ExternalEntity` with `refs` + `StateRelationship` |
| user rules (`sofia-memory-v1`) | DNA at user scope |

## Verbs

- **read** — `ReadRequest { principal, scope, subject?, task?, profile?, budget?, facets? }` →
  `ReadResponse { receipt_id, scope, state_of_record, denied_scopes }`. The receipt is the
  existing delivery envelope's `hdr_…` id, unchanged. `state_of_record` is the system-of-record
  answer for a subject: `current`, `in_force`, `done`, `depends_on`, `invalidated_by`. Scopes the
  principal asked about but is not granted are named in `denied_scopes`, never silently dropped.
- **write** — `WriteRequest { principal, scope, facet, record, idempotency_key, expected_version?,
  supersedes? }` → `WriteResult { record_id, record_hash, durability: pushed | committed | local,
  outcome: created | updated | replayed | superseded, conflict? }`. Provenance is mandatory on the
  record; the idempotency key is mandatory on the request; a replay returns the original.
- **subscribe** — `SubscribeRequest { principal, scope, after_seq, subjects?, facets? }` → a
  strictly ordered stream of `ChangeEvent { seq, facet, record_id, record_hash, change, invalidates,
  cause }`. A gap or regression means resynchronize; `assertChangeSequence` enforces it.
- **capabilities** — `negotiate(offered)` returns `{ supported, unsupported }`; an unsupported
  capability is a typed refusal, never a compatible-looking degraded answer.

## Canonical form and identity

`canonicalize` sorts keys by code unit at every level, drops `undefined`, rejects non-finite
numbers; `stateHash` is `sha256:` over that form. Ids derive from *what makes two records the
same fact*: `actionReceiptId` (action, not row), `commitmentId` (scope, subject, title, owner, due),
`derivedId` (scope, subject, transform, dependency hashes — order-independent), `entityId`
(kind-qualified, same rule as Landscape resources), `relationshipId` (same rule as graph edges).

## Invariants (exported, asserted, tested)

| Id | Statement | Enforced by |
| --- | --- | --- |
| `authorization-before-retrieval` | nothing outside the grants enters a candidate set | `assertReadWithinGrants` (and the binding's input filter) |
| `similarity-never-authorizes` | similarity finds candidates; only deterministic checks make a record current or visible | no verb schema admits a similarity field; test asserts it |
| `never-in-request-path` | Nuryel is read and written by orchestrators; it never proxies, fetches or stores on their behalf | there is no proxy verb; a gate that refuses is allowed |
| `provenance-on-every-write` | every write carries provenance + idempotency key | `assertWriteWellFormed`, `WriteRequestSchema` |
| `one-live-decision-per-topic` | a second live decision is refused with the incumbent named | existing topic guard; `WriteResult.conflict` |
| `external-truth-stays-external` | pointers, versions, hashes — never mirrored bodies | `ExternalRefSchema` credential-free refinements; entity attributes capped |
| `derived-state-carries-dependencies` | no dependencies, not state | `assertDerivedState`, schema `min(1)` |

## Backward compatibility

Additive. No existing record changes shape. `scope` on legacy records defaults to the repository
scope. New facets are new record kinds; an older reader ignores directories it does not know. The
JSON store's schema version is untouched. The delivery envelope, change proof and Project DNA
contracts keep their ids and become sub-schemas referenced here.

Evidence, not assertion (`test/state-kinds.test.ts`): a store holding only legacy records loads
unchanged with the new kinds registered and empty; `reindex` counts them; a directory this build
does not know (simulating a newer writer) is left exactly as written and never read as a kind;
the migration suite passes untouched. Forward-migration-before-validation (`con_947c578b2c`) is
not modified by the registration — the store change is the index-file layout map only.

## Not decided here

- **Per-record visibility** inside a scope. Partition-level grants are the v1 permission model
  (GitHub's repo-level model); finer visibility is the first security primitive to add before a
  second team shares an organization partition.
- **Search and delivery of the new kinds.** They are stored and counted; FTS indexing, ranking
  into the delivery envelope and the `state_of_record` query are binding work, not registry work.
- **The organization partition mode** in the served product (the fold of Hunch Memory).
- **Naming** — engine `hunch` / platform Nuryel, or one name for both.
