# Source-backed observations from any agent

An agent that learns a relevant fact during its task can persist it with `nuryel_capture`
or `nuryel_capture_batch`. The initiating agent selects the assertions using the source
and context it already holds. No second model, embedding service or provider switch runs.

Selection is per assertion. Split mixed passages, preserve qualifications and exceptions,
and omit chatter, transient output and unsupported inference. Every assertion needs a
concrete future-use reason and an exact supporting excerpt. The deterministic boundary
checks quote fidelity, source hash, grants and identity; it cannot prove semantic relevance
or entailment. A known passage is never a reason to discard a new detail within it.

The shared contract exposes:

- MCP: `nuryel_capture` and `nuryel_capture_batch`.
- HTTP: `POST /nuryel/v1/capture` and `POST /nuryel/v1/capture-batch`.
- Typed client: `capture` and `captureBatch`; HTTP uses the bearer token's principal.
- Capabilities: `nuryel.state.capture/1` and `nuryel.state.capture-batch/1`.

Batch input carries `principal`, `scope`, up to 8 `sources` (`ref`, `source_text`), and up
to 32 `observations`. Each observation has `subject`, `statement`, `relevance: {use, reason}`
and `evidence: [{source: <zero-based source index>, excerpt}]`. Supported uses are decision,
constraint, preference, operational_fact and ongoing_issue. Source text is transient: only
the assertion, relevance reason, selected excerpts and external pointers/hashes persist.
Shape/authorization errors reject the request; an unsupported excerpt, wrong source hash or
missing source index refuses that item. Each indexed result reports saved/replayed or refused.
Inspect all results; a duplicate or refused item does not suppress subsequent valid facts.

Capture creates ordinary `nuryel.derived/1` records with `state: unknown` and a reserved
`agent-capture/1:<digest>` transform. `state_of_record.observed` exposes up to 64 open unknown
observations, newest first; `observed_truncated` explicitly indicates older records. Fetch
needed history before concluding a fact is absent. These records are historical observations;
they are never mixed into `current`, receipts or commitments. Current summaries remain the
responsibility of a writer that revalidates dependencies and publishes invalidation events.
Capture records cannot be promoted in place to current summaries.

The digest covers scope, subject, normalized assertion and the set of source identities and
supporting excerpts. Writer, read time and edits outside the excerpt do not create duplicates.
A replay retains the first record's author, source snapshot, provenance and lifecycle. Stale
or human-reviewed records are not revived. Changed assertions or excerpts survive; different
wording is deliberately not fuzzy-merged because that could erase a material qualification.
Identity and content integrity are also checked through ordinary `nuryel_write`.

The fast path uses deterministic SHA-256 and direct reads of existing JSON record files,
with the store's path checks and migration before validation. Duplicate lookup does not
enumerate the drawer. Sources are hashed once per batch, the existing partition lock covers
lookup plus write, and the existing SQLite search index is rebuilt once for changed batches.
The already validated change ledger is reused only within that lock; every new event and
idempotency entry is validated and each append is still written atomically. Duplicate-only
batches perform no record, ledger, index or Git writes. There is no new service, database or
background model. New writes still serialize the existing ledger and refresh the index, so
total write cost is not constant in drawer size. Batch results are per item, not an all-or-nothing
transaction. Unexpected I/O failures propagate; retry and verify returned records.

Run `npx tsx tooling/capture-benchmark.ts <report.json>` for actual local create, replay and
subject-read measurements at several drawer sizes. It uses temporary fixture data, excludes
Git/network/model and MCP startup time, and reports the method alongside timings. Regression
coverage includes new facts inside known passages, exact quotes, cross-provider deduplication,
same-excerpt distinct assertions, stale/human records, corrupt files, explicit truncation,
partial batch refusals and simultaneous MCP/HTTP callers.
