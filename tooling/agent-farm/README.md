# Agent farm

A demo and measurement harness for Hunch as the deterministic state layer: many probabilistic
agents, one drawer, zero contradictions.

It starts `hunch serve` in-process on `127.0.0.1:0` inside a temp directory, mints one principal
per agent, and runs a scripted "day" with real concurrency over the `nuryel.state/1` HTTP
binding. Nothing outside the temp directory is touched; no live service is involved.

## Run

```bash
npm run build                                   # lib.mjs imports from dist/, never src/
node tooling/agent-farm/farm.mjs --agents 3 --customers 5 --out /tmp/farm
npx tsx --test test/agent-farm.test.ts          # the same run, asserted (skips if dist/ is missing)
```

Exit code is 1 when `contradictions > 0` or the organization ledger is not contiguous.

## The cast

| principal | kind | grants | does |
| --- | --- | --- | --- |
| `sofia-1..K` | agent | own `user/<name>` + `organization/<org>` | works every customer; reads before it writes |
| `orc` | service | organization | audits the org drawer after the day |
| `engineer` | agent | organization + `repository/<org>-app` | closes every incident through the chain; replays the ledger from 0 and fetches every record it names |

## The day

For each customer (`customer:<id>`), rotated per sofia so they collide at different times:

1. **read** the org drawer; if a current derived summary exists whose id the agent can recompute
   (`derivedId` of the same subject + transform + dependencies) it is **reused**, otherwise the
   summary is computed and **written** (dependency: a credential-free CRM event ref with a
   content hash).
2. **write** the shared commitment (title/owner/due) under a shared idempotency key: the second
   sofia gets `replayed`, never a duplicate.
3. **write** a verified receipt for the executed `add_comment` action on the CRM event.
4. **write** a personal prep note into its own user drawer.

Every other customer also raises an **incident** (an `incident:` entity with the CRM pointer) and
the **escalation** engineering owes, under shared keys — every sofia that notices it replays the
first writer's record.

Midday, **the chain** (roadmap Gate 4), driven by the engineer for every incident:

1. **union read** of the subject over the drawer and the repository partition — the escalation
   must be in force;
2. **decision** written to `repository/<org>-app` (the decision lives with the code);
3. **change proof** — a deterministic pointer by proof id + content hash (the farm has no diff to
   seal; production uses `hunch_change_proof`'s ref, the same shape);
4. **`shipped` receipt** into the drawer, `rests_on` the decision (with its partition), the proof
   and the escalation, `invalidates` the customer subject;
5. **closure**: the escalation written again as `done`, `closed_by` that receipt — updated in place.

Deliberate refusals, once: a receipt resting on a stale escalation hash (`409 conflict`, "re-read
it and rest on what is current") and a closure naming a receipt that never happened (`409
conflict`, "write the receipt first").

Afternoon: every sofia re-reads every customer (reuse, no recompute) and the in-force
commitments each agent sees are compared across agents with the same grants. For an incident
customer each sofia must **see the closure**: the escalation gone from `in_force`, the receipt and
the closed escalation in `done`, the receipt in `invalidated_by`.

Deliberate refusals, once per sofia: reading another sofia's user drawer (`403 outside-grants`),
reusing an idempotency key with a changed payload (`409 idempotency`, detail names the differing
fields), and choosing a receipt id (`422 identity`).

## The report

`<out>/farm-report.json` and a plain-text table on stdout:

- `writes` — `created / updated / replayed / superseded` outcomes
- `durability` — by value; every partition is a git repository, so writes report `committed`
- `refusals` — by problem code
- `reads`, `reuse`, `recompute`, `reuse_rate`
- `contradictions` — more than one current derived summary per subject in the org drawer, two
  agents with the same grants seeing different in-force commitments, or a chain link the orc
  could not verify; must be 0
- `replay` — `partitions`, `ok`, `records_verified`, `divergences`: every served partition is
  replayed at the end (`verifyReplay`, the same check as `hunch serve replay`): the ledger folded
  into the state it implies must match the records on file hash for hash; a divergence is a problem
- `chain` — `incidents`, `escalations_seen_by_engineer`, `decisions`, `shipped`, `closed`,
  `closures_seen_by_sofias` (incidents × sofias), `links_verified_by_orc` (decision ref with its
  repository partition, proof ref, escalation ref, `closed_by`, receipt in `done` — all five per
  incident), `closure_causes` (the ledger's closure event is caused by the receipt),
  `denied_to_orc` (the orc, granted the drawer only, is refused the repository partition)
- `ledger` — `head_seq`, contiguity (`assertChangeSequence` from 0), records fetched by id
- `durations_ms` — total and per-sofia average
- `problems` — every mismatch the orc or engineer found (empty on a clean run)
