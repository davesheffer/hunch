# PILOT5 Gate A, version 5: task-scored memory, two arms, cost first

Status: DRAFT, written on 2026-09-30 by the agent under the maintainer's standing delegation, before any version 5
run. It becomes binding when the build SHA and harness SHA below are filled in and the preconditions pass. The
maintainer may veto it before any result is read. After the first timed run, any change to a rule here starts
version 6.

Version 4 (`GATE-A4-REPORT.md`) found quality equal and Hunch faster on the memory tasks, but its memory was weak:
7% of delivered records were eligible and 13% to 15% of the eligible ones were delivered, and the full test suite
run through `task verify` cost it time. Version 5 changes the build to fix those two causes, drops the hook diet,
removes the arm confound, and judges on steps, tokens and cost first.

## What changes from version 4

- Arms: `no-hunch` and `current-hunch` only. The hook diet is dropped: in version 4 it lost 9.1 quality points and is
  not an improvement.
- Build under test (`current-hunch`): a release carrying all of the following, and nothing else new:
  1. Scoped verify hint: the `task verify` hint names the targeted tests, not the full suite (PR #443).
  2. Lean SessionStart: the recent-decision and roadmap lists are removed (PR #443; `dec_8518efacaa`).
  3. Shell-write attribution: shell writes are attributed from a baseline taken at the shell call's own
     `PreToolUse` (PR #443).
  4. Task-scored selection (`feat/gate-a5-task-selection`, stacked on #443). At `UserPromptSubmit` the prompt
     picks the records it qualifies. A record qualifies on two or more distinct non-stopword prompt terms in its
     title or rationale, counting a term only if its document frequency is at most max(3, ceil(5% of live
     records)), or on a prompt-named path that matches its files or scope. The top 3 are listed. `PreToolUse`
     file grounding then delivers only qualifying decisions, bugs and findings. Constraints of every severity always
     pass, and so do retired code, doc grounding, sibling lessons, blast radius and landscape. Recent-task history is
     dropped while a selection is active. With no qualifying decision, bug or finding, or on a host without a prompt
     hook, grounding is unfiltered, as in version 4. Only a bare follow-up (every word a continuation word, such as
     "continue" or "go on") inherits the previous prompt's selection; any other prompt that selects nothing is unfiltered.
     Kill switch: `HUNCH_TASK_SELECTION=0`.
- Vector scoring (`tau_v`) is deferred. Selection is lexical (BM25 term rule) only. The constants above were fixed
  before the offline replay and not tuned on it. One ranking rule was changed after the replay was seen: records are
  ordered by how many of the prompt's named files they are anchored to, not just whether they match one
  (`DEVIATIONS.md` (l)). All rules are frozen from here.
- The `fable-mode` skill is removed from both arms' configuration. In version 4 it ran in 11 of 11 `no-hunch` runs
  against 3 of 11 in the Hunch arm, a confound between arms.
- Repetitions: 4 per task per arm (40 scored runs), up from 2.
- Same five frozen tasks (`suite.json`), model (`claude-opus-5-5`, CLI default effort), timeout, validators,
  neutral user configuration and confinement rule (with harness fix `171aa037`, below).
- Seed: `pilot5-gate-a-v5`. Output: `C:/bench-out/pilot5-gate-a5`, outside the user profile.
- Build: `@davesheffer/hunch@1.43.0` (tag `v1.43.0`, commit `f72927a99646c029f4df4cabc78ea713ca63bb41`, published
  2026-09-30). Harness: `feat/task-benchmark` at `<SHA at or after
  171aa037>`. Claude Code: `<claude --version at preflight>`. All three are pinned in the manifest; a mismatch at any
  run stops the schedule.

## Offline evidence before the run (2026-09-30)

An offline replay mirrored the harness's snapshot and arm setup, then ran `UserPromptSubmit` plus one `PreToolUse`
edit per fixed touched file, and counted the eligible ids in the injected hook text (metrics as
`tools/gate-a4-stats.ps1` lines 16 to 28, task-report ids excluded). Full table:
`hunch-private/docs/product/gate-a5/replay-2026-09-30.md`.

| Build | Micro precision | Micro recall | Median precision / recall | Injected chars (5 tasks) |
| --- | --- | --- | --- | --- |
| v1.42.0 (version 4's build) | 8% (5/61) | 12% (5/41) | 0.08 / 0.13 | 57,965 |
| version 5, kill switch on | 8% (5/61) | 12% (5/41) | 0.08 / 0.13 | 57,965 |
| version 5, first draft | 23% (14/62) | 34% (14/41) | 0.36 / 0.33 | 50,768 (-12%) |
| version 5, after critic fixes | 19% (12/63) | 29% (12/41) | 0.17 / 0.33 | 52,032 (-10%) |
| version 5, final (path-count ranking) | 22% (14/65) | 34% (14/41) | 0.29 / 0.33 | 52,039 (-10%) |

The released build's replay matches version 4's measured 7% and 13% to 15%, so the replay is faithful. The pass bar
set in advance (precision at least 20%, recall not below 13% to 15%) is met by the final build, but only after the
post-replay ranking change in `DEVIATIONS.md` (l); the build after the critic fixes alone scored 19%. The replay
therefore does not validate the final rule independently; the live run does. The replay counts hook text only, not
MCP tool results, so it is a lower bound. `UserPromptSubmit` latency rose from about 0.8 s to about 1.1 s.

Known risk: `operation-268` stays at 0 of 20. Its edits land in the hub file `src/cli/index.ts`, whose file grounding
is dominated by records that match the file but not the task. Version 5 does not fix hub files; expect no memory gain
on that task.

## Preconditions (all must pass before the first timed run)

1. Confinement replay: every version 4 transcript (all arms, `C:/bench-out/pilot5-gate-a4`) is rechecked with the
   version 5 confinement rule, using that run's own deny roots and commands (`armConfinement`, then
   `toolInputStrings` and `isOutOfRepoAccess` as in `src/benchmark/orchestrate.ts`). The result must show zero
   unexplained flags, and the (k) run must no longer flag. The tool is written on the Windows machine as
   `bench/pilot5/tools/gate-a5-confinement-replay.mts`; its output is saved next to the report.
2. Neutral preflight passes all canaries, including: no ancestor `~/.claude/CLAUDE.md` is visible
   (`fnd_3ecd8c0b57`), and `fable-mode` is absent from both arms' skill list.
3. Verify-hint smoke check: in one `current-hunch` preflight session on a suite task, the printed `task verify` hint
   names targeted test files, not the whole suite.
4. One untimed smoke run per arm, end to end, including validator and `repo-changes.patch`. It does not count.
5. Eligibility lists: for each task, the eligible record ids are frozen and hashed into the manifest before the
   schedule starts. Records the agent uses in paraphrase, without their id, are reported as unmeasured.
6. The analysis plan (below) is hashed before the first timed run.

## Criteria (pre-registered)

Primary, `current-hunch` against `no-hunch`, per task on medians, then pooled as the geometric mean of the five
per-task ratios (Hunch over no-hunch):

| # | Measure | Win if |
| --- | --- | --- |
| P1 | Quality: validator pass rate | not more than 5 points below `no-hunch` (a guard: failing it means no win on anything) |
| P2 | Cost (priced as in version 4: $4 input, $20 output, $0.20 cache read, $5 cache write per million) | pooled ratio below 1.00 |
| P3 | Provider input tokens | pooled ratio below 1.00 |
| P4 | Main-agent steps | pooled ratio below 1.00 |

Verdict: WIN if P1 holds and P2 to P4 all move down. PARTIAL if P1 holds and one or two of P2 to P4 move down. LOSS
otherwise. A timed-out run counts as a failure for P1. It has no cost, so it is left out of P2 to P4, with its token
lower bound reported as a sensitivity row.

Secondary (reported, not part of the verdict):

- Time: agent time per run with the single longest tool call removed. Raw wall time is reported too. In version 4
  its spread (SD 0.62 in log space) needs about 120 runs per arm to resolve, so it cannot decide this gate.
- Full-suite waits: runs with a shell test call of 590 s or more, split by whether it ran through `task verify`.
  Mechanism check: `current-hunch` has no more such runs than `no-hunch`.
- Delivery precision and recall per task, from the hook text and MCP results against the frozen eligibility lists.
  Mechanism check: micro precision at least 20%.
- The memory tasks (continuation-375, repeated-bug-360) and `operation-268` are reported separately.

Honesty rule: a win is set up here, not promised. The report states whatever the numbers say, including a LOSS.

## Lessons applied

| Mistake in an earlier version | Where | Guard in version 5 |
| --- | --- | --- |
| Confinement false positives stopped or voided runs (node path in a variable, drive letter read as a variable, unused assignment) | `DEVIATIONS.md` (h), (j), (k) | Harness `171aa037`: "invoked" means node or the entry is the command word. Precondition 1 replays all version 4 transcripts with zero unexplained flags allowed. |
| Maintainer sessions wrote to the private overlay mid-run | (i) | The overlay stays registered to the shadow clone for the whole run, as in version 4. |
| `repo-changes.patch` not written on Windows | (h), `GATE-A3-SPEC.md` F2 | Precondition 4: the smoke run must write it. |
| The ancestor `~/.claude/CLAUDE.md` leaked into runs | `fnd_3ecd8c0b57` | Output outside `$HOME`; the preflight canary must pass. |
| `fable-mode` ran in 11 of 11 `no-hunch` runs against 3 of 11 Hunch runs | version 4 Limitations | The skill is removed in both arms; the preflight checks it is gone. |
| The full suite through `task verify` caused Hunch's time penalty and the diet's timeout | version 4 report | Scoped verify hint in the build; precondition 3 smoke-checks it; full-suite waits reported per arm. |
| Wall time too noisy to decide | version 4 Noise | Cost, tokens and steps are primary; time is secondary, with the longest call removed. |
| Delivery measured by id only; eligibility lists understate | `dec_66925aa0ee` | Eligibility frozen and hashed before the run; paraphrased use reported as unmeasured. |
| 7% delivery precision | version 4 report | Task-scored selection, 22% in the offline replay (see `DEVIATIONS.md` (l)). |
| Two repetitions: 6.9x spread in one cell | version 4 Limitations | 4 repetitions per cell. |
| Version drift between runs (Claude Code 2.1.280 to 2.1.284) | (h) | Build, harness and Claude Code versions pinned in the manifest; a mismatch stops the schedule. |
| Analysis plan written mid-run | `GATE-A4-ANALYSIS-PLAN.md` | Criteria above and the analysis plan are hashed before the first timed run. |
| Cache-write price assumed | version 4 Limitations | Same assumption, stated; a 1-hour-rate sensitivity row is reported. |
