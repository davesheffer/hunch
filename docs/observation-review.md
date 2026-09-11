# Selective observation withdrawal

Capability `nuryel.observation-review/1` extends the existing `nuryel_capture_batch`
MCP tool, HTTP capture-batch route and typed client. It adds optional `reviews`:

```json
{
  "sources": [{"ref": "<external source pointer>", "source_text": "<text actually read>"}],
  "observations": [],
  "reviews": [{
    "record_id": "<original nds_ id>",
    "expected_hash": "<record hash actually read>",
    "reason": "The source explicitly replaces Friday closure with Friday opening.",
    "evidence": [{"source": 0, "excerpt": "Office now opens Friday."}]
  }]
}
```

Use the usual principal and scope. Sources retain the capture contract's external-ref
shape; the placeholder above is abbreviated. A batch may carry up to 32 observations,
32 reviews and 8 shared sources. At least one observation or review is required.

The initiating agent selects a particular assertion explicitly contradicted or withdrawn
by a source it has read. A changed hash, missing excerpt, truncated history, uncertainty
or new irrelevant text is never enough to infer that a fact is obsolete. The same agent
and existing answer context perform selection; Hunch does not launch a provider or fetch
external sources. Quote fidelity and pointer checks do not prove semantic contradiction.

Hunch checks grants before retrieval, the observation's scope and capture identity, its
expected hash, and exact supporting excerpts from changed sources already named in that
observation's dependencies. Unrelated or unchanged sources cannot authorize withdrawal.
Human-confirmed records retain the existing write guard. New review metadata must name
the actual initiating principal; original capture authorship is preserved.

Accepted reviews write only that record stale. They retain its original statement,
excerpts, dependencies and provenance, and add reviewer, time, previous hash, reason and
fresh supporting excerpts. Full source bodies remain transient. The ledger emits an
`invalidated` event with the changed external pointer. Existing observation links stop
projecting the stale record; independent observations remain visible. Stale history is
available through exact record retrieval, not presented as an empty historical record.

Reviews run before captures in the same partition lock. Each has an indexed result under
`reviews`, separate from ordinary capture `results`. Refusals do not hide valid siblings.
One index rebuild and flush covers the batch. Exact review retries preserve the original
review and never revive a stale fact. Retained observations stay unknown; this is not a
claim that their present status was verified. Cross-source reconciliation and autonomous
background semantic sweeps are outside this path.
