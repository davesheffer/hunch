# PILOT5 Gate A report, version 4

## In short

- **Quality:** equal. `current-hunch` passed 10 of 10 scored runs, `no-hunch` 11 of 11. Unlike version 1,
  `current-hunch` no longer loses quality.
- **Time on the tasks memory is for:** on continuation + repeated-bug, `current-hunch` took a median 352 s against
  522 s for `no-hunch` (-33%), on 3 to 4 runs per arm. Over all five tasks, time and cost are a wash.
- **Hook diet:** it cut the edit-time hook text by 82% as designed, but it lost a run to the 30-minute timeout and is
  not an improvement.
- **What slows Hunch down:** the agent ran the whole test suite through Hunch's `task verify` launcher, and the
  suite outlasts the 10-minute shell cap. Every full-suite wait in a Hunch arm went through `task verify`.
- **What makes Hunch's memory weak:** 7% of the records it delivers are eligible for the task, and it delivers 13% to
  15% of the eligible ones. The cost is driven by steps and output, not by the size of the injected text.

## What ran

- Arms: `no-hunch`, `current-hunch` (audited `v1.42.0`), `diet-hunch` (`hunch-hook-diet`). Claude Code CLI 2.1.284
  on a subscription, `--model claude-opus-5-5`, CLI default effort. Spec: `GATE-A4-SPEC.md` (with version 2 and 3
  specs); seed `pilot5-gate-a-v4`.
- Suite: 5 frozen tasks (`suite.json`), 2 repetitions per arm, plus the harness's paired tie-break repetition for
  `convention-314` (arms disagreed on success). 33 runs, 10:49 to 16:50 on 2026-09-29. Harness 7e08c13.
- One run has no outcome: `continuation-375` run 1 `current-hunch`, a confinement false positive
  (`DEVIATIONS.md` (k)). No other exclusions.
- The analysis plan (`GATE-A4-ANALYSIS-PLAN.md`, SHA-256 `a87df410…32ff`) was written with 21 of 33 runs done and
  before the last two tasks started. The verdict follows the spec; the descriptive analyses below were chosen after
  seeing results.

## Verdict: existing-Hunch criteria (indicative, 5 tasks)

| # | Criterion | `current-hunch` vs `no-hunch` | `diet-hunch` vs `no-hunch` |
| --- | --- | --- | --- |
| 1 | Quality degradation <= 5 points | PASS: 100% -> 100% | FAIL: 100% -> 90.9% (-9.1 points) |
| 2 | Lower median investigation tool calls | FAIL: 1 -> 2 | FAIL: 1 -> 1 |
| 3 | Positive time or provider-token movement on continuation + repeated-bug | PASS: total time median 522 s -> 352 s (-33%); input tokens 896k -> 671k (-25%, 3 runs) | PASS: 522 s -> 365 s (-30%); 896k -> 809k (-10%) |
| 4 | Abstention | Not computed (no preregistered measure) | Not computed |

- Diet mechanism check: median `PreToolUse` + `PostToolUse` characters 2,209 (`diet-hunch`) against 12,479
  (`current-hunch`), at most half: PASS.
- Diet improvement rule (against `current-hunch`): quality -9.1 points fails the 5-point bound, although median
  input tokens (1,268k against 1,612k) and main-agent steps (23 against 25.5) are lower. The diet is not an
  improvement.
- The diet's failure is `convention-314` run 2: timed out at 1,800 s with the validator passing (counts as a failure
  per `GATE-A-HARNESS.md`). Its provider tokens are unavailable, so it is left out of cost and token medians; its
  input lower bound is 1,716,039. Sensitivity: with that bound included, the diet's median input is 1,349k, still
  below `current-hunch`'s 1,612k; the harness itself marks this comparison undetermined.
- Movement on criterion 3 rests on 3 to 4 runs per arm, against a within-cell spread of up to 6.9x (see Noise).

## Per task (medians)

| Task | Pass no / cur / diet | Agent time s no / cur / diet | Minus longest call s no / cur / diet | Cost $ no / cur / diet |
| --- | --- | --- | --- | --- |
| continuation-375 | 2/2 / 1/1 / 2/2 | 507 / 338 / 351 | 173 / 281 / 238 | 0.55 / 0.60 / 0.70 |
| repeated-bug-360 | 2/2 / 2/2 / 2/2 | 529 / 261 / 433 | 462 / 216 / 121 | 0.52 / 0.47 / 0.42 |
| convention-314 | 3/3 / 3/3 / 2/3 | 773 / 862 / 1,107 | 340 / 261 / 505 | 1.45 / 1.07 / 1.56 |
| operation-268 | 2/2 / 2/2 / 2/2 | 273 / 325 / 643 | 237 / 289 / 291 | 0.99 / 1.02 / 0.90 |
| self-contained-394 | 2/2 / 2/2 / 2/2 | 515 / 529 / 391 | 453 / 416 / 315 | 0.98 / 1.10 / 0.71 |
| all (pooled) | 11/11 / 10/10 / 10/11 | 481 / 400 / 431 | 312 / 294 / 291 | 0.86 / 0.98 / 0.77 |

Pooled medians lean toward `convention-314`, the slowest task and the only one with a third repetition; read the
per-task rows. Cost is priced from the run's token parts at $4 input, $20 output, $0.20 cache read and $5 cache
write per million tokens (the 5-minute write rate is an assumption); a timed-out run has no cost.

## Why the time moves: the full suite

Measured from transcript timestamps (tool call to tool result, main thread). A full-suite wait is a shell test call
that hit the 10-minute Bash cap (590 s or more); the suite runs longer than that on this Windows machine.

| Arm | Runs with a full-suite wait | Of those, through `task verify` |
| --- | --- | --- |
| `no-hunch` | 2 of 11 | 0 |
| `current-hunch` | 3 of 11 | 3 |
| `diet-hunch` | 5 of 11 | 5 |

- Taking the longest call out of each run leaves the arms level: medians 312 s, 294 s and 291 s.
- The diet timeout: `task verify` ran the full suite, the call hit the Bash cap, went to the background, and a
  10-minute and a 5-minute wait followed before the wall clock ran out.
- `no-hunch` agents took the suite from the repo's `CLAUDE.md` (`npm test`). In the Hunch arms, the verify hint's
  launcher wraps whatever command the agent picks, and the agent picked the full suite. Why the diet arm did so more
  often is not established.

## Where the money goes

Share of priced cost per arm (completed runs), with main-agent model calls per run.

| Arm | Cache write | Cache read | Output | Uncached input | Main calls (mean) |
| --- | --- | --- | --- | --- | --- |
| `no-hunch` | 31% | 32% | 37% | 0% | 27.0 |
| `current-hunch` | 35% | 33% | 32% | 0% | 24.2 |
| `diet-hunch` | 34% | 32% | 34% | 0% | 23.3 |

Injected text is paid once as a cache
write and then cheaply as cache reads; the bill follows the number of steps and the output. Shrinking the hook text,
which the diet does, leaves cost almost unchanged.

## Memory delivery

- Precision (eligible records among those delivered, htask records excluded): median 7% in both Hunch arms.
  Recall (eligible records delivered, htask records excluded): 15% (`current-hunch`), 13% (`diet-hunch`).
- Audit of the Hunch-arm transcripts (a read-only pass; medium confidence, id-level use low confidence):
  - Most delivered records come from the per-file ranked block on `PreToolUse` / `PostToolUse`. A hub file such as
    `src/cli/index.ts` pulls in decisions unrelated to the task.
  - `SessionStart` delivers the most recent records by date and three roadmap items, the same in every run of a task.
  - A shell command that writes files triggers a `PostToolUse` re-injection of the same records.
  - Most eligible records that were missed exist in the run's store: a selection problem, not missing memory.
  - The one `hunch_context` call made with a task phrase surfaced an eligible record that hook delivery missed.
  - Use by id: 3 of 10 scored `current-hunch` runs cite a delivered record by id in their final message (both
    `operation-268` runs cite `dec_66925aa0ee`, `self-contained-394` run 1 cites `fnd_e1e9d91cea`); no `diet-hunch`
    run does. `dec_66925aa0ee` is not on `operation-268`'s eligible list, so the eligibility lists may understate
    relevance. Paraphrased use is not measured.

## Other observations

- The repo-tracked `fable-mode` skill (`.claude/skills/fable-mode`, present in every arm) was invoked in 11 of 11
  `no-hunch` runs, 3 of 11 `current-hunch` and 2 of 11 `diet-hunch`. The arms differ in more than Hunch; a follow-up
  gate removes the skill as a factor (`GATE-S-SPEC.md`, draft).
- Noise: the pooled within-cell standard deviation of log agent time is 0.62 (17 degrees of freedom); one cell spans
  6.9x. Detecting a 20% median time difference at 80% power would take about 120 runs per arm. Wall time is the
  wrong primary measure at this scale; steps and tokens, or time with the full-suite wait removed, are less noisy.

## Recommendations (context efficiency)

Each estimate below comes from this run's numbers and is not a measured effect.

1. **`task verify` should not run the full suite by default.** Evidence: 8 of 8 Hunch-arm full-suite waits and the
   only timeout went through it. Change: the verify hint names targeted tests from the edit's blast radius and states
   that the full suite is CI's job; the default budget drops below the 10-minute Bash cap (for example 8 minutes) so
   a full suite fails fast instead of going to the background. Estimate: removes the Hunch time penalty on
   `convention-314` and the timeout; the arms converge to about 290 to 310 s, so parity, not a win.
2. **Select memory by task, not by edited file, and stay silent without a confident match.** Evidence: precision 7%,
   recall 13% to 15%, missed records present in the store, and the task-phrase query that found one. Change: rank
   on the task text and the files it names; inject only on a confident hit (the silence policy of the proposed failure-time injection roadmap item); drop the recent-by-date
   and roadmap lists from `SessionStart`; do not re-inject unchanged records after a shell write. Estimate: fewer
   irrelevant records; any cost saving has to come through fewer steps.
3. **Do not pursue the diet on its own.** Evidence: 82% less edit-time text, cost unchanged, recall misses unchanged.
4. **Fix the confinement tokenizer** for unused variable assignments before the next timed run (`DEVIATIONS.md` (k)).
5. **Size the next gate from the noise:** use main-agent steps and input tokens as the primary measures, or report
   time with the longest call removed.

## Limitations

- Small n: 2 to 3 runs per cell, 6.9x spread within one cell.
- One `current-hunch` run has no outcome (false-positive breach); one diet run timed out without provider tokens.
- The `fable-mode` invocation gap is a confound between arms.
- The full-suite classification uses the Bash cap as its threshold; a backgrounded suite's later waits are counted
  only through the time of the calls that wait.
- The cache-write price is an assumption.
