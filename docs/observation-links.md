# One observation, several subjects

`nuryel.observation-links/1` is an additive capability of the existing state contract.
Any agent can use `nuryel_write` (or HTTP `/nuryel/v1/write`) to write a relationship:

```json
{
  "facet": "relationships",
  "record": {
    "schema": "nuryel.relationship/1",
    "from": "<captured observation nds_ id>",
    "to": "customer:Site:7",
    "type": "observation_about",
    "observation_hash": "<record_hash returned by capture/read>",
    "lifecycle": "active",
    "reason": "CRM explicitly assigns event 42 to Site:7.",
    "evidence": {
      "system": "crm", "object_type": "event", "object_key": "42",
      "observed_at": "2026-09-10T12:00:00Z",
      "content_hash": "<hash of the explicit association evidence actually read>"
    },
    "provenance": {"source": "agent_recorded", "confidence": 1, "evidence": ["Explicit CRM location association"]}
  },
  "idempotency_key": "<unique request key>"
}
```

Supply your own principal and granted scope as usual. The server derives the relationship
id. It checks that the captured observation exists in the same partition, is still unknown
and open, and matches the supplied hash. A link requires hashed external evidence and a
reason; the agent owns whether that evidence actually supports the association. Names or
semantic similarity alone are not proof. Hunch does not fetch CRM or select a model.

Reading the target subject projects the original observation into `observed`, with its
original id, source subject, author, excerpts, dependencies and hash. There is no copied
derived record, entity merge, transitive traversal, or imported receipt/commitment. An
observation without a customer remains useful under its original source or other subject.
The same write works for a project, incident or workflow, not just a customer.

Read cost is linear in the existing relationship and derived collections, with a Map/Set
join and hashes computed only for candidate observations. No database or model is added.
An identical association ignores evidence read time and preserves the original record;
this replay avoids index/Git work. Ordinary request-key collision checks still apply.

To unlink, read the relationship and write it back with `lifecycle: retired`, preferably
with `expected_version` equal to its record hash. The source observation stays intact.
Reactivation requires an explicit `expected_version`; routine recapture cannot revive it.
If an observation becomes stale, expires, or changes hash, it stops projecting through its
old links. Independent observations remain visible. This is propagation of recorded
invalidation, not an automatic semantic check of external source changes.

Reads retain the existing 64-observation bound and `observed_truncated`. Relationship
delivery is capped at the remaining 256 current-reference slots and explicitly reports
`relationships_truncated`. A truncated read cannot establish absence or authorize bulk
unlink; use ledger history and exact record retrieval for the missing relationships.
