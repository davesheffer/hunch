# Hunch consolidation-safety calibrated follow-up - preregistration

Frozen before any follow-up solver-model call on 2026-08-27.

## Why this follow-up exists

The 2026-08-26 pilot was internally valid but every A, E, C-rel, and C-full session failed. That
complete floor made the paired memory comparison uninformative. This follow-up separates task
calibration from evaluation and proceeds only on tasks that demonstrate fresh headroom under the
current harness and solver.

## Immutable source memory

Reuse the already-frozen accumulated Zod snapshot at
`6f53d809027ae08c056bc548b844b086d2f3070f` with 167 pre-cutoff decisions and the structural graph
at Zod revision `9977fb0868432461de265a773319e80a90ba3e37`. No decision is re-synthesized.

For each candidate, derive a small comparison snapshot by running the fixed query below against the
accumulated snapshot and retaining the first five decision results, ignoring symbol results. If the
query returns fewer than five decisions, retain all it returns. The retained JSON records are copied
byte-for-byte; all other decision files are removed and the unchanged structural graph is reindexed.

| Candidate | Fixed query |
|---|---|
| `zod-4461` | `Zod unsafe eval CSP Function allowsEval jitless` |
| `zod-5229` | `Zod tuple missing element default value parser optional` |
| `zod-5296` | `Zod record transformed key output input type` |
| `zod-5625` | `Zod codec invert inverse flip encode decode composition` |
| `zod-5842` | `Zod object merge refine checks silently dropped pick omit` |
| `zod-5917` | `Zod preprocess optional position missing object key undefined expected nonoptional` |

These are called `C-top` snapshots. They are query-bounded baselines, not oracle labels: a retained
record may be irrelevant or misleading.

## Calibration screen

- Candidates, fixed before the screen: `zod-4461`, `zod-5229`, `zod-5296`, `zod-5625`,
  `zod-5842`, and `zod-5917`.
- Selection rationale: together they span prior unstable, floor, and formerly ceiling behavior under
  sealed Sonnet runs, while covering different Zod subsystems. Prior outcomes are not counted in the
  follow-up totals.
- Solver: `claude-sonnet-5` through the installed Claude Code subscription CLI.
- Current sealed `bench/external/run-zod.ts`; A arm only; two repeats per task; 12 valid sessions.
- `--no-repro`, maximum 50 turns, deny-all network, hidden isolated scoring.
- Eligibility: exactly one source-accuracy pass out of two. A 0/2 floor or 2/2 ceiling is ineligible.
- If more than two tasks qualify, select the first two by lexicographic task ID.
- If no task qualifies, stop and report calibration failure. Do not add tasks, repeats, turns, or a
  different model after seeing the screen.
- Exclude only harness-labeled infrastructure failures. If one occurs, replace that exact assignment;
  ordinary failures, timeouts, test touches, and unresolved completions remain outcomes.

The calibration screen is used only for eligibility. Its two rows are not added to final treatment
totals.

## Conditional evaluation

If at least one task is eligible, run fresh repeat indices 3, 4, and 5 for each selected task under:

- `A` - no memory;
- `C-top` - forced Hunch consultation against that task's fixed query-bounded snapshot;
- `C-full` - forced Hunch consultation against the 167-decision accumulated snapshot.

There are nine evaluation sessions per selected task and at most 18 total. Each session has an
independent future-free checkout and conversation. The full-memory invocation alternates A/C arm
ordering; C-top runs separately because it uses a different immutable memory source.

## Outcomes and pairing

Primary: source accuracy under hidden merged-fix tests. Secondary: issue-contract accuracy, turns,
elapsed time, delivered decision IDs, supplement count, abstention/withheld count, item token cost,
and changed files.

Pair by selected task and fresh repeat number:

- treatment win versus A: `A=FAIL, C=PASS`;
- treatment harm versus A: `A=PASS, C=FAIL`;
- accumulation win: `C-top=FAIL, C-full=PASS`;
- accumulation harm: `C-top=PASS, C-full=FAIL`.

## Interpretation

- **Supports accumulation harm:** at least one accumulation harm and accumulation net direction
  (wins minus harms) below zero.
- **Supports no observed accumulation harm in this calibrated set:** at least one evaluation PASS,
  zero accumulation harms, and accumulation net direction non-negative.
- **Anything else:** mixed/inconclusive. Calibration eligibility does not guarantee evaluation
  headroom, so a fresh all-fail or all-pass evaluation remains inconclusive.

## Causal diagnostic

If and only if a C-full-specific loss occurs and its transcript identifies a delivered decision that
plausibly changed the diagnosis, perform one fresh record-surgery run with those records removed.
Report it separately; never add it to primary totals. Otherwise perform no surgery.

## Integrity and stopping

No outcome-based stopping or extension. Preserve every valid calibration and evaluation row. The
task fix and future objects must remain absent from agent checkouts; hidden tests run only in the
separate scorer checkout. The final report must disclose that evaluation is conditional on this
screen and is not a population-level efficacy estimate.
