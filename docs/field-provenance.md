# Sources for individual fields and passages

Shipped in Hunch 1.33.0 as optional writer-supplied citations for exact fields and passages.
Negotiate `nuryel.field-provenance/1` and upgrade every shared reader before writing citations.
They do not establish truth or freshness; authority and invalidation remain record-wide.

A derived summary already lists its dependencies. Optional `field_provenance` entries say
which of those sources the writer used for an exact JSON value or passage. Readers can inspect
those links in `/operator`, in MCP read text, or in the complete structured record returned by
HTTP, MCP and the TypeScript client. Hunch never fetches a cited source.

For a summary whose `content` is `'{"visit":{"date":"2026-09-20"}}'`:

```ts
const dependency = { kind: 'external', ref: eventRef };
const record = {
  // Other required derived-record fields omitted here.
  content: '{"visit":{"date":"2026-09-20"}}',
  dependencies: [dependency],
  field_provenance: [{
    selector: { kind: 'json_pointer', path: '/visit/date' },
    value_hash: stateHash('2026-09-20'),
    dependency_hashes: [stateHash(dependency)],
  }],
};
```

Use the contract's `stateHash` for both hashes. A dependency hash identifies the complete
existing dependency, including its source revision; it is not an array index. Reordering the
dependencies does not redirect a citation.

For plain text, use `{kind:'text', start:2, end:8}` to select `Ready.` in `😀 Ready. Ready.`.
Offsets count Unicode code points, starting at zero, with an exclusive end. They are neither
UTF-8 byte offsets nor JavaScript UTF-16 offsets. No normalization or substring search occurs.
Hash the selected text with `stateHash('Ready.')`.

JSON pointers use `/` between keys, `~1` for a literal slash and `~0` for a literal tilde.
Only existing own scalar values are valid: strings, finite numbers, booleans and null.
Arrays require canonical zero-based indexes. Objects, arrays, inherited properties and missing
fields are refused. An empty pointer selects the root only when the JSON root is a scalar.

A record may have 1–128 citations, each with 1–256 distinct dependency hashes. Duplicate
selectors are refused; combine their sources in one citation. Every referenced dependency must
exist in the record. Changing a selected value requires a new value hash. Invalid mappings are
refused on writes and rejected by the record loader, including direct file edits.

These are **writer-supplied citations**, not proof that a source supports a claim. They do not
establish truth, freshness, full field coverage or human authority. Missing annotations mean
there is no field mapping, not that there are no sources. Human correction protection and
invalidation still apply to the whole record. Citation-only edits change the record revision,
use normal idempotency/version guards, and remain in the ledger.

## Upgrade and compatibility

Existing records remain unchanged: the optional field has no default, and legacy canonical
hashes and identities keep their encoding. New citations travel with the derived record in
reads, exact record lookup, write receipts and replay.

**Upgrade every reader of a shared partition before writing citations.** Older strict derived
schemas reject records containing this new field. A capability on one server does not prove
that another reader is upgraded. Delay citation writes while mixed versions share the same
files. Do not delete annotations to force a downgrade: that changes recorded evidence and its
revision. Back up the partition and use normal reviewed writes if a rollback requires changes.

The operator view displays every citation and source without navigation to external locators.
MCP text shows at most eight citations and four sources per citation, with bounded excerpts;
the structured record retains the full mapping and explicitly signals additional entries.

Verification: `test/field-provenance.test.ts`, the HTTP and MCP suites, and
`tooling/verify-operator-view.mjs` cover persistence, exact selectors, source reordering,
Unicode, false/zero/null, hostile display text, authority and transport round trips.
