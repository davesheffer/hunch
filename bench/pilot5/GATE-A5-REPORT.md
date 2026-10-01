# PILOT5 Gate A version 5: report

**Verdict: LOSS.** Quality held (P1), but cost, input tokens and steps all went up with Hunch, not down. Under the
pre-registered rule a WIN needs all three to move down and a PARTIAL needs one or two. Hunch was about three times
faster in raw wall time, but time is secondary and does not decide the verdict.

- Spec: `GATE-A5-SPEC.md`. Analysis plan: `GATE-A5-ANALYSIS-PLAN.md`, sha256
  `e1d12ae5b5996d794088c062243af9aafe7755b97137563891af92119c902659` (unchanged since it was recorded before the first
  timed run).
- Manifest: `/Users/Shared/bench-out/pilot5-gate-a5/manifest.json`, file sha256
  `3384a7f192d4e8be9ed911b10b9f87da6c7cbd57e26e89585fc7e3f010af59f4`, harness manifest id
  `6ef89151e793ad43e85e695f2b1401966b95d3d16f263947d03e5eecb05764f1`.
- Pinned build `@davesheffer/hunch@1.43.0`, harness `feat/task-benchmark` `4d3590bb`, Claude Code 2.1.284, model
  `claude-opus-5-5`. 40 timed runs on the maintainer's Mac, 2026-09-30 22:07 to 2026-10-01 04:58, seed
  `pilot5-gate-a-v5`.
- Deviations: (n), (o) and (p) were made before the timed runs; (q) records the four `isolation_breach` runs.
- Numbers: `tools/gate-a5-stats.py --out /Users/Shared/bench-out/pilot5-gate-a5` (exit 0), which writes
  `gate-a5-stats.json` beside the runs.

## Primary (P1 to P4)

Each ratio is `current-hunch` over `no-hunch`, from per-task medians, pooled as the geometric mean of the five tasks.
Intervals are 95% percentile bootstrap intervals (10,000 resamples within each cell, seed `pilot5-gate-a-v5`).

| # | Measure | current-hunch | no-hunch | Pooled ratio | 95% interval | Moves down |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | Validator pass rate | 16/16 (100%) | 20/20 (100%) | 0 points | | holds |
| P2 | Cost ($4 in, $20 out, $0.20 cache read, $5 cache write per million) | | | 1.137 | 0.992 to 1.247 | no |
| P3 | Provider input tokens | | | 1.163 | 0.930 to 1.352 | no |
| P4 | Main-agent steps | | | 1.009 | 0.840 to 1.121 | no |

All three intervals include 1.00, so with 4 repetitions per cell none of the three increases is resolved either.
The verdict rule uses the point ratios, and none of them is below 1.00.

| Task | P2 cost | P3 input tokens | P4 steps | Counted runs (Hunch / no Hunch) |
| --- | --- | --- | --- | --- |
| repeated-bug-360 | 1.370 | 1.594 | 1.278 | 4 / 4 |
| continuation-375 | 1.039 | 1.042 | 0.973 | 3 / 4 |
| convention-314 | 1.127 | 1.130 | 0.946 | 4 / 4 |
| operation-268 | 1.188 | 1.216 | 1.036 | 3 / 4 |
| self-contained-394 | 0.995 | 0.934 | 0.860 | 2 / 4 |

Run status:

- `no-hunch`: 20 completed.
- `current-hunch`: 16 completed and 4 `isolation_breach`, left out as the plan says (`DEVIATIONS.md` (q)).

There were no timeouts and no agent errors. Every task keeps at least 2 counted runs per arm, so no task is missing.

## Sensitivity (not part of the verdict)

| Row | P2 | P3 | P4 |
| --- | --- | --- | --- |
| 1. Timed-out runs at their lower bound | 1.137 (none timed out) | 1.163 | |
| 2. Cache writes at the 1-hour rate ($8) | 1.141 (1.008 to 1.246, excludes 1.00) | | |
| 3. Main loop only | | 1.163 | |
| 4. Without operation-268 | 1.124 | 1.150 | 1.003 |

## Secondary measures

1. **Time.**
   - Raw agent time: pooled ratio 0.341 (0.207 to 0.526). Median per run: about 4 minutes with Hunch against about
     13 minutes without.
   - With the single longest tool call removed (the pre-registered time measure): 0.793 (0.441 to 1.139), which
     includes 1.00. Per task: continuation 0.77, convention 0.83, self-contained 0.44, operation 1.05, repeated-bug
     1.07.
   - Median longest call: 35 s with Hunch, 600 s without.
2. **Full-suite waits** (a shell call of 590 s or more):
   - `current-hunch`: 0 of 16 runs.
   - `no-hunch`: 13 of 20 runs. 11 of them were test commands (`npm test`, `run-tests`, `tsx --test`), and only 1 of
     those 11 ran through `task verify`.
   - The mechanism check passes: the scoped verify hint stopped the 10-minute full-suite waits. They cause almost all
     of the raw time gap, which is why that gap mostly disappears once the longest call is removed.
3. **Delivery** (hook `additionalContext` plus `mcp__hunch__*` results, against the frozen eligibility lists):
   - Micro precision 27.0% (53/196) and micro recall 42.4% (53/125). The mechanism check (precision at least 20%)
     passes; version 4 was at 7%.
   - Per-task median precision: repeated-bug 0.56, self-contained 0.54, continuation 0.24, convention 0.23,
     operation 0.00.
   - Records used in paraphrase are not measured.
4. **Memory tasks and operation-268 on their own** (P2 / P3 / P4):
   - continuation-375: 1.04 / 1.04 / 0.97.
   - repeated-bug-360: 1.37 / 1.59 / 1.28.
   - operation-268: 1.19 / 1.22 / 1.04.
   - Quality is 100% in both arms on all three.
5. **Cost split** (share of the priced total):

   | Arm | Cache writes | Cache reads | Output | Uncached input |
   | --- | --- | --- | --- | --- |
   | Hunch | 38.2% | 24.6% | 37.3% | about 0% |
   | No Hunch | 35.7% | 26.3% | 37.9% | about 0% |

6. **Confounds.** `fable-mode` was invoked 0 times in both arms. `background_wakeups`: 0 with Hunch, 1 without.
7. **Noise.** Pooled log-scale SD between repetitions:

   | Measure | SD | Runs per arm to resolve a 20% median difference |
   | --- | --- | --- |
   | P2 | 0.16 | about 13 |
   | P3 | 0.27 | about 34 |
   | P4 | 0.21 | about 21 |

   Formula: n = 2(1.96+0.84)²SD²/ln(1.2)².

## Reading

- Hunch adds about 16,500 tokens of context per run (median). That context is carried through every turn's cache, and
  on four of five tasks it did not save enough turns to pay for itself. The clearest loss is `repeated-bug-360`,
  where the `no-hunch` agent fixed the bug in fewer steps than the Hunch agent.
- The two changes since version 4 worked as mechanisms:
  - The scoped verify hint removed the full-suite waits.
  - Delivery precision rose from 7% to 27%.
- Neither change turned memory into fewer tokens or fewer steps.
- Fairness fixes made before these runs: the `no-hunch` arm no longer starts from broken code (`DEVIATIONS.md` (p)).
  So versions 1 to 4 compared Hunch against a handicapped baseline, and this is the first fair comparison.

## Limitations

- 5 tasks and 4 repetitions per cell, with 2 to 4 counted runs per cell after exclusions. No pooled interval for P2
  to P4 excludes 1.00.
- The four excluded runs were all in the Hunch arm. All four were confinement-rule false positives
  (`DEVIATIONS.md` (q), corrected on 2026-10-01 by (r): the fourth was first reported as a launcher misuse). Excluding them follows the plan. Their input tokens
  were mixed against the counted Hunch runs of the same task (continuation higher, operation lower, self-contained
  one above and one below), so they are not a one-sided selection.
- A single machine (macOS). Absolute times and costs are not comparable with version 4 (Windows).
- Cache-write price is assumed at the 5-minute rate; the 1-hour row is above.
