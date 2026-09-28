# PILOT5 Gate A report (v2: measurement correction)

Dated 2026-09-28. Plan: `docs/HUNCH-CONTEXT-EFFICIENCY-POC.md` (sections 7, 9, 12). Harness: `GATE-A-HARNESS.md`.

## What ran

- Arms: `no-hunch` and `current-hunch` (audited tag `v1.42.0`, 5ff071a). Claude Code CLI 2.1.280 on a subscription,
  `--model claude-opus-5-5`, CLI default effort.
- Suite: 5 frozen tasks (`suite.json`), 2 repetitions per arm, plus one paired tie-break repetition for
  `repeated-bug-360`. 22 runs. Timed runs used harness 34bf818; manifest
  `94932915c87a9378ed2964716e75e4817e1cba8212370994fe813fb5a4027516`.
- v2 recounts the token and call fields of all 22 unchanged transcripts with harness 24fff7e (`--report-only
  --recount`). No run was repeated. The recount matched an independent script on 22 runs x 8 fields with 0
  mismatches.

## Why v2

Harness 34bf818 kept only the last `result` event's `usage`. A background-task notification re-invokes the session
and emits another result, so earlier invocations were dropped, and subagent tokens were never counted. The recorded
values were low by up to about 5x (`convention-314` `current-hunch` run 2: 765,305 recorded vs 4,050,506). The
corrected rule is in `GATE-A-HARNESS.md`, Metrics. This is a post-run measurement amendment; it changes no exposure,
schedule or validation rule.

## Gate A status: not closed

Gate A asks for measurement validity (plan section 7).

- Held: the `no-hunch` exposure proof passed in 11 of 11 runs; runs without provider tokens stay `unavailable`.
- Not held: the token measurement needed a post-run correction, and the isolation check produced one known false
  positive (`current-hunch` `self-contained-394` run 2; see `GATE-A-HARNESS.md`, Confinement). Reproduction under
  the corrected harness has not run.

## Existing-Hunch criteria (plan section 9; indicative, 5 tasks)

| # | Criterion | Result |
| --- | --- | --- |
| 1 | Quality degradation <= 5 points | FAIL: 100% -> 90% (-10 points) |
| 2 | Lower median investigation tool calls | FAIL: 1 -> 1 |
| 3 | Positive time or provider-token movement on continuation + repeated-bug | FAIL: total time median 354,862 ms -> 401,088 ms; token percentage withheld (one run has no provider tokens) |
| 4 | Abstention | Not computed (no preregistered measure) |

Valid runs: `no-hunch` 11 of 11, all successful. `current-hunch` 10 of 11 valid (one excluded as the false-positive
isolation breach, not retried per the spec), 9 of 10 successful: `repeated-bug-360` run 2 timed out at 30 minutes;
its validator passed, and it counts as a failure per the spec.

Sensitivity, not the verdict: with the timed-out run's input lower bound (893,289) included, the continuation +
repeated-bug input median is 638,768 (`current-hunch`) vs 695,467 (`no-hunch`), -8.2%. The lower bound sits above
the median, so the true value cannot move it.

## Per category (medians)

| Category | Success no-hunch / current-hunch | Input tokens no-hunch -> current-hunch | Total time no-hunch -> current-hunch |
| --- | --- | --- | --- |
| continuation | 2/2 / 2/2 | 863,290 -> 776,927 (-10.0%) | 513,251 ms -> 240,955 ms (-53.1%) |
| repeated-bug | 3/3 / 2/3 | 652,478 -> 497,840 (2 provider runs; % withheld) | 354,862 ms -> 701,406 ms (+97.7%) |
| convention | 2/2 / 2/2 | 2,721,154 -> 3,838,793 (+41.1%) | 757,340 ms -> 915,872 ms (+20.9%) |
| operation | 2/2 / 2/2 | 1,119,325 -> 1,825,760 (+63.1%) | 338,281 ms -> 401,621 ms (+18.7%) |
| self-contained | 2/2 / 1/1 valid | 1,211,768 -> 1,162,638 (-4.1%) | 388,088 ms -> 225,783 ms (-41.8%) |
| all | 11/11 / 9/10 | 932,285 -> >= 1,038,862 (timed-out run bounded) | 368,858 ms -> 420,166 ms (+13.9%) |

Input tokens are the whole session (main loop and subagents). On `convention` the main loop grew 74% and the subagent
share fell 11%. Tool calls on `operation`: 20 -> 27; on `convention`: 52 -> 64, investigation calls 2 -> 6.5.

## Hook injection (current-hunch)

Counted as non-empty `hookSpecificOutput.additionalContext` in the transcripts (text the model receives; Stop-hook
`systemMessage` is display-only and excluded). Two independent scripts agree on every event type except 291 characters
of PreToolUse.

- 112 injections, 204,189 characters over 11 runs; 7.5k-38k characters per run.
- PostToolUse: 23 injections, 111,938 characters, largest 13,463. The three largest injections are all the
  "this shell command wrote <files> ... pre-edit grounding arrives now: re-check the change" catch-up, which carries
  full grounding for every file a shell command wrote.
- PreToolUse 57 / 45,879; SessionStart 11 / 20,095; UserPromptSubmit 17 / 18,061; SubagentStart 3 / 5,913;
  PostToolUseFailure 1 / 2,303.

The injected text carried through later model calls is estimated at 14k-125k tokens per run (characters / 4 x later
main-loop calls), well below the token gaps on `operation` (about 0.7M) and `convention`. The larger difference is
more steps. That link is correlational.

## Limitations

- Small n: 2-3 runs per cell, with large variance (`repeated-bug-360` `no-hunch`: 96 s to 741 s).
- One timeout without provider tokens; one excluded false-positive breach.
- Both arms load the operator's user-level instructions, which route work to subagents; this is a confound shared by
  both arms.
- The audited product (v1.42.0) is newer than the task starting commits in both arms' target code.
- v2 is a post-run measurement amendment over unchanged transcripts.

## Decision (2026-09-28)

Plan section 12 "Iterate": retrieval helps on continuation, and the fixed Hunch overhead erases the saving elsewhere.
Gate B does not start. The next Gate A version, specified before its first timed run:

- neutral user-level instructions for the child in every arm;
- the audited CLI assigned to a shell variable and invoked through it is allowed;
- a hook-diet build as a third arm (`no-hunch`, `v1.42.0`, hook diet), with the diet rules fixed before any
  per-task number is looked at again.
