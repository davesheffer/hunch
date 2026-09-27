# Hunch Verified Work Reuse — Feasibility and End-to-End Plan

**Status:** design and feasibility plan, not implemented or benchmarked
**Baseline inspected:** davesheffer/hunch main at `5ff071a4997a2275d81db118c81425da5c572d94` (Hunch 1.42.0)
**Owner goal:** reduce repeated agent investigation time, model/tool usage and uncertainty without weakening verification.
**Branch role:** separate design branch. Do not mix it with the context-efficiency pilot's implementation branch or its measured worktrees.

## 1. Decision in one paragraph

Build a *small, advisory verified-work reuse layer* on top of Hunch's existing task records. It should compile a bounded prior-work packet only from stored evidence, evaluate whether that evidence is still relevant to today's code, and offer either an exact candidate, an adaptation hypothesis or abstention. It must never automatically apply a patch, skip the current validator, or claim a past passing check proves a current solution. Run the existing no-Hunch/current-Hunch pilot first; then measure the added value against **current Hunch**, not merely against no Hunch. Do not call this a unique invention or promise savings until the comparative experiment succeeds.

## 2. Existing implementation: reuse, do not duplicate

| Existing seam | Actual behavior | Gap for this slice |
| --- | --- | --- |
| `src/core/taskRecord.ts`, `TaskRecordSchema` | Finished observed tasks save title, touched files, lesson references, bounded application actions, checks with label/state/exit code, conformance, supersession, and a bounded source snapshot | No guaranteed problem/root cause/fix narrative, per-file proof, or durable check argv in the graph record |
| `src/core/taskRanking.ts` and `taskQuery.ts` | Candidate gate and weighted ranking based on files, shared records, outcomes and recency; stale missing anchors and superseded records are filtered | A high rank does not prove the old result applies now |
| `src/core/taskDelivery.ts` | Bounded RECENT TASKS advisory lines, usually title and summary; the code says a task line is never an instruction to repeat or skip | No explicit reusable outcome packet or safe currentness decision |
| `src/core/delivery.ts` | Hard budget and supplements | New packet must compete within the existing envelope, not add unbounded tokens |
| `src/core/taskReportEvidence.ts` | Local check tracks pre/post bounded source snapshots and limitations | Global snapshot is too coarse for specific-file reuse, omits external/ignored dependencies |
| `docs/task-reports.md` | Delivery, agent application and a passing check are distinct evidence types | No claim of causation or task-level time/cost savings |

Other `replay` modules in the repo refer to ledger or constitution determinism; do not treat their name as outcome reuse.

## 3. User-facing result

For a repeat issue, Hunch may deliver:

```text
PRIOR WORK (advisory)
Task: htask_... | relevant because same file and decision
Observed action: [verbatim bounded application action, if recorded]
Prior check: [label] passed at prior source snapshot
Currentness: changed / unknown / exact-candidate
Next step: inspect the changed dependency and run today's validator
Evidence: task ID, record hash, applicable file hashes, check evidence
```

An `exact-candidate` is *permission to consider a shortcut*, not proof the new task is complete. When no observed action exists, say so and offer the sparse historical record; never infer a fix from an issue title.

## 4. Feasibility gates before implementation

- [ ] Freeze main commit, current task schema, selection path, budget behavior and report semantics.
- [ ] Confirm the Gate A pilot and its no-Hunch/current-Hunch comparator are valid, or implement that measurement first. The pilot document is on branch `docs/context-efficiency-pilot5` at `docs/HUNCH-CONTEXT-EFFICIENCY-POC.md`.
- [ ] Inspect at least 20 existing task records **before choosing examples**. Record counts with passed checks, usable files, observed actions, accessible check evidence, and usable currentness signals. Include sparse/empty records and private-store availability constraints. No cherry-picking.
- [ ] Identify 3–5 candidate repeat-task pairs with prior evidence available before the new task; at least one changed-file case, one exact candidate and one abstention. If none qualifies, stop and report the missing data contract; do not fabricate outcomes.
- [ ] Determine whether the local report that contains check argv is still accessible. Its 90-day retention means it cannot be assumed durable. For v1, prior check *label* alone is display evidence and cannot authorize exact reuse.
- [ ] Fix per-file inputs and boundaries for the candidate. Record code file content hashes plus decision/rule record revisions, relevant config and dependency manifest hashes. If the dependency set cannot be bounded with evidence, currentness is `unknown`.
- [ ] Confirm the agent host can receive an opt-in bounded supplement and that the additional tokens, tool schemas and process overhead are measurable.

**Feasibility output:** an inventory table, 3–5 redacted candidate packets, a dependency/currentness coverage figure, token-size distribution, and a Go/Revise/Stop decision. If the source data is too sparse, first improve *future* task recording prospectively. Never retrofit old records with invented reasons.

## 5. Data contract

```ts
type ReuseMode = "exact-candidate" | "adapt" | "withhold";
interface WorkReusePacket {
  schema: "hunch.work-reuse/1";
  source_task_id: string;
  source_record_hash: string;
  mode: ReuseMode;
  reasons: string[];
  observed_action: string | null; // exact prior task application; agent-reported
  prior_checks: Array<{ label: string; state: string; exit_code: number | null }>;
  file_hashes: Record<string, string>; // measured for explicit relevant files
  dependency_revision_hashes: string[];
  currentness: "matching" | "changed" | "unknown";
  limitations: string[];
  token_estimate: number;
  packet_hash: string;
}
```

This packet is derived or cached locally and is not a new source of truth. Redact private evidence according to existing public/private homes. The original `TaskRecord` and check report remain authoritative for what was actually observed.

## 6. Currentness policy

1. Candidate selection uses the existing task ranker. Do not introduce a parallel vector index or RRF here.
2. **Withhold** for superseded tasks, no eligible structural relationship, missing relevant anchors, conflicting active blocking constraints, inaccessible provenance, or over-budget packets.
3. **Adapt** when relevant files or dependency revisions changed, a validator identity is unknown, or external/ignored dependencies matter but cannot be checked. State precisely what changed or is unknown.
4. **Exact-candidate** only when the relevant code and bounded dependencies match immutable hashes, relevant decision/rule revisions are current, a prior passing check exists, and a usable validator identity or exact prior command contract is recorded. Even then, run the current validator.
5. A hash mismatch is evidence of change, not proof the old insight is wrong. A hash match only covers declared inputs, not the whole world. Timeouts and unavailable checks cannot become passing evidence.

## 7. Delivery, authority and safety

- [ ] Compile one packet deterministically from the selected task; keep it inside the existing hard token budget.
- [ ] Prefer an opt-in delivery mode for the POC so current Hunch remains an unchanged comparison arm.
- [ ] Never suppress active blocking records to make room for a packet.
- [ ] Never execute commands from a stored task automatically. Pass any validator command through the existing explicit task verify runner and its process limits.
- [ ] Never auto-apply a fix, auto-merge, or reuse side-effecting operations.
- [ ] Treat task titles, issue text and agent-reported actions as untrusted content, not instructions to the harness.
- [ ] Link a delivery occurrence to the current task and later check through exact IDs/hashes. A later pass is correlation, not proof the packet caused it.
- [ ] If no safe packet fits, abstain with no extra reminder text.

## 8. Implementation sequence and exit checklist

### Stage 0 — feasibility inventory

- [ ] Run section 4 inventory and publish the factual report.
- [ ] Review privacy, retention and currentness limits.
- [ ] Go only if at least three evidence-bearing candidates and a measurable comparison path exist.

### Stage 1 — packet compiler, offline only

- [ ] Add pure deterministic eligibility, packet construction and token estimation near `src/core/taskDelivery.ts` (name files after actual repo conventions).
- [ ] Use existing TaskRecord, ranking and delivery supplement types; no schema migration for the first sparse packet.
- [ ] Add focused tests: missing action, failed/unknown check, supersession, missing anchor, conflicting constraint, changed file, incomplete dependency set, budget, private record, deterministic packet hash.
- [ ] Exit: fixtures produce exact-candidate/adapt/withhold without inventing data.

### Stage 2 — opt-in delivery and receipts

- [ ] Attach packet through `buildDeliveryEnvelope` using existing budget and abstention.
- [ ] Store compact task-bound receipt: packet hash, source task ID, mode, current task ID, delivery occurrence, later validation status/hash. No transcript or raw prompt.
- [ ] Exercise an unchanged current-Hunch control to check that the new path does not change it.
- [ ] Exit: one repeated task receives a bounded packet; changed inputs downgrade; no current validation means no success claim.

### Stage 3 — controlled comparison

- [ ] Use the same frozen issue cards, agent CLI/model, validator, timeout, repository revision per issue and input memory snapshot as Gate A.
- [ ] Compare **current Hunch** vs **current Hunch + opt-in work reuse** in fresh isolated sessions. Run at least two paired repetitions per issue, alternate order from a frozen seed, capture failures.
- [ ] Report task success/quality, total wall time, investigation tool calls and provider input/output tokens when actually available. Report supplement estimates separately; never double-count them in provider tokens.
- [ ] Inspect every invalid exact candidate and quality regression. Stop on an unsafe reuse case.
- [ ] Exit: issue-level raw observations, median/range for the small pilot, overhead and uncertainty clearly stated; no savings claim when measurements are incompatible.

### Stage 4 — durable rich outcome contract, only if needed

- [ ] If sparse packets fail to help, collect a prospective structured problem/cause/action/result/evidence summary at task finish.
- [ ] Mark each field as agent-reported, deterministic or human-confirmed; attach exact relevant-file hashes and validator argv/result evidence where safe.
- [ ] Migrate forward compatibly; old records remain readable and sparse. No backfilled fake summaries.
- [ ] Re-run Stage 3 before enabling by default.

## 9. Three outcome measures: time, money, peace of mind

Record these per task and aggregate only compatible observations. A smaller packet by itself is not a product outcome.

### Time

- [ ] Measure total spawn-through-validation wall time for the same quality outcome, plus investigation time or investigation tool calls when observable.
- [ ] Include packet lookup, hash checks, Hunch startup and validator overhead; a shorter agent phase that adds longer validation is not a win.
- [ ] Report median and range for the pilot; flag timeouts and retries rather than dropping them.

### Money

- [ ] Keep provider-reported input/output tokens and tool calls separate. A local subscription CLI does not expose a trustworthy marginal dollar bill per task; never multiply its token counts by an API price and call that realized savings.
- [ ] If metered API costs are evaluated later, use the actual billable model rates and observed usage for both arms, including memory extraction, storage, retrieval and replay overhead; label this a separate priced scenario.
- [ ] For a team, report avoided engineer investigation minutes as an estimate with an explicit hourly-rate assumption, distinct from observed machine cost. Do not add hypothetical labor savings to realized cash savings.
- [ ] Track infrastructure footprint per active repository and per stored task, and the break-even repeated-task frequency at which retrieval/verification overhead is repaid.

### Peace of mind

- [ ] Require an inspectable receipt: prior task, observed action, evidence identity, changed/unknown dependencies, today's validation result, and why the mode was selected.
- [ ] Measure invalid exact candidates (hard target: zero), stale advice accepted, quality regressions, post-task rework and cases the system correctly withheld; investigate each failure individually.
- [ ] Ask a small blinded user/developer review whether the packet made the decision easier to trust, but report that subjective rating separately from verified correctness. Do not call a green test complete safety.

### Work omitted, observed rather than assumed

- [ ] For each matched run, list the *specific exploratory operations* (file reads, searches, tool calls or investigation steps) observed in the unchanged-current-Hunch control and absent from the reuse arm. Report the trace and reason for comparison; do not infer an avoided operation merely because a replay packet was delivered.
- [ ] Separate genuine omitted exploration from work that was deferred, moved into a new tool call, or replaced by a slower validation step. Include lookup, recheck and false-shortcut recovery overhead in total time and cost.
- [ ] Never grant a blanket permission to omit tests, security checks, validations, approvals or irreversible actions. A candidate shortcut covers only explicitly enumerated exploratory work, with its bounded dependency fingerprint and today's validator still required.
- [ ] If the advisory packet is demonstrably ignored in repeat tasks, test a **narrow point-of-action recheck** as a separate experimental arm after Stages 1–3; use an existing hook and current authority semantics. Do not add a new mandatory guard or claim that advisory delivery enforces the shortcut without measured evidence.

A convincing outcome is **faster completed tasks with equal or better quality**, a credible cost model under the deployment actually used, and fewer unverified assumptions. If a dimension is unobservable, write `unavailable` instead of claiming improvement.

## 10. Decision thresholds

**Go to larger 20-task experiment** when paired repeat-task results show lower median investigation calls *and* lower median total time, with no meaningful success regression, zero invalid exact candidates, and enough comparable observations to justify the claim. The existing context-efficiency plan's numerical optimization goals (25% input tokens, 20% time, 30% investigation calls on eligible tasks) remain hypotheses, not a promise or a small-pilot significance test.

**Revise** if packets are relevant but time or token overhead cancels the benefit, if most records are sparse, or if exact eligibility is almost always unknown. Improve the specific bottleneck and run the same frozen comparison.

**Stop or reposition** if quality drops, unsafe reuse occurs, historical source snapshots cannot support currentness and prospective capture has no value, or the claimed saving depends on leaking future solutions.

## 11. Codex handoff prompt

```text
Work on the dedicated verified-work-reuse branch in davesheffer/hunch.
Read AGENTS.md and docs/VERIFIED-WORK-REUSE-PLAN.md. Audit the current main task-record, ranking, delivery, report evidence and hard-budget seams. Start with Stage 0 only and show its factual inventory and Go/Revise/Stop assessment. Do not implement a parallel memory engine. Do not claim a novel market category or measured savings.

If Stage 0 qualifies and the separate Gate A baseline is available, implement Stages 1–3 in order with focused tests. Keep current Hunch as the unchanged control, packets advisory, exact candidacy dependent on complete bounded evidence, and current validation mandatory. Report commands, changed files, evidence, measured comparisons and limitations. Stop if validation, data provenance or isolation fails.
```

## 12. Scope and state today

This branch supplies a reviewed execution specification only. No packet compiler, agent-run harness, issue qualification, benchmark result, percentage saving or commercial uniqueness is implied by the existence of this document.
