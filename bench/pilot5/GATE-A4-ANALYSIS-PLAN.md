# PILOT5 Gate A version 4: analysis plan

Written 2026-09-29 at about 15:05 +0300, while the version 4 run was in progress: 21 runs had finished
(repeated-bug-360, continuation-375 and convention-314, including convention's tie-break rep 3), and the last two
tasks (operation-268, self-contained-394; 12 runs) had not started. It fixes the report's tables and rules before
those runs land. Committed after the run, with the SHA-256 of this file as written recorded in the report.

## Primary verdict: unchanged from the spec

- `current-hunch` and `diet-hunch` are each judged against `no-hunch` under the four existing-Hunch criteria of
  `GATE-A-REPORT.md` (quality degradation <= 5 points; lower median investigation tool calls; positive time or
  provider-token movement on continuation + repeated-bug; abstention not computed), plus the diet mechanism check and
  the diet improvement rule of `GATE-A2-SPEC.md` "## Criteria".
- All repetitions count, including the harness's tie-break repetitions.
- Exclusions: an `isolation_breach` run has no outcome and is left out of every measure (as in (j)); the arm's
  outcome count is reported. A `timed_out` run counts as a failure; its cost is unavailable, so it is left out of
  cost and token medians, and a sensitivity line uses its input lower bound as version 1 did.
- Medians, as in the spec. Pooled medians over all tasks are reported, but the per-task table is the reading,
  because the tie-break adds a third repetition only to convention-314, the slowest task.

## Descriptive analyses: chosen after seeing 21 runs

These were picked after seeing results, so they explain the verdict and do not change it.

1. Agent time minus the longest single tool call, per run and as medians. The longest call is measured from the
   transcript (tool_use to tool_result timestamps, main thread).
2. Full-suite test runs: per arm, how many runs ran the whole suite at least once, and how many of those went through
   Hunch's `task verify` launcher; the wall time those calls took.
3. Cost split per arm: cache writes, cache reads, uncached input and output as shares of the priced total, and main
   model calls per run. Prices: Opus 5.5 at $4 input, $20 output, $0.20 cache read, $5 cache write (the 5-minute
   write rate is an assumption).
4. Memory delivery: precision (delivered eligible / delivered) and recall (delivered eligible / eligible), and an
   audit of which delivered records the agent used and why eligible records were missed.
5. The repo-tracked `fable-mode` skill: invocation rate per arm (a confound present in every arm).
6. Noise: spread between repetitions of the same task and arm, and the number of runs a later gate needs to see a
   20% median difference.

## Recommendations section

Each recommendation names the number behind it, the change, the expected effect (labelled as an estimate), and the
gate that would test it. Scope: context efficiency only (time, cost, delivery accuracy).
