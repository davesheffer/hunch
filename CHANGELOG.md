# Changelog

## Unreleased

- Tool calls no longer die silently around a release. `npm version` keeps
  machine-local (git-ignored) hook and MCP pins on the last release npm can serve
  until the new one publishes — a pin ahead of publication made every `npx`
  launcher fail with ETARGET, so hooks injected nothing and the MCP server never
  connected, which looked like the agent forgetting to call Hunch. `hunch doctor`
  now names such a pin explicitly (`pin … npm cannot serve`) instead of reporting
  it clean, and a pre-edit or session hook that fails inside Hunch emits one
  "grounding unavailable" context line rather than nothing (still exit 0, never a
  deny).
- The MCP server sends `instructions` at initialize: the per-task contract
  (`hunch_task` start, `hunch_context` first, `hunch_check_constraints` before
  shared edits, `hunch_task` finish) reaches every client, including hosts with
  no lifecycle hooks. AGENTS.md/CLAUDE.md now say which hosts get a prompt-hook
  task ID (Claude Code) and which must start the task themselves (Codex, Windsurf).
- The managed Codex block sets `startup_timeout_sec = 60`: a cold `npx` install
  exceeded Codex's 10 s default and dropped Hunch from the tool catalog.

## 1.32.3 — 2026-09-12

- A subject holds one current derived statement per transform: a new current
  statement beside one of the same transform must name it in `supersedes`, or the
  write is refused `409 conflict` with the incumbent named
  (`one-current-derived-per-subject-transform`). The same identity written again
  updates or replays; a different transform is a different statement; observations
  are untouched; the human-correction guard still decides who may supersede a human's
  record. Found by the half-year agent farm: a writer that never named its
  predecessor had left 58 current summaries on one subject.
- A memory flush can no longer freeze a served write: every git call inside the
  flush is bounded (`HUNCH_COMMIT_GIT_TIMEOUT_MS`, default 60 s; a stopped call
  reports durability `local` and the next flush sweeps the same files up), commits
  run with `gc.auto=0`, and any call slower than 5 s is logged. One served write per
  long season had stalled the server for 8–15 minutes.
- `tooling/agent-farm/season.mjs`: the season — ten agent styles, a conductor, monthly
  compaction and restart, weekly audits, a replay of every partition; a 21-day
  season is asserted in CI.

## 1.32.2 — 2026-09-12

- The first time a lesson revision reaches a task, the delivery carries one line,
  `Hunch recalled: <lesson title>`: in `hunch_context` results, in
  `hunch context --task`, and as a `systemMessage` from Claude Code's pre-edit hook.
  Deduplicated per task and record revision; repeats stay silent; presentation
  opt-out silences the hook line.
- Executable-behavior policies name their failure precisely: a machine with no
  dependency-snapshot cache and a policy whose pinned snapshots predate the
  lockfile get distinct error codes with recovery hints, and `hunch check` groups
  identical non-evaluations into one block instead of one line per policy.
- `hunch drift --fail-on <kinds>` adds drift kinds to the exit-code gate; the
  release gate now fails on a live finding that cites a file which no longer
  exists.
- The unwired `.claude/pipeline/` prototype is removed.

## 1.32.1 — 2026-09-12

Task reports, hardened by the first day of dogfooding on this repository:

- `hunch task verify --timeout <seconds>` (default 120, ceiling six hours) and
  the engine API's `verify(…, { timeoutMs })` let a full test suite be retained
  as an observed check instead of being recorded as timed out.
- `hunch_task(finish)` and `hunch_report` return a bounded
  `hunch.task-report-summary/1` — exact identities, verdicts, counts and the
  card, within a 48 KB budget with explicit omitted counts — instead of the full
  document, which had exceeded a host's tool-result limit on an 18-delivery
  task and hidden the card. The full report remains `hunch report <id> --json`
  and the HTML view.
- `hunch integrations check` now marks hook capabilities verified from lifecycle
  events actually delivered to Hunch's hook on the expected version within 30
  days; configuration alone stays untested, and `mcp` still needs the probe.

## 1.32.0 — 2026-09-11

### See what Hunch contributed

Every task can now carry an inspectable contribution report. `hunch_task` over
MCP (or `hunch task start`) opens a report; `hunch_context` deliveries are retained
per task with exact record revisions; `hunch task verify <id> -- <command>` observes
a real local check bound to source snapshots; decision, correction and finding
captures record their save, commit and push proofs; the native edit gate's denials
are linked; and finishing prints a concise card with a link to a self-contained
local HTML evidence view (`hunch report <id> --html`). A public-only export omits
task prose and private memory. `hunch report --lesson` follows one lesson revision
across tasks.

Evidence grades stay separate: delivered, agent-reported application,
rule-supported application, observed command result, saved locally / committed /
pushed, and explicit unknowns. Rule support comes only from Hunch's own
deterministic evaluation of a delivered lesson's declared rule (a constraint's
forbids matcher or a decision's conformance predicate) on the files the task
changed (`hunch task conform`, automatic on finish). File overlap, agent prose and
a passing unrelated command never upgrade a claim; a tripped rule is shown.

Claude Code 2.1.196+ prompt hooks create the report natively and a nonblocking
Stop notice shows the card; Codex and other hosts use the managed MCP
instructions. A provider-neutral engine API (`createTaskReporter` from
`@davesheffer/hunch/reports`) lets any harness own lifecycle and presentation.
`hunch task presentation off` silences cards; observations expire after 90 days;
`hunch update` refreshes existing instructions through `integrations repair-pins`.
Automatic display is advertised only for the hosts exercised in
`docs/task-report-qualification.md`; interactive-terminal display and the user
acceptance sessions listed there remain open.

Also: the memory retrieval prior is recalibrated from 12 to 16 positions to repair
measured dilution, the served ledger gains a busy timeout, and the release
allowlists accept the packaged declaration closure.

## 1.31.0 — 2026-09-10

Agent launches now follow the initiating agent across synthesis, verification,
deep sampling, MCP requests and Git child processes. A Codex event stays with
Codex; Claude stays with Claude; Kimi uses its ACP adapter. Unknown or unavailable
origins never select another installed account. Additional CLIs can be configured
through explicit local stdin/ACP adapters. `--deep` samples one provider repeatedly.

`hunch review-memory auto` fetches complete GitHub review threads (or reads a local
export), proposes and verifies rules against current tracked code and existing
constraints, then saves advisory rules without a handwritten `rules.json`.
Uncertain cases remain in a JSON report. Local checkpoints avoid reanalyzing
unchanged dispositions; changed evidence/code and retired rules are never silently
overwritten or revived. `--dry-run` previews and `--retry` rechecks queued cases.

## 1.30.0 — 2026-09-10

### Scoped review memory from PR threads

`hunch review-memory prepare` imports local GitHub inline review-comment exports
into deterministic, source-linked thread packets. `capture` previews explicitly
selected rule wording and verification checks; `--apply --private|--public` stores
them through the existing Constraint and grounding pipeline. Imported prose never
activates a rule or gains blocking authority. Captures remain `agent_recorded`
warnings, with exact file scopes and review evidence, until the existing human
countersign flow is used.

Incomplete threads, mismatched repositories, stale selections, missing current
files and existing rule IDs are refused. A real-data trial on `infection/infection`
covered 102 comments from 11 PRs and exercised capture and delivery for two selected
rules in an isolated clone. See `docs/review-memory.md` and the inspectable JSON
trial report under `docs/evidence/`. Rule selection is manual; this release does
not claim automatic extraction or measured bug reduction.

### Replay determinism is a check, and a human correction outranks the agents

**`hunch serve replay`** (`nuryel.replay/1`). A partition's current state is a pure function of
its change ledger — and now that is a command, not copy. `hunch serve replay --partition
<kind:id>` (with a serve config) or `--root <dir>` (the partition a directory is) folds
`.hunch/changes/` into the state it implies (every record's hash after its last event) and
compares it, hash for hash, to the records on file; `stateHash` is sha256 over the canonical form,
so equal hashes are byte-equal canonical records. The report carries `replay_hash` and
`stored_hash` (they must agree) and typed divergences, each naming the record, the seq and both
hashes: `missing-record`, `hash-drift`, `orphan-record` (a state record the ledger never saw — the
crash-between-put-and-append the ledger promised the next writer could detect, now detected),
`idempotency-drift`, and `legacy-drift` (a decision / constraint / bug / finding moved by a path
older than the contract — reported, never a failure). Compaction keeps the property through the
idempotency table, which is kept whole; a closed record whose supersession fell below the floor is
`unverifiable` (counted), an open record that differs is drift. Exit 1 on any divergence, and
`hunch drift` runs the same check whenever its partition has a change ledger (`replay-*` findings
fail the gate), so the existing CI gate covers ledger≠records beside doc≠graph. `verifyReplay` / `foldLedger` / `formatReplayReport` in
`src/store/replay.ts`; the agent farm replays every served partition at the end of every run and
reports `replay` beside `contradictions`. `stateHomeFor` is exported from the binding so the check
reads exactly the home the write verb wrote.

**Subject identity by external reference** (`one-entity-per-external-ref`). Two agents over one
CRM record, thread or chat land on one subject, by explicit refs only. The contract freezes
`canonicalObjectKey` (NFC, trim, collapse whitespace, case preserved), `externalKey(ref)`
(`system/object_type/key`) and `subjectOfRef(ref)` (`object_type:key`, the receipt read's
convention). `writeState` refuses a second active entity in a partition that carries an external
key an incumbent already carries (`409 conflict`, incumbent named — write under it or retire it
first; merge and split stay explicit) and a commitment or derived statement whose subject is the
external key of a record an active entity carries (`422 identity`, entity id named — ids derive
from the subject, so the writer re-derives). A subject no entity claims stays a free-form key. On
read a subject resolves one explicit hop — the entity that carries the key and every key it
carries — so `site:7`, `customer:clinic-7` and the entity's thread key return the same state of
record. `test/state-entity-identity.test.ts`.

**Audited entity merge and split.** A merge is a write, not a rewrite: the entity that goes is
written `lifecycle: retired` with `merged_into: <survivor>` (additive field on `nuryel.entity/1`);
the survivor must be an active entity on record (`409 conflict` otherwise; merging into an entity
that was itself merged names the one that stands now); the ledger holds a `retired` change (the
enum's first writer) with the writer's provenance. Nothing filed under the retired id is touched —
reads resolve the old id and every key it carried, through chains of merges, to the survivor and
return both histories as one state of record with only the survivor `current`; new state under the
old name is refused `422 identity` naming the survivor; the survivor may then carry the retired
entity's keys. Split is the explicit reverse (re-key the survivor, write the entity active again),
refused while any active entity still carries its keys. `test/state-entity-merge.test.ts`.

**`human-correction-outranks-agent-writes`** — a new contract invariant, enforced at write time.
A record a human confirmed (`provenance.source` carries `human_confirmed`) is never overwritten or
superseded by an agent or service principal: the write is refused `409 conflict`, reason
`human-confirmed incumbent`, the differing fields named. Three agent moves stay open, each keeping
the human's provenance on the record: re-sending the human's facts is a `replayed` (the tier
downgrade aside, nothing differs), writing a derived statement back `stale` with the external
cause that moved (the writer's currentness duty), and closing a commitment with a receipt on
record (a fact that happened). A peer's reducer was observed to let a later LLM write override a
human correction (`fnd_f670868a8c`); this is the test that Hunch does not.
`test/state-replay.test.ts` covers both features, including the CLI's exit code.

## 1.29.0 — 2026-09-09

### The chain: incident → decision → change proof → closure

Gate 4's cross-domain chain is a contract feature, not a demo script. A receipt names what it
rested on — `ActionReceipt.rests_on` (additive): the decision it implements, the change proof
for the shipped revision (`external` ref, system `hunch`, object type `change_proof`, keyed by
`proof_id` + `content_hash`), the commitment or incident it answers; a `record` ref may carry a
`scope` to point into another partition (the repository decision from an organization drawer).
The binding verifies what it can see, grants first: a ref outside the grants is refused by
scope; a ref into a held partition must exist with the hash the writer saw (`rests_on target
absent` / `hash mismatch` / `scope mismatch`, each naming the way out); a ref into a partition
the store does not hold is a pointer for the reader. A closure names the receipt —
`Commitment.closed_by` (additive) must be a succeeded/verified receipt on record within the
grants, on a `done` commitment; the closure's change event has `cause: { kind: "receipt" }`.
The read answers the chain: `done` carries fulfilled commitments beside the receipts that
closed them, `depends_on` concatenates every done receipt's `rests_on`, and `nuryel_read`
renders `rests on record dec_… in repository/…` / `rests on hunch change_proof:hproof_…` and
`closed by nrc_…`. Write results and change events now hash the record ON FILE (a private-mode
decision is enriched on put), with the payload hash kept in the ledger journal for replay.
Older receipts and commitments are untouched. `hunch_record_decision` and `hunch_change_proof`
now hand back the ready-made `rests_on` ref (id + hash on file + repository partition; proof id +
content hash), so an engineering agent never rests a receipt on a pre-store hash; the contract
doc carries the five-step recipe for closing an incident from a repository.
`test/state-chain.test.ts`: three principals, one store, the whole chain and every refusal.

**The farm runs the chain.** `tooling/agent-farm` now serves a repository partition beside the
organization drawer; every other customer raises an incident and an escalation engineering owes
(shared keys, replayed by the second sofia), and the engineer closes each one through the chain —
union read, decision in the repository partition, proof pointer, `shipped` receipt resting on all
three, escalation closed by it — with the two chain refusals provoked once. Every sofia must see
the closure, the orc verifies all five links per incident and is refused the repository partition,
and the ledger replay finds each closure caused by its receipt; a missing link is a contradiction.
3 sofias × 5 customers: 3 incidents, 9 closures seen, 0 contradictions, 3.3 s. The Sofia emulation
(real Sofia code, 3 Sofias, 10-clinic year) runs the same chain against a served organization +
repository partition: Sofia's `summary()` now reads the drawer's state of record first and rests
on its receipts and fulfilled commitments as record dependencies, so every Sofia serving a closed
clinic re-derived and cited the engineer's receipt — 5 of 5, 0 contradictions — and the receipt
rests on a real `hunch prove` proof sealed from the engineer's commit, re-verified by the ORC
against its pointer and binding the decision hash for hash. Sofia's chat now reads the drawer
first too: a status question about an event is answered from held state (receipts done,
commitments in force, the current summary) under the read's receipt, marked as such when no
source was read — 12 of 12 in the emulation, 0 unsourced replies.

**The `changed` facet, written.** `WriteRequest.cause` (additive): `{ kind: "external", ref }` says why
a write happened when it is not the writer's doing. A current derived record written back as
`stale` is an `invalidated` change (`invalidates: [subject]`, the pointer as cause), never an
`updated` one. Sofia's source sweep is the first writer: it re-stamps what a current summary rests
on and invalidates it when a source moved, so the drawer is trustworthy between reads. New invariant
`derived-state-writer-owns-currentness`: the writer of a derived statement owns keeping its
dependencies true; an agent that will not do this must not write derived state.

### Merge lag is not a release blocker

Two branches that each capture one record both regenerate the very same "N+1 decisions"
counts line in the grounding docs; the forge merges identical lines with no conflict, the
merged store holds N+2, and the committed CLAUDE.md is one behind — no hook ran, nobody
erred, and the next capture heals it. Every red of that class (PR #128, #135, v1.26.2's first
tagged run, `fnd_c402046ac7`) was this lag, and each cost a manual regenerate-and-retag.

**Direction-aware freshness.** `test/grounding-freshness` now classifies the committed block
against the generated one (`src/core/groundingLag.ts`): byte-equal is `fresh`; a difference
confined to the counts sentence where no append-only count (decisions, bugs, constraints,
components, policies) exceeds the store is `lagging` — reported as a diagnostic, never red;
an append-only count AHEAD of the store is the never-committed-record defect
(`fnd_6391b4242f`, the only defect the counts ever caught) and still fails, as does any
difference outside the counts sentence. Open findings move both ways (resolved on one
branch, recorded on another), so a differing findings count alone is lag.

**`hunch grounding`.** One command for the five grounding docs: the verdict per doc, the
exact delta (`CLAUDE.md: counts lag the store (decisions 228 → 229)`), exit 1 only on
`ahead`/`diverged`; `--refresh` regenerates every existing doc from the PUBLIC store
(`HUNCH_PRIVATE_DIR` pinned to an empty overlay, so a dev machine with an overlay attached
can never write union counts into a committed public doc) and never scaffolds a doc the
project lacks; `--json` for scripts.

**Post-merge hook.** `hunch init` installs a `post-merge` hook that runs `hunch grounding
--refresh` when the merge or pull brought `.hunch/` changes in, so a local merge leaves the
docs re-synced for the developer's next commit (never auto-committed, loop-guarded via
`HUNCH_SYNC`, never fatal, existing hooks preserved). End-to-end in
`test/grounding-merge-lag.test.ts`: the silent merge, the lag verdict, the ahead refusal,
the refresh, the hook.

Also: `hono` (transitive, via the MCP SDK's optional HTTP transport) 4.13.0 → 4.13.7 in the
lockfile — `npm audit --omit=dev` reported three moderate advisories (GHSA-gqvv-2mrq-wpjv,
GHSA-g6gw-c38x-mqfc, GHSA-crvj-82cr-hjcx) fixed in 4.13.5, in range for both dependents, so
the production dependency audit passes again without a reviewed exception.

### Positioning: competing for the deterministic state layer, from the organizational side

Neotoma has called itself "a deterministic state layer for AI agents" since March 2026; the
dated comparison, a same-day sweep of the nearer peers (Jaybase, Zep/Graphiti, the memory
layers, durable execution, the receipts papers), and the peer material worth building are in
`docs/competitive-landscape.md` and the ROADMAP's landscape table. Hunch keeps competing for the
position and never claims to have named it (`dec_327dbd3c78`). The site hero is now the thesis
line with a "the moat" section (git as the source of truth, refusal not convergence, drawers with
a key per agent, receipts and commitments as facts, Never Twice, the code-conformance spoke) in
all five locales; the README top, its "Why Hunch, not another memory layer" section, the
state section (1.25.0–1.28.0 as shipped, install pins current) and the npm package description
speak the same language. No engine change.

## 1.28.0 — 2026-09-08

### Many agents, one subject

Three changes from running three Sofias over one emulated organization (ten clinics, a year of
mail, chat and CRM) and from the first two-drawer principal on the live pilot.

**Union read.** A key that opens several drawers reads them in one call: `ReadRequest.scopes`
(1..64) resolves every granted partition the server hosts and merges one `state_of_record` —
refs concatenate (each already carries its partition), `depends_on` concatenates,
`invalidated_by` and `denied_scopes` union, `records` merge by id. `ReadResponse.scopes` names
the partitions actually read and `ReadResponse.receipts` carries one delivery receipt per
partition; the primary's envelope and `receipt_id` lead. An ungranted extra scope is named in
`denied_scopes`, never described and never a refusal; only an ungranted primary refuses, as
before. Single-partition reads are byte-identical. Over MCP a single-root host declares
`scopes: [primary]` so it is never a silent union. Closes `fnd_a16aee3105`.

**A supersede target must still be open.** Two writers racing to replace the same incumbent
could both succeed and leave two current records for one subject (`fnd_eeb8bf3cb8`, found when
subjects became shared across Sofias). A `supersedes` that names an already-closed commitment or
derived record is now a `conflict` naming the record that is current for that subject, so the
loser re-reads and supersedes that one. The writer that closed the incumbent itself (same
derived id under a new key) is exempt and is an in-place update.

### State records are searchable and delivered by subject

The five `nuryel.state/1` kinds registered in 1.25 — receipts, commitments, derived, entities,
relationships — were stored and counted but neither indexed nor delivered: `hunch_query
("customer:Site:7")` could not surface a current summary, an open commitment or a verified
receipt, and `hunch_context("clinic elevator")` had nothing to say about state. Reindex now adds
every state record to the `search` index under its own kind (same FTS shape, no schema bump):
title = the subject key, body = the summary/title + actor/owner + status label + dates, so a
subject id, an action kind, a principal and a phrase from a summary all hit. History stays
indexed and findable but ranks below the state of record: a superseded summary, a done or
cancelled commitment, a failed receipt or a retired entity has its bm25 score scaled toward
zero (`HUNCH_STATE_HISTORY_SCORE_FACTOR`, default 0.5) on the raw path, and carries the same
bounded liveness prior a superseded decision does on the ranked/hybrid path; state kinds join
the memory-record prior so a subject query is answered by state, not by symbols that share its
words. `hunch_query` and `hunch query` render one line per kind — `[commitment/in_force]
customer:Site:7 — "send report" due 2026-09-11 (owner sofia)`, `[derived/current] customer:Site:7
— <first 120 chars>`, `[receipt/verified] event:10042 — events_add_actions by sofia@david
2026-09-08` — with the record id on the detail line. `hunch_context` and `hunch context` carry a
bounded **State** section when the target's tokens all match a subject or a record's text
(AND, prefix-tolerant, so a file path never drags in a summary that merely mentions "store"):
at most 3 current derived, 5 in-force commitments and 3 latest receipts, ordered by score, then
observed_at descending, then id, delivered as supplements that share the brief's budget and
receipt; state hits are no longer echoed as raw `search-*` lines. Time-travel briefs withhold the
section (state records have no as-of view). A store with zero state records is byte-identical.
New: `src/core/stateDelivery.ts` (liveness, search doc, one-line render, slice ordering,
supplements), `HunchStore.stateSlice(target)`, `formatSearchHit`; `test/state-kinds-search.test.ts`.

Also: public fixtures and docs use fictional organization, customer and CRM ids; a second
category post, *Knowledge is what's true. State is what happened.*, in five locales.

## 1.27.0 — 2026-09-08

### The contract learns from its first writers

Three additive changes to `nuryel.state/1`, each from a defect a real writer hit on the live
pilot. A write refused for a reused idempotency key now names the differing fields and the way
out: re-send the original payload to replay it, or use a new key; the record keeps its derived
id and is updated in place. `WriteResult.record` returns the record as stored, so a writer can
verify what landed. A `records` verb (`nuryel.state.records/1`, in the capability list) fetches
records by id, grants first: found with its facet, denied by scope (named, never described) or
missing. It is bound on the store, over MCP as `nuryel_records`, over HTTP as
`POST /nuryel/v1/records`, and in the typed client. Reads already carried the records behind
their refs; subscribe events only named them, and consumers had no way to the body.

The per-scope change ledger gains compaction (`hunch serve compact --partition kind:id --keep N`:
newest events kept, floor moved up, idempotency table kept whole), an explicit `resync` on
subscribe when a cursor is below the floor, and a three-way merge through the existing git merge
driver so two clones that appended to one partition merge to one re-sequenced ledger; a key used
for two records is a conflict the driver refuses to resolve silently. `tooling/agent-farm` runs
K sofia-like agents, an orc and an engineer against an in-process `hunch serve` on loopback and
reports writes, replays, refusals, reuse and contradictions (which must be zero) — a demo and a
benchmark for "many agents, one truth".

## 1.26.2 — 2026-09-08

### Served partitions commit, pin, and answer

Three defects found on the first live pilot after a real receipt, each fixed with a test.
Served writes now commit: `hunch serve` flushes inside its cross-process write lock, the lock
file was staged with the record, and the staged-memory backstop refused the commit quietly, so
every write reported durability `local`; `write.lock` is a derived artifact now and `serve init`
writes the partition's `.gitignore`. `hunch mcp --root <dir>` pins the MCP server to a served
partition and ignores the client's workspace roots and per-call `cwd` hints, so a second agent
opened on any repository reads the same drawer. A read carries the referenced records
(`ReadResponse.records`, additive) and `nuryel_read` renders the state of record — current
derived content, commitments with due and owner, receipts with action, target and verification —
so a consumer answers from the drawer without a second lookup. `nuryel_write` over MCP takes
the same partition write lock as `hunch serve`, so a second agent writing over stdio cannot race
the server.

## 1.26.1 — 2026-09-08

### `serve init` honors its own options

In 1.26.0, `hunch serve init --config <file> --port <n>` silently wrote the default
`hunch-serve.json` into the current directory with the default port: `serve` and `serve init`
both declare those options and the parent command claimed the values. `init` now reads both
levels; a regression test spawns the CLI from another directory and checks the file location and
the recorded port. No runtime code of the server, the store binding or the contract changed.

## 1.26.0 — 2026-09-08

### `hunch serve`: the state layer served, and Hunch Memory folded in

`hunch serve --config <file>` hosts organization, team, user and repository partitions over
HTTP on `127.0.0.1` with the contract's three verbs (`/nuryel/v1/read`, `/write`, `/subscribe`)
plus `/capabilities` and `/health`. A served partition is a directory whose
`.hunch/partition.json` names the scope it is, so user and organization state needs no overlay.
The bearer token resolves the principal; the request body never names one, and grants come from
the config only. `hunch serve init --partition user:david --root <dir> --principal sofia@david`
declares a partition and mints a token (printed once; only its sha256 is stored). Writes run
under a cross-process write lock per partition so a stdio MCP process on the same store cannot
race the server. A typed client ships as `@davesheffer/hunch/state`. This is the fold of the
separate Hunch Memory service into Hunch: its loopback-bind, bearer, problem+json, body-limit and
write-lock decisions carry over; its concurrency gate, consistency watermarks and intake routes
do not. Every rule still lives in the store binding; the transport only maps HTTP to it.

## 1.25.0 — 2026-09-08

### The state contract ships: nuryel.state/1 over the store and MCP

Hunch now exposes ONE contract every orchestrator and agent speaks to organizational state.
`nuryel.state/1` freezes three verbs — `read` (under the delivery envelope's receipt), `write`
(provenance and an idempotency key in, durability out) and `subscribe` (a strictly ordered change
stream after a cursor) — plus five new record facets: action receipts (what was done),
commitments (what someone owes by when), derived state that names what it rests on, external
entities and their relationships. Ids are derived from a record's facts, never chosen; a replay
returns the original; a second live decision on a topic is refused with the incumbent named;
derived state without dependencies is not state. The store registers the facets additively and
keeps a per-scope, git-native change ledger under `.hunch/changes/`. Organization, team and user
partitions never ride a repository: they are homed in an overlay only. Four client-agnostic MCP
tools bind the contract: `nuryel_capabilities`, `nuryel_read`, `nuryel_write`, `nuryel_subscribe`.
Legacy stores load unchanged; the JSON schema version is untouched. HTTP and CLI bindings, and
search or delivery ranking of the new kinds, are not in this release.

## 1.24.0 — 2026-09-06

### Update Hunch and every configured harness in one command

`hunch update` resolves the latest npm release, updates a standalone npm project's
Hunch dependency to an exact version in its existing dependency section, and repairs
all configured harness pins using the newly installed version. Without a repository
dependency it updates the global CLI. `--global` also updates the global CLI alongside
a local dependency; `--dry-run` previews the commands without changing files.
Generated agent instructions map “update Hunch” to this command. Existing hook settings
are preserved, failures stop the update, and active MCP sessions must reconnect afterward.

The newer DNA hero and its floating particles are now committed with the matching styles
and all five localized homepages. Automatic site deployments from `main` retain the
design that was previously present only in a manual Vercel deployment.

## 1.23.3 — 2026-09-05

### Harness coverage and version drift become visible

`hunch integrations check` reports repository-local MCP and lifecycle coverage for Claude,
Codex, Cursor, VS Code, Windsurf, and Antigravity. Configuration alone never counts as
verified delivery. Explicit capability requirements fail when support is advisory, missing,
or untested; an opt-in fresh-process MCP probe verifies version identity and a memory read.

`hunch integrations repair-pins` aligns existing exact npm launchers with the consuming
repository's Hunch dependency while preserving other settings. Setup, doctor, and supported
session hooks surface integration problems. This release does not add lifecycle support to
harnesses whose Hunch adapters lack it, or certify existing host sessions or model compliance.

## 1.23.2 — 2026-09-03

### The public site moves to hunchmemory.com

Hunch's public site now lives at https://www.hunchmemory.com; the package, plugin and MCP registry
manifests point there instead of the old Vercel preview host. Page titles use the two-word
"Hunch Memory" form, and the site ships a generated sitemap and robots.txt. No runtime code changed
since 1.23.1.

## 1.23.1 — 2026-09-03

### The change-proof contracts actually ship

The 1.23.0 tag never reached npm: the trusted release workflow refused the candidate tarball because
its package-path allowlist predated the `contracts/change-proof/*.json` fixtures and the change-proof
`.d.ts` entries that 1.23.0 added to `files`. The allowlist now admits exactly those paths, and
`npm test` executes the workflow's own allowlist against `npm pack --dry-run` so a `files`/allowlist
mismatch fails before a tag exists. No runtime code changed since 1.23.0.

## 1.23.0 — 2026-09-03

### Exact changes now carry native semantic proof

`hunch prove` and `hunch_change_proof` now emit the same canonical
`hunch.change-proof/1` artifact. The proof binds exact Git change identity, repository and Project
DNA revisions, base/result semantic graphs, relevant decisions and constraints, blast radius,
conformance, the strict Change Gate result, and explicit omissions/unknowns. Publication-safe
derivation excludes private-overlay records at the read boundary.

The package exports the seal validator and ships a versioned JSON Schema plus sealed fixture for
independent consumers. The proof is evidence only and explicitly grants no execution, CI,
deployment, merge, ranking, promotion, or policy authority.

## 1.22.3 — 2026-09-01

### Project DNA feedback keeps receipts

Project DNA now has a distinct, content-addressed usefulness-observation contract that binds the
exact Hunch Memory delivery receipt, profile and snapshot hashes, role-shaped trait projection,
downstream artifact and Project Match assessment. Project Match remains explicitly non-causal:
automatic outcomes can report only `unknown`, while every classified signal requires an exact
explicit-human or independent-review evidence reference.

Contradiction and staleness can create open advisory review work, but observations cannot mutate a
profile, change ranking, promote knowledge or grant authority.

## 1.22.2 — 2026-09-01

### Cold graph refresh stays inside the budget

Private/shared memory publication no longer repeats the same repository-publication and remote-contract
proofs twice after a successful merge when no mutation boundary exists between them. The push helper still
re-proves both boundaries immediately at the actual push seam, so source isolation, remote identity and
honest durability reporting remain fail-closed.

On the 1,011-file ORC checkout, Hunch Memory's 750-record cold pilot completed graph refresh in 8.85 seconds
and ORC's fresh-process live Project DNA retrieval completed in 7.80 seconds, both within the strict
10-second budget. All 45 overlay publication, sync, race, hook and ancestry guards remain green.

## 1.22.1 — 2026-08-31

### Cold graph refresh fits the strict budget

Exact-commit scans now validate immutable Git blobs once, then hydrate them through bounded
`git cat-file --batch` processes. Per-file type, size, UTF-8, content-hash and repeat-read guarantees
remain intact, while a 1,009-file ORC scan fell from 41.0 seconds to 3.0 seconds. The complete cold
path through a separate Hunch Memory server took 5.0 seconds, and ORC retrieval completed in 6.27
seconds—inside its strict 10-second budget.

The repository integration also includes native Windsurf lifecycle hooks so Hunch context and
learning follow the same install, prompt, failure and shutdown moments as the other supported
agents.

## 1.22.0 — 2026-08-31

### Project DNA learns from authorized collaboration evidence

Hunch can now derive repository-native vocabulary and contribution guidance from bounded,
caller-supplied pull-request and review evidence. Every evidence batch is canonical, sealed, tied to
an exact Git revision and validated before use; raw collaboration text never enters the Project DNA
profile, while each derived trait retains an explainable evidence reference.

The public `@davesheffer/hunch/project-dna` library surface now includes the typed evidence contract,
validator and stable TypeScript declarations needed by cross-repository consumers. Existing callers
that provide no host evidence keep the same deterministic code-and-memory-only profile.

## 1.21.1 — 2026-08-31

### The agent speaks the repository's language

Project DNA gives Hunch an evidence-bound, revision-specific view of how a repository communicates
and works. Normal `hunch_context` delivery can now include a compact DNA supplement, while new CLI,
MCP and library surfaces expose the sealed profile, explainable Project Match checks and profile
deltas. The result is repository-native terminology and contribution guidance without turning
observed style into policy or impersonating a maintainer.

This patch also makes 1.21 upgrades safe for installed clients: generated Claude hooks keep a
portable exact npm pin, legacy Hunch hooks are replaced instead of duplicated, and unrelated user
hooks remain untouched.

## 1.20.2 — 2026-08-29

### Snapshot deletion is durable without risking source

Private and shared memory sync now carries stale JSON record deletions after first proving that the
memory overlay is a standalone Git repository distinct from the protected code repository. This
closes the durability gap where a graph snapshot was correct on disk but an obsolete per-record
component remained in remote history and left the local memory repository dirty.

The boundary stays fail-closed: public-repository deletion, `local.json`, derived artifacts,
non-JSON paths, copies, type changes, and anything outside the exact Hunch subtree are still
refused. Snapshot ID churn is inspected as an exact add plus delete instead of trusting Git's
heuristic rename presentation.

## 1.20.1 — 2026-08-29

### Reviewed landscapes stay current safely

A reviewed Engineering Landscape can now be re-reviewed at a newer exact Git revision without
weakening the no-overwrite guard. `hunch landscape adopt --all --refresh-reviewed` replays the prior
full review from immutable history, proves the exact stored bytes and repository identity, and then
replaces only those proven adoption records.

Partial selections, hand edits, forged review IDs, missing history, same-revision conflicts, and
foreign repositories remain fail-closed.

## 1.20.0 — 2026-08-28

### One verified memory path from reason to result

Stable 1.20 promotes the complete release-candidate line to npm's `latest` channel. Reviewed
repository landscapes and role-shaped context travel in Hunch's native, content-addressed delivery
envelope; an exact code change can then be bound to later usefulness evidence without allowing that
evidence to grant ranking, promotion, policy, or enforcement authority.

PHP repositories and existing ADR corpora now enter the same graph and lifecycle model as the rest
of the codebase. Bulk graph snapshots make that practical on production-sized repositories, while
source, provenance, currentness, omissions, and review state remain explicit throughout delivery.

### Assistant instructions now use the real context argument

Generated grounding now documents `hunch_context(target)`, matching the MCP schema, so an agent can
copy the signature without sending an invalid `target_or_task` argument. Existing managed grounding
files self-heal on refresh. Fixed #95.

### Config safety checks now cover config writers, not local Git hooks

The raw-write guard remains blocking for the modules that merge user MCP, provider, and grounding
configuration, but no longer flags the marker-based local Git hook installer. Fixed #94.

### Shared decisions no longer disappear behind a transient pull backoff

An already-running MCP process now rechecks shared team memory before claiming that an exact topic
has no current decision. A transient Git failure may still leave known local decisions readable,
but an unconfirmed miss is an explicit error rather than a false “never captured” answer; once the
store recovers, the same client bypasses backoff and receives the teammate's decision without a
restart.

## 1.20.0-rc.6 — 2026-08-28

### Delivery adapts to the work without changing authority

Hunch now seals `builder`, `reviewer`, and `architect` delivery profiles into every native receipt.
Profiles only reorder and cap nonblocking material; blocking constraints remain first and mandatory,
and provenance, currentness, abstention, and authority rules are identical across roles. The CLI,
MCP surface, hooks, and Hunch Memory bridge share the same versioned policy.

### Outcomes bind to the exact tree change

The new `hunch.change-identity/1` receipt hashes Git's raw tree delta, including paths, modes,
whitespace, and binary changes, while ignoring commit messages, authors, and squash metadata.
Usefulness observations may carry that independently validated receipt, giving downstream outcome
analysis an exact change boundary without granting ranking, promotion, or execution authority.

## 1.20.0-rc.5 — 2026-08-28

### Outcome evidence can return without silently becoming authority

Hunch now owns the strict, content-addressed `hunch.usefulness-observation/1` contract. One terminal
episode, exact Hunch Memory receipt, and delivered record identity produce one deterministic key;
changed content under that key conflicts instead of becoming a second observation. The seal binds
the episode, provider-native receipt hash, graph/source revision, record revision/content hash,
bounded evidence references, and retention window while excluding transcripts and provider output.

Every usefulness signal declares zero ranking, promotion, policy, or enforcement effect. Only
contradiction and staleness can be converted into a new open advisory Finding, so outcome evidence
creates review work without rewriting trusted knowledge. The contract is independently exercised
through Hunch Memory's store-scoped issuance proof before that service enables its intake capability.

### Infection evidence is signed and the next validation is blind

The pinned Infection audit now has one content-bound final receipt covering the real ADR corpus,
PHP graph, retrieval order, behavioral probes, Git-history participation, and explicit remaining
limitations. The 13-record corpus is human-signed, all 10 live imported ADRs carry hash-bound human
approval, and the 3 historical records remain historical. Corpus templates are also excluded
without the former false "malformed filename" warning.

The roadmap now requires the next Infection checkpoint to run on a fresh real Issue/PR whose target
and expected answer were not used to build the feature. This separates implementation fixtures from
transfer evidence and prevents a polished replay from being presented as independent validation.

## 1.20.0-rc.4 — 2026-08-27

### PHP repositories enter the production graph

PHP now uses the existing native Tree-sitter graph pipeline instead of a parallel index. Hunch
extracts namespaces, classes, interfaces, traits, enums, functions and methods; resolves safe
Composer PSR-4 identities, namespace imports, includes, conservative calls and type relationships;
and reports per-language eligible, parsed and skipped coverage. Type relationships now participate
in path and impact queries, whose bounded BFS avoids the exponential simple-path enumeration exposed
by Infection's 45,792-edge graph. The correction-source scan also includes production PHP while
keeping exact-owner claims disabled.

Pinned acceptance receipts cover Infection (1,822/1,823 PHP files parsed, with one tracked external
symlink rejected) and Composer (622/622), including graph behavior and explicit uncertainty.

### ADR import preserves corpus lifecycle and provenance

ADR import now handles nested Markdown sections, safe `@` filenames, reference links, prose
alternatives and explicit successor references without confusing issue numbers for ADRs. Corpus
templates are excluded, source bytes and first-introduction commits are recorded, and successor
dates close historical validity windows deterministically. The complete 13-record Infection receipt
is checked in and intentionally remains pending human sign-off.

Imported live ADRs now enter the graph as advisory memory and surface as plain approve/decline
questions during normal assistant sessions, one at a time. The answer is bound to both the exact
source bytes and the complete mapped decision meaning: approve adds human-confirmed authority,
decline records review while keeping the memory advisory, silence changes nothing, and changed
source or importer semantics reopen the question. CLI and MCP use the same review state.

## 1.20.0-rc.3 — 2026-08-27

### Exact graph snapshots no longer rewrite dense indexes once per record

Snapshot producers can now replace one routed capture kind in a validated bulk operation while
preserving Hunch's single-home collision rules. This removes quadratic JSON work for array-backed
symbols and edges without weakening immutable-source scanning, atomic writes, shared-store routing,
or fail-closed currentness. On the 667-file ORC production tree, the Hunch Memory pilot derived and
persisted 5,247 symbols plus 16,051 edges in 28.1 seconds locally; the previous production path
spent about 55 minutes repeatedly rewriting those arrays.

## 1.20.0-rc.2 — 2026-08-27

### The release candidate reports what actually happened

When the selected synthesis provider exits successfully without returning a draft, Hunch can fall
back to its deterministic local synthesis. The result now names that fallback as the provider that
actually produced the draft instead of incorrectly crediting the silent provider. The release also
removes a dependency-audit exception automatically once its formerly vulnerable package is no
longer present, so an obsolete allowlist cannot linger unnoticed.

The reviewed engineering-landscape transport introduced in rc.1 is otherwise unchanged.

## 1.20.0-rc.1 — 2026-08-26

### Reviewed engineering landscapes become a transportable contract

Hunch can now discover bounded, credential-free landscape candidates from an exact Git revision,
show them for review, and adopt only an explicit human-confirmed fragment. Replaying the same
fragment is idempotent; changed content requires a new review; candidate, stale and retired records
never become delivery authority. Reuse compares the complete reviewed record with the
candidate-derived value, so copied review metadata cannot hide changed resource bytes.
Bounded selection now reserves a reviewed repository-root slot when one exists and records the
displaced task match as an omission, allowing consumers to bind source identity without increasing
the selection cap. The later hard token budget remains authoritative and may still omit items.

`hunch.delivery-envelope/1` now carries a deterministic, token-budgeted
`hunch.landscape-fragment/1` with exact resources, relationships, review/discovery provenance,
currentness and a content-addressed `hdr_*` receipt. The exported validator recomputes the native
receipt and fragment hashes and rejects altered scope, ranks, selections, omissions, evidence or
budget accounting. It also proves a unique one-to-one mapping from every landscape record to its
exact delivery rank, reason, provenance status and token charge. CLI and MCP review/adopt surfaces
use the same contract.

This release candidate is the first package version that Hunch Memory can feature-detect for the
reviewed landscape transport. Hunch still owns durable reviewed structure; Memory only transports
one authenticated store's native envelope; ORC/Nuryel validates and freezes it before use. No layer
may turn discovery candidates or provider prose into authority.

## 1.19.0 — 2026-08-26

### The release evidence is visible where people install

The GitHub and npm README now put the preregistered correction-search results near the install path:
changed-declaration coverage moved from 3/12 to 6/12, correct-file coverage from 8/12 to 10/12,
and the progressive plan retained the same five hits while inspecting 41.9% fewer declarations.
The copy keeps the evidence boundary explicit: these are narrow transfer results, evidence remains
annotation-only, and Hunch does not claim universal 2× accuracy or an exact correction owner.

The public site now carries the same measured release card, the stable installation path, and
localized v1.19 release/changelog surfaces. Version 1.19.0 promotes the tested rc.1 implementation
to npm's `latest` channel without changing its frozen algorithms or experiment receipts.

## 1.19.0-rc.1 — 2026-08-25

### Evidence-bounded correction search

`hunch shortlist` now preserves its flat top five while adding repository-adaptive correction-stage
ranking, file-anchored semantic declaration families, and a bounded progressive inspection queue.
On a preregistered 12-case transfer, the supplemental cluster view found 6/12 changed declarations
versus 3/12 for the flat shortlist (+25 percentage points) and raised correct-file coverage from
8/12 to 10/12. On a separate 12-case transfer, the progressive queue retained all 5 full-cluster
hits with zero losses while reducing mean inspection from 18.9 declarations to 11 (41.9% less).

`hunch evidence-map` compiles authenticated red/green probe, execution, and intervention receipts
into a read-only map. Fresh transfers did not establish execution or intervention influence as a
reliable exact-owner signal, so evidence remains annotation-only: it cannot reorder the shortlist,
and exact-owner and per-case confidence output remain disabled. The preregistrations, frozen
predictions, positive receipts, and rejected follow-ups are retained under `bench/external/results`.

### Reasoning that must meet evidence

Delivery now abstains from low-confidence or task-irrelevant memory and emits at most two testable
hypotheses. The agent pipeline can compile bounded executable obligations across runtime, static,
serialization, and compatibility contracts, normalize tool outcomes, require a real pre-edit
baseline, and track proof closure after edits. These controls fail open when no valid proof plan is
provided and do not turn advisory memory into blocking authority.

## 1.18.1 — 2026-08-22

### Deprecated ADRs no longer invent successors

`hunch import-adr` now distinguishes a bare `deprecated` lifecycle from an explicit replacement.
A named successor still closes the decision window; without one, Hunch keeps the imported record
visible as advisory accepted memory, preserves the raw lifecycle in provenance, and emits a warning
asking for an explicit successor or rejection instead of silently fabricating history.

## 1.18.0 — 2026-08-22

### YAML and Helm enter the graph

YAML anchors are now symbols and aliases are reference edges, so configuration dependencies
participate in blast radius without pretending to be function calls. Helm helper definitions and
`include` / `template` uses are extracted only inside the nearest `Chart.yaml` scope; duplicate
names in separate charts and unrelated languages do not fabricate edges. `.tpl` files and
Helm/Jinja-templated YAML remain indexable before rendering, while invalid ordinary YAML still
fails closed and GitHub Actions `${{ }}` expressions are not mistaken for Helm syntax.

The merge also fixes two graph-integrity seams surfaced by YAML: root-level files now belong to an
exact-file component instead of a repository-wide `./**` glob, and call attribution keys on a
symbol's stable array position so overlapping synthetic YAML/Helm symbols cannot collapse at byte
zero. YAML and Helm support was contributed by Oliver Sampson and reconciled with the current Go,
HLG, and schema-generation contracts before release.

### A repository becomes a versioned landscape fragment

The Engineering Landscape Graph begins as an additive view over the existing source of truth.
Stable kind-qualified resource IDs, directional relationship IDs, lifecycle, credential-free
locators, provenance/currentness, forward migration, and rebuildable SQLite projections now have
an executable contract. The first bounded discovery slice reads an exact Git revision and emits
reviewable package/workspace and canonical Git-remote candidates with field-level evidence; it
does not write authority, retain credentials or local paths, or make Hunch an orchestrator.

Retrieval benchmark floors now run against a disposable fresh graph, publication vocabulary caches
are store-scoped, and effective private/team memory routing is explicit in diagnostics. These close
silent-regression and cross-repository contamination paths without changing enforcement authority.

## 1.17.0 — 2026-08-18

### The projection notices when it rots

Exported ADR corpora can now adopt a content-hash manifest and participate in normal drift and
healing. Hunch distinguishes a decision that moved (`madr-stale`), a generated file changed by a
human (`madr-edited`), and an artifact whose public decision disappeared (`madr-orphan`), with a
separate repair path for each. Adopted corpora refresh during post-commit sync, and edit protection
is keyed by content so renumbering cannot erase a hand edit.

Retrieval also gives recorded intent a bounded ranking prior over code symbols that only share the
query vocabulary. The prior improved the curated Recall@10 result from 70% to 90% and remains
reversible with `HUNCH_MEMORY_PRIOR_SHIFT=0`.

## 1.16.0 — 2026-08-18

### The MADR bridge

`hunch import-adr` deterministically imports MADR and Nygard corpora into the graph, preserving
accepted, superseded, and rejected semantics without duplicating records on rerun. `hunch
export-adr` emits a standard, regenerable MADR projection with Backstage metadata, refuses to
overwrite a hand-written corpus, and excludes private-overlay records. The graph remains the source
of truth.

## 1.15.0 — 2026-08-18

### Go support

Go repositories now enter the same symbol and dependency graph as TypeScript and Python through the
language registry. Structs, interfaces, type specifications, aliases, imports, and package-qualified
calls are indexed conservatively: module paths resolve exact package directories, standard-library
calls are filtered, and ambiguous edges are not invented. Prebuilt grammar support ships across the
supported platform matrix.

## 1.14.0 — 2026-08-18

### Context arrives with its graph neighborhood

Context delivery can walk a bounded, deterministic graph neighborhood with depth decay, node and
token caps, and external-hub exclusion. This raised the curated Recall@10 result from 81.8% to
90.9% without changing the response contract. The release also excludes retired constraints from
grounding, resolves MCP auto-commit roots per call, and fixes unstaged-only release-gate drift.

## 1.13.1 — 2026-08-15

### MCP delivery receipts arrive as structured data

`hunch_context` now advertises an MCP output schema and returns the canonical delivery envelope in
`structuredContent` while preserving the existing text response for older clients. Orchestrators
can consume exact delivered and omitted record IDs, rank, delivery reason, provenance/currentness,
token cost, budget use and blocking overflow without parsing prose.

Every record actually returned by MCP is also appended to the same machine-local served ledger used
by agent hooks. Budget-omitted or stale records are never receipted, and receipt persistence remains
best-effort so telemetry failure cannot block context delivery.

## 1.13.0 — 2026-08-13

### Truthful, provenance-checked delivery envelopes

CLI, MCP, and edit-hook context now share a deterministic ranked headline envelope. It checks
record anchors and decision-commit reachability, withholds definitively stale records, packs to the
requested context budget, and returns the exact delivered IDs used by the machine-local receipt
ledger. Active blocking constraints are never silently discarded when a requested budget is too
small; the envelope reports that exceptional overflow explicitly.

Edit-hook decision, documentation, and retired-code grounding now competes inside that same hard
budget instead of overflowing after packing. Delivery receipts add rank, delivery reason,
provenance/currentness status, and estimated token cost, with an additive migration for existing
machine-local ledgers and the fields available from `hunch served --json`.

## 1.12.2 — 2026-08-12

### Grounding that reliably reaches Windows agents

Generated hook commands now execute correctly under PowerShell, cmd, and sh, and rerunning
`hunch init` replaces the broken form instead of installing a duplicate. Architectural Conformance
also tolerates the exact tagged-template escape shape that TypeScript accepts but the underlying
grammar rejects, without weakening fail-closed handling for real syntax errors.

The release gate now includes public-only memory drift, so it verifies the same graph and grounding
a fresh contributor clone receives. See the [complete release history](https://hunch-pi.vercel.app/changelog)
for v1.12.1 delivery receipts and v1.12.0 delegation/compaction coverage.

## 1.9.0 — 2026-07-22

### One living engineering memory for the whole team

Hunch can now connect a codebase to a dedicated private Git repository that holds the team's
decisions, corrections, constraints, policies, and proofs. Commit the generated
`.hunch/team.json` pointer once; a fresh clone running `hunch init` validates and connects its own
ignored local memory clone, and connected MCP sessions refresh at tool-request boundaries.

Shared captures commit and synchronize automatically by default. Concurrent structured records
merge deterministically, public-only checks exclude the shared graph, and strict checks refuse to
pass on a stale or unverified team route. Corrections can be upgraded into proof-backed proposals,
but those correction proposals remain mechanically non-activatable until source-currentness safety
lands. Other policy types still gain no authority unless a human explicitly accepts them.

Release artifacts now hold the same line. The package and VS Code extension are tested before any
publisher receives credentials, the exact tested bytes are carried forward unchanged, and the
registries are checked after publication. npm releases prove the tagged source across supported
runtimes and Windows/macOS Matrix safety; VS Code v0.17.2 publishes the same VSIX to the Visual
Studio Marketplace and Open VSX.

To move an existing code repository's public Hunch records into the shared store, use
`hunch shared --repo <separate-private-memory-repo> --migrate`. Omit `--migrate` for a new setup.
Upgrade with `npm i -g @davesheffer/hunch@1.9.0`; the documented rollback keeps the memory
repository intact while disabling enforcement and automatic publication before pinning a previous
package version.

The complete release history remains available on the
[Hunch changelog](https://hunch-pi.vercel.app/changelog).
