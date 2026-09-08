# nuryel.state/1 — the state contract

Status: **proposed, frozen as code, bound to the store, MCP and HTTP (`hunch serve`).** Verbs, canonical hashing,
id derivation and invariants live in `src/core/stateContract.ts`; the record schemas (facets) in
`src/core/stateRecords.ts`, a leaf module so the store's kind registry can reference them without
an import cycle (`stateContract` re-exports them — one module to import). The ONE implementation
of the verbs over a store is `src/store/stateBinding.ts`; the per-scope change ledger is
`src/store/changeLedger.ts`; the MCP binding is the four `nuryel_*` tools in `src/mcp/server.ts`.
Tests: `test/state-contract.test.ts`, `test/state-kinds.test.ts`, `test/state-binding.test.ts`,
`test/mcp-state.test.ts`.

The five new facets **are registered store kinds** (`receipts`, `commitments`, `derived`,
`entities`, `relationships`) — additively: `ENTITY_KINDS` grows at the end, every registry-driven
path (store, overlay safety, private migrate, reindex, `dropAll`) picks them up unchanged,
entities and relationships are index-file stored like resources because their ids are not safe
file names, and the gitignore writer whitelists the new directories. The verbs **are** wired
into the store (`readState` / `writeState` / `subscribeState`), exposed over MCP
(`nuryel_capabilities`, `nuryel_read`, `nuryel_write`, `nuryel_subscribe`) and over HTTP by
`hunch serve` with a typed client. Every transport calls the same three functions — a transport
that re-implements a rule is a bug.

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

## Binding: how the verbs meet the store

**Homing is decided by scope, never by a flag.** The repository scope (`capabilities` names its
id — the checkout's directory name, sanitized to the token grammar) is homed exactly where the
store homes any capture today: the public `.hunch/`, or the overlay in shared mode. Organization,
team and user scopes are homed in the overlay ONLY; without one the write is refused
(`no-partition-home`). That is the privacy rule executed, not documented.

**One ledger per scope** (`nuryel.ledger/1`, `.hunch/changes/<kind>-<id>-<hash>.json`, in the
scope's home, appended atomically): the strictly ordered `ChangeEvent` stream (seq 1, 2, 3 …)
plus the idempotency table. A record write and its event land in one atomic ledger write after
the record; a ledger that is not contiguous is an error, never silently restarted.

**write** in order: grants → provenance → home → normalize (partition scope stamped on new
facets, dropped from legacy ones; an agent principal cannot sign `human_confirmed` — it is
rewritten to `agent_recorded`, a human principal can) → identity (a supplied id must equal the
derived one, `identity` refusal otherwise; receipts, commitments and derived state derive their
ids, entities and relationships are checked by their schemas) → facet schema → idempotency (same
key + same payload = `replayed`; same key + other payload = `idempotency` refusal naming the
incumbent; same content under a new key = `replayed`, the key is remembered) → `expected_version`
(a record hash or the record's latest seq; mismatch = `conflict`) → one-live-decision-per-topic
(`conflict` naming the incumbent; explicit `supersedes` closes it and yields `superseded`) →
put → ledger → reindex → durability from the flush (`local` when nothing committed). Every
refusal is a typed `StateRefusal { code, conflict? }`; MCP renders it as
`nuryel.state/1 refused [code]: …`.

**read** builds the delivery envelope for `task ?? subject` (its `hdr_` id IS the receipt), then
assembles `state_of_record` for the subject: live decisions whose topic is the subject and
current derived state (`current`, with the union of their dependencies as `depends_on`); active
constraints and open/waiting commitments (`in_force`); succeeded/verified receipts targeting the
subject (`done`, and `invalidated_by` when the receipt lists the subject). The grant check is the
first predicate on every candidate; a matching record in an ungranted scope goes into
`denied_scopes` by scope only.

**subscribe** returns `{ scope, head_seq, events, filtered }` — an additive response envelope
around the contract's events. Unfiltered, `events` are contiguous after `after_seq` and
`assertChangeSequence` holds; with `facets` / `subjects` filters, `events` is a subsequence,
`filtered` is true, and `head_seq` is still the caller's next cursor. Subject matching uses the
record id, the event's `subject`, and what the event invalidates.

## Served partitions: `hunch serve`

The served product is the fold of Hunch Memory into Hunch. `hunch serve --config <file>` binds
`127.0.0.1` (put it behind SSH or a reverse proxy; never expose the port) and hosts partitions
over HTTP with the same three verbs: `GET /nuryel/v1/capabilities`, `POST /nuryel/v1/read`,
`POST /nuryel/v1/write`, `POST /nuryel/v1/subscribe` (request bodies are the contract's request
schemas minus `schema` and `principal`), plus `GET /nuryel/v1/health`. Errors are problem+json;
a `StateRefusal` maps to 403 outside-grants, 409 conflict / idempotency, 422 identity, 400
malformed / unsupported, 404 no-partition-home.

A **served partition is a directory whose `.hunch/partition.json` names the scope it IS** — so
user, team and organization state need no overlay: the partition is the store, and
`partitionOf(store)` (formerly `repositoryScope`) tells the binding to home writes there. The
bearer token resolves the **principal**; the body never names one, and grants come from the
config, never from the caller. `hunch serve init --partition user:david --root <dir>
--principal sofia@david` declares the partition and mints a token (printed once; only its sha256
is stored). Writes run under a **cross-process write lock** per partition (folded in from Hunch
Memory) so a stdio MCP process on the same store cannot race the HTTP server between the ledger
read and the record write.

The typed client — `import { createStateClient } from "@davesheffer/hunch/state"` — wraps the
four routes and turns problem+json into a `StateClientError { status, code, problem }`.

Tests: `test/serve.test.ts` — init + token hashing, bearer → principal, grants on every route, a
smuggled body principal ignored, typed refusals, ORC reading a user partition and writing the
organization one, six concurrent writes leaving a contiguous ledger, lock release on throw.

**A second agent over stdio.** `hunch mcp --root <partition dir>` pins the MCP server to a served
partition and ignores the client's workspace roots and per-call `cwd` hints, so Codex or Claude
Code opened on any repository read the same drawer `hunch serve` hosts. A read returns the
referenced **records** beside the refs (`ReadResponse.records`), and the MCP text renders the state
of record (current derived content, commitments with due and owner, receipts with action, target
and verification), so a consumer answers from the drawer without a second lookup or a file hunt.

Amendments made while binding (all additive, called out for the review): `ChangeEvent.subject`
(optional); `SubscribeResponse`; `ReadResponse.records` (optional, the records behind the refs); the token grammar is written as explicit character classes
instead of an `i` flag so it survives zod → JSON schema in MCP output validation;
`assertWriteWellFormed` compares the record's scope only when it is a partition scope (a legacy
constraint carries path globs under the same key).

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
- **What else of Hunch Memory folds in.** `serve` carries its bind-loopback, bearer, problem+json,
  body-limit and write-lock decisions. Its per-store concurrency gate, context-consistency
  watermarks and the usefulness / Project DNA intake routes are not ported; they return only if a
  served partition needs them.
- **Ledger merge.** A scope's ledger has one sequence because it has one home; two clones
  writing the same repository partition on different branches will collide on merge exactly
  as two live decisions on a topic do. `reconcile-topics` is the model; the ledger equivalent
  is not written.
- **Ledger compaction.** Ledgers grow without bound; a `compact` step that keeps the head and
  the idempotency table is future work.
- **Repository-scope private content.** The contract has no `private` flag: scope decides the
  home. Sensitive repository-scope state goes through the existing `hunch_record_*` tools
  with `private:true`, or into a user/team partition.
- **A CLI binding** for the verbs, and FTS / delivery ranking of the new kinds.
- **Naming** — engine `hunch` / platform Nuryel, or one name for both.
