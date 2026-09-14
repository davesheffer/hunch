# Explicit conventions for people and teams

Shipped in Hunch 1.33.0 as the additive `nuryel.convention/1` facet. A convention records a
preference or working rule for a user, team, organization or repository. For example:
“Use concise status updates.” Each record keeps its scope, sources, review status and next
review date. It is advisory: accepting a convention records human review and does not activate
a policy or override repository rules.

Repository Project DNA remains a separate observation of a particular Git revision. Explicit
conventions appear alongside it. No organization/team/user hierarchy silently picks a winner.
When authorized records give different values for the same key, reads flag a conflict. Resolve
that disagreement with the relevant people before applying a preference.

## Record and write

Negotiate `nuryel.convention/1`. Use the existing `write` verb with `facet: "conventions"`:

```json
{
  "scope": {"kind": "team", "id": "engineering"},
  "facet": "conventions",
  "idempotency_key": "status-style-handbook-v1",
  "record": {
    "schema": "nuryel.convention/1",
    "key": "communication.status",
    "value": "Use concise status updates.",
    "status": "proposed",
    "sources": [{"kind": "external", "ref": {
      "system": "handbook", "object_type": "rule", "object_key": "status-style",
      "version": "1", "observed_at": "2026-09-13T10:00:00Z"
    }}],
    "valid_from": "2026-09-13T10:00:00Z",
    "valid_to": null,
    "review_by": "2026-12-13T10:00:00Z",
    "provenance": {"source": "agent_recorded", "confidence": 0.8,
      "evidence": ["Handbook status-style rule, version 1"]}
  }
}
```

An agent can propose a convention. Only an authenticated human principal can accept it with
`human_confirmed` provenance. An agent cannot overwrite or supersede a human-confirmed record.
HTTP identity comes from credentials; a caller-supplied principal cannot claim a different role.
Local stdio MCP remains a trusted local interface.

The ID derives from scope, key, value and the sorted source hashes. Repeated writes with the
same identity/key replay. Every changed record requires `expected_version`. A different value
or source creates a new identity: use `supersedes` and the predecessor's exact `record_hash` as
`expected_version`. Supersession preserves scope/key, closes the old window and retains history.
Only one accepted, open convention may exist per scope/key; proposed alternatives remain visible.
Withdraw a record with `status: "withdrawn"` and its expected version.

Sources must be exact record hashes or external pointers with a version/content hash. A schema
fingerprint alone cannot support a convention. Held record sources are checked on write; reads
mark changed/missing record sources, future validity and overdue reviews as stale. External
pointers are not refetched: `currentness: "recorded"` means the recorded review is still within
its window, not that Hunch independently verified the external source today.

## Read and inspect

`read` returns optional `conventions` alongside the ordinary state and delivery envelope,
even for task-only reads. The selected records are in `records`; each convention item carries
its exact reference, key, currentness and conflict flag. Read `scopes` to combine authorized
partitions. Denied partitions and per-record visibility are enforced before selection and
conflict calculation. A conflict flag describes only the authorized records examined.

State reads return at most 16 conventions and 16 KiB of convention record bodies, ordered by
key, scope and ID. `truncated: true` means more records exist and conflict coverage is incomplete.
The ordinary context brief uses its existing token budget with at most eight convention
supplements. Exact records and superseded records remain available through `records`; changes
use the existing subscription stream. The operator view shows the conventions and their sources.

Old servers do not advertise the new capability and reject the new facet. Upgrade readers before
using conventions; older readers may omit this additive record kind. Conventions never supply
policy authority, so an omitted convention cannot authorize an action. Restricted records retain
the separate [visibility upgrade gate](record-visibility.md).
