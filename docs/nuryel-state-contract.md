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

- **read** — `ReadRequest { principal, scope, scopes?, subject?, task?, profile?, budget?, facets? }` →
  `ReadResponse { receipt_id, scope, state_of_record, denied_scopes, records?, scopes?, receipts? }`.
  The receipt is the existing delivery envelope's `hdr_…` id, unchanged. `state_of_record` is the
  system-of-record answer for a subject: `current`, `in_force`, `done`, `depends_on`,
  `invalidated_by`. Scopes the principal asked about but is not granted are named in
  `denied_scopes`, never silently dropped. **Union read:** `scopes` (1..64) asks for ONE
  `state_of_record` across several partitions in one call; `scope` stays required and is the
  primary — its envelope and `receipt_id` lead — and every entry is either read from its own
  partition or named in `denied_scopes` (an ungranted extra never refuses the call; only an
  ungranted primary does, as before). The response then names the partitions actually read in
  `scopes` and carries one delivery receipt per partition in `receipts`; every ref already carries
  its partition, so `current` / `in_force` / `done` concatenate, `depends_on` concatenates,
  `invalidated_by` and `denied_scopes` are unions, `records` merge by id. Both fields are absent on
  a single-partition read.
- **write** — `WriteRequest { principal, scope, facet, record, idempotency_key, expected_version?,
  supersedes? }` → `WriteResult { record_id, record_hash, durability: pushed | committed | local,
  outcome: created | updated | replayed | superseded, conflict? }`. Provenance is mandatory on the
  record; the idempotency key is mandatory on the request; a replay returns the original.
- **subscribe** — `SubscribeRequest { principal, scope, after_seq, subjects?, facets? }` → a
  strictly ordered stream of `ChangeEvent { seq, facet, record_id, record_hash, change, invalidates,
  cause }`. A gap or regression means resynchronize; `assertChangeSequence` enforces it.
- **records** — `RecordsRequest { principal, scope, ids }` → `RecordsResponse { records, facets,
  missing, denied }`. Fetch by id (from a subscribe event, a read ref, a write result). Grants
  first: an id whose scope is outside the grants is named in `denied`, never described; an
  unknown id in `missing`. Added after the first live writers: a subscribe event names a record
  and a consumer needs its body without a subject read.
- **capabilities** — `negotiate(offered)` returns `{ supported, unsupported }`; an unsupported
  capability is a typed refusal, never a compatible-looking degraded answer.

## The chain: incident → decision → change proof → closure

One subject's state crosses domains: a customer incident is recorded by a customer-facing agent,
the fix is decided and shipped by an engineering agent in a repository, and the closure has to be
visible to the first agent and to anyone who reads the drawer later. The contract carries that
chain as refs, never as prose:

- **A receipt names what it rested on.** `ActionReceipt.rests_on` (additive, optional) is a list of
  `DependencyRef`s — the same shape a derived statement's dependencies use: the decision it
  implements (`record`), the change proof for the shipped revision (`external`, system `hunch`,
  object type `change_proof`, keyed by `proof_id` with its `content_hash`), the commitment or
  incident it answers. A `record` ref may carry a `scope` (additive) to point into another
  partition — the repository decision from an organization drawer.
- **The binding verifies what it can see.** On write, a `rests_on` record ref into a partition the
  principal is not granted is refused by scope, before the record is looked at. A ref into a
  partition this store holds must exist there with the hash the writer saw — an absent target is
  `conflict` (`rests_on target absent`: write or re-read it first); a hash that no longer matches
  is `conflict` (`rests_on hash mismatch`: the record moved, re-read and rest on what is current);
  a ref that claims the wrong partition is `conflict` (`rests_on scope mismatch`). A ref into a
  partition this store does not hold is a pointer the reader resolves with `records`, grants first.
- **A closure names the receipt.** `Commitment.closed_by` (additive, optional) is the id of the
  receipt that fulfilled it. The binding refuses a `closed_by` that is not a succeeded or verified
  receipt on record within the principal's grants (`closed_by receipt absent`, `closed_by receipt
  failed`), and a `closed_by` on a commitment whose status is not `done` (`malformed`). The change
  event for the closure carries `cause: { kind: "receipt", receipt_id }`.
- **The read answers the chain.** For a subject, `done` holds the receipts that happened and the
  commitments fulfilled by one (they leave `in_force`); `depends_on` concatenates every done
  receipt's `rests_on` beside the current derived statements' dependencies, so "what does this
  closure rest on" is one read; `invalidated_by` names the receipt, so a stale summary is flagged.
  The decision and the proof are resolved by id through `records`: a principal without the
  repository grant sees the id named in `denied`, never described.
- **The write result carries the record on file.** `WriteResult.record_hash` and every change
  event hash the record as stored, not the payload as sent — the store may enrich a record on put
  (a private-mode decision gains `valid_from`), and a writer that goes on to rest a receipt on
  that record must hold the hash a reader will verify. Idempotency still recognizes the payload
  the writer re-sends (`payload_hash` in the ledger's journal, additive).

**For an engineering agent closing an incident from a repository** (Claude Code or Codex over
`hunch mcp`, granted the organization drawer and the repository):

1. `nuryel_read` the incident's subject (union read over both partitions): the commitment is
   in `in_force`, the incident entity and the current summary in `current`.
2. Decide and record: `hunch_capture_decision` → `hunch_record_decision`. The result carries a
   ready-made `rests_on` ref (id, hash on file, repository partition).
3. Ship, then seal: `hunch_change_proof(base_ref, result_ref)`. The result carries the proof's
   `rests_on` ref (`external`, system `hunch`, object type `change_proof`).
4. `nuryel_write` a receipt into the drawer: `action_kind: "shipped"`, `target` the merged pull
   request or revision, `invalidates: [<subject>]`, `rests_on: [<decision ref>, <proof ref>,
   { kind: "record", id: <commitment id>, record_hash: <its hash from step 1> }]`,
   `state: "verified"` once the merge is observed.
5. Close: `nuryel_write` the commitment again with `status: "done"`, `valid_to`, and
   `closed_by: <receipt id>` under a new idempotency key.

The next reader of the subject sees the receipt and the closed commitment in `done`, the
decision and proof in `depends_on`, and the old summary named in `invalidated_by`.

**The `changed` facet, written.** No source writes the drawer (Hunch is never in the request path
and never mirrors a source), so a source change reaches the drawer only through an agent that
re-reads it. `WriteRequest.cause` (additive) lets that agent say why: `{ kind: "external", ref }`.
A current derived statement written back as `stale` (same identity, `valid_to` set) is an
**invalidation**, not an update: the ledger emits `change: "invalidated"` with `invalidates:
[subject]` and the external pointer as cause, so every reader sees the summary leave `current`
and what moved. Sofia's source sweep is the first writer (re-stamp what a current summary rests
on; when a stamp differs from the hash the summary depends on, write it back stale with that
pointer), so the drawer is trustworthy between an agent's reads, not only at them.

Records written before these fields existed are untouched: nothing is materialized on them, they
hash and read exactly as before. `test/state-chain.test.ts` runs the whole chain through the one
binding with three principals over one store.

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
supersede target still open (a `supersedes` that names an already-closed commitment or derived
record is a `conflict` naming the record that is current now — two writers racing to replace
the same incumbent can never leave two current records for one subject; the writer that closed
it itself, same id under a new key, is exempt) → put → ledger → reindex → durability from the flush (`local` when nothing committed). Every
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

**Delivery** (`src/core/stateDelivery.ts`): state records are indexed and delivered by subject,
like decisions. Reindex writes every receipt, commitment, derived state, entity and relationship
into the store's `search` index under its own kind — title = the subject key (`customer:Site:7`,
`event:10042`), body = the summary/title + actor/owner + status label + dates — so
`hunch_query` answers a subject id, an action kind, a principal or a phrase from a summary with
one line per kind (`[commitment/in_force] customer:Site:7 — "send report" due 2026-09-11 (owner
sofia)`). History is indexed too and ranks below the state of record: a superseded summary, a
done commitment, a failed receipt or a retired entity is demoted on every search path (bm25
scaled toward zero raw; the bounded liveness prior ranked), never dropped. `hunch_context` and
`hunch context` carry a bounded State section — at most 3 current derived, 5 in-force
commitments, 3 latest receipts whose subject or text matches every token of the target,
ordered by score, then observed_at descending, then id — as supplements inside the same budget
and receipt. `read` remains the full, grant-checked view of a subject.

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

**Union read over HTTP.** `POST /nuryel/v1/read` with `scopes` runs `readState` against each
granted partition's own store (the primary first) and merges them with `mergeReadResponses`
(`src/store/stateBinding.ts`, pure and reusable by any host fronting several roots). A requested
scope that is granted but not served by this server is a 404 `no-partition`, like any other
route; an ungranted one is named in `denied_scopes` with status 200. ORC, granted `user/david`
and `organization/acme`, gets Sofia's receipts and the organization's commitments on a customer in
one answer instead of one read per drawer. `hunch mcp` fronts a single root, so over MCP a
`scopes` request answers from that partition and declares it in `scopes` — never a silent union.

The typed client — `import { createStateClient } from "@davesheffer/hunch/state"` — wraps the
four routes and turns problem+json into a `StateClientError { status, code, problem }`;
`ClientReadRequest` carries `scopes` unchanged.

Tests: `test/serve.test.ts` — init + token hashing, bearer → principal, grants on every route, a
smuggled body principal ignored, typed refusals, ORC reading a user partition and writing the
organization one, six concurrent writes leaving a contiguous ledger, lock release on throw.

**A second agent over stdio.** `hunch mcp --root <partition dir>` pins the MCP server to a served
partition and ignores the client's workspace roots and per-call `cwd` hints, so Codex or Claude
Code opened on any repository read the same drawer `hunch serve` hosts. A read returns the
referenced **records** beside the refs (`ReadResponse.records`), and the MCP text renders the state
of record (current derived content, commitments with due and owner, receipts with action, target
and verification), so a consumer answers from the drawer without a second lookup or a file hunt.

**Lessons from the first writers, enforced.** A write refused for a reused idempotency key
names the differing fields and the way out (re-send the original payload to replay, or use a new
key; the record keeps its derived id and is updated in place) — Sofia's summaries hit exactly
this: same evidence, same identity, new wording, same key, permanent refusal. `WriteResult.record`
returns the record as stored so a writer verifies what landed. The `records` verb above exists
because subscribe events name records and reads only returned refs.

Amendments made while binding (all additive, called out for the review): `ChangeEvent.subject`
(optional); `SubscribeResponse`; `ReadResponse.records` (optional, the records behind the refs); `WriteResult.record`; the `records` verb (`nuryel.state.records/1`, in the capability list); the union read — `ReadRequest.scopes` (optional, 1..64) with `ReadResponse.scopes` and `ReadResponse.receipts` (optional; the partitions read and one receipt each; `assertReadWithinGrants` checks both against the grants) and `mergeReadResponses` in the binding; the token grammar is written as explicit character classes
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
| `derived-state-writer-owns-currentness` | no source writes the drawer: the writer of a derived statement re-validates what it rests on and writes it back `stale` with the moved pointer as cause, or does not write derived state | `WriteRequest.cause`, the `invalidated` change (Sofia's source sweep is the reference writer) |

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
- **Semantic (embedding) recall over state records.** They ride the FTS index and the bounded
  liveness prior (see Delivery above); the optional embedding stream indexes them like any other
  search doc, but no state-specific recall has been measured.
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
