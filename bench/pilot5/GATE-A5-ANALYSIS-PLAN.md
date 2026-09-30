# PILOT5 Gate A version 5: analysis plan

Written 2026-09-30, before any version 5 run and before the build under test was released. It fixes how
`GATE-A5-SPEC.md` "## Criteria" is computed. Its SHA-256 is recorded in the manifest before the first timed run
(spec precondition 6); after that, any change here starts version 6, as for the spec.

## Data

- Source: `C:/bench-out/pilot5-gate-a5/runs/<task>/<rep>-<arm>/run.json` and `transcript.jsonl`, written by the
  harness pinned in the manifest. Fields are `EfficiencyRun` / `TaskCost` in the harness's
  `src/benchmark/types.ts`.
- Scored runs: the 40 scheduled runs (5 tasks x 2 arms x 4 repetitions). A harness tie-break repetition, if any,
  counts like the others and is reported. Smoke and preflight runs never count.

## Run status

| Status | P1 (quality) | P2 to P4 (cost, tokens, steps) |
| --- | --- | --- |
| `completed` | pass if `quality.outcome` is `passed`; `failed`, `partial` and `unavailable` are failures | counted |
| `timed_out` | failure | left out; its `input_tokens_lower_bound` goes in a sensitivity row |
| `agent_error` | failure | left out; reported by run |
| `isolation_breach`, `invalid_exposure` | no outcome: left out of every measure | left out |

Each arm's outcome count is reported. Every `isolation_breach` run gets a `DEVIATIONS.md` entry with a replay
through the harness's own `isOutOfRepoAccess`, as in (j) and (k). If a task ends with fewer than 2 counted runs in
either arm, the task is reported as missing, and the pooled ratios use the tasks that remain. With fewer than 4
tasks remaining, the verdict is INCONCLUSIVE.

## Primary measures

Per run:

- **Cost (P2)**, in dollars: (`input_token_parts.input` x 4 + `input_token_parts.cache_creation` x 5 +
  `input_token_parts.cache_read` x 0.20 + `output_tokens` x 20) / 1,000,000. This is the whole session, subagents
  included. A run with `input_token_parts` or `output_tokens` null is left out of P2 and reported.
- **Provider input tokens (P3)**: `input_tokens`, i.e. the whole session, cache reads and writes included.
- **Main-agent steps (P4)**: `main_model_calls`, the distinct assistant messages of the main loop.

Per task and arm: the median over counted runs. Per task: ratio = `current-hunch` median / `no-hunch` median.
Pooled: the geometric mean of the per-task ratios. A pooled ratio "moves down" only when it is strictly below 1.00;
exactly 1.00 is not a move.

**P1 (quality)**: pass rate per arm, pooled over all tasks = passes / counted runs. It holds when the `current-hunch`
rate is not more than 5 percentage points below the `no-hunch` rate.

**Verdict**, as in the spec: WIN if P1 holds and P2, P3 and P4 all move down; PARTIAL if P1 holds and one or two of
them move down; LOSS otherwise (including P1 failing).

## Uncertainty (reported, not part of the verdict)

For each pooled ratio: a 95% percentile bootstrap interval. Each resample draws the counted runs of every task-arm
cell with replacement, within the cell, then recomputes medians, ratios and the geometric mean. 10,000 resamples,
seed `pilot5-gate-a-v5`. The report states when an interval includes 1.00.

## Sensitivity rows (reported, not part of the verdict)

1. Timed-out runs: P2 and P3 with each timed-out run's lower bound included as if it were complete.
2. Cache-write price: P2 with cache writes at the 1-hour rate ($8 per million) instead of $5.
3. Main loop only: P3 with `main_input_tokens` in place of `input_tokens`.
4. Without `operation-268` (the known hub-file risk in the spec): the pooled ratios over the other four tasks.

## Secondary measures (from the spec, reported)

1. **Time**: `agent_wall_clock_ms` minus the single longest main-thread tool call (tool_use to tool_result
   timestamps, as in `tools/gate-a4-tooltime.mjs`). Per-task medians and pooled geometric mean, as for P2. Raw wall
   time is reported too.
2. **Full-suite waits**: runs with a main-thread shell test call of 590 s or more, per arm, split by whether it ran
   through `task verify`. Mechanism check: `current-hunch` has no more such runs than `no-hunch`.
3. **Delivery**: delivered = record ids found in hook `additionalContext` and in `mcp__hunch__*` tool results,
   excluding task-report ids (as in `tools/gate-a4-stats.ps1` lines 16 to 28). Precision = delivered eligible /
   delivered; recall = delivered eligible / eligible, against the eligibility lists frozen and hashed before the
   run. Micro (summed over runs) and median per task. Mechanism check: micro precision at least 20%. Records the
   agent used in paraphrase, without their id, are listed as unmeasured.
4. **Memory tasks**: continuation-375 and repeated-bug-360 are reported on their own, with all primary measures.
   `operation-268` is also reported on its own.
5. **Cost split**: cache writes, cache reads, uncached input and output as shares of the priced total, per arm.
6. **Confound checks**: `fable-mode` invocations per arm (expected 0 in both), and `background_wakeups` per arm.
7. **Noise**: log-scale SD between repetitions per task-arm cell, and the runs per arm a later gate would need to
   see a 20% median difference.

## Report

`GATE-A5-REPORT.md` opens with the verdict and the P1 to P4 table, then the uncertainty and sensitivity rows, then
the secondary measures. It states this file's SHA-256, the manifest's, and any deviation, by letter, in
`DEVIATIONS.md`. Following the spec's honesty rule, a LOSS is reported as a LOSS.
