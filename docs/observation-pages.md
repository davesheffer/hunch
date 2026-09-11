# Reading older observations

The capability `nuryel.observation-pages/1` extends the existing read verb over MCP,
HTTP and the typed client. Default reads still return at most 64 observations and
`observed_truncated`; no old caller receives a larger response.

For an explicit single-partition subject read, pass `observed_page: {}` (prefer
`facets: ["derived"]`). The response's `state_of_record.observed_page` carries
`total`, `snapshot_hash` and `next_cursor`. Pass that cursor as
`observed_page: {cursor: next_cursor}` until it is null. Each page holds at most 64
observations, newest first with id as the tie-breaker, with their original records
and hashes. Linked observations follow the same existing one-hop eligibility rules.

The snapshot fingerprint covers the requested scope, subject, authorized observation
membership and complete records. A changed, removed, invalidated or newly added
observation between pages produces a `conflict`; restart from the first page. A
cursor never grants access. Grants are checked first, scope is exact, cursors for
another subject are refused, and unions (`scopes`) are refused for paginated reads.
Each partition needs its own cursor. No source bodies or server-side sessions are
retained for pagination. Fingerprinting scans the eligible observations on every
explicit page read; ordinary reads avoid that additional work.

A page is a slice of unknown-currentness observations, not proof of current facts.
Report incomplete coverage whenever a next cursor remains. Pagination does not
automatically invalidate anything or add model calls.
