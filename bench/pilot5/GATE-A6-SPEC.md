# PILOT5 Gate A, version 6: lean delivery, two arms, cost first

Status: DRAFT, written on 2026-10-01 by the agent under the maintainer's standing delegation, before any version 6
build or run. The maintainer approved build changes 1 to 7 on 2026-10-01. It becomes binding when the build SHA and harness SHA below are filled in and the preconditions pass.
The maintainer may veto it before any result is read. After the first timed run, any change to a rule here starts
version 7.

Version 5 (`GATE-A5-REPORT.md`) was a LOSS: quality held, but cost (1.14), input tokens (1.16) and steps (1.01) all
went up with Hunch. Its two mechanism fixes worked (no full-suite waits, delivery precision 7% to 27%) but did not
turn memory into fewer tokens. Version 6 attacks the cause the version 5 transcripts show: Hunch's context costs more
than it saves.

## Why version 5 lost: where Hunch's extra tokens come from

Measured from the 40 version 5 transcripts (`transcript.jsonl` usage and `hook_response` events):

1. **A fixed cost on every model call: about 4,000 tokens.** The first call reads 22,700 to 22,944 input tokens with
   Hunch and 18,692 to 18,936 without, flat across all five tasks. A run makes 11 to 27 calls, so this alone is about
   46,000 to 108,000 tokens per run. It comes from text that sits in the prompt from the start:
   - the Hunch block in `CLAUDE.md` (3,712 chars, dense with record ids);
   - the MCP server `instructions` (about 1,600 chars) and 41 deferred `hunch_*` tool names;
   - 6 scaffolded slash commands;
   - SessionStart text (1,025 chars, of which about 750 are the operating loop);
   - UserPromptSubmit text (about 1,770 chars).
2. **Text added during the run: about 17,000 chars per run**, which then rides in every later call:

   | Source | Median chars per run |
   | --- | --- |
   | PostToolUse shell-write grounding | 7,346 |
   | `task verify` output | about 1,200 (2,200 mean) |
   | `hunch_context` results | 3,868 when called (9 of 20 runs) |
   | UserPromptSubmit | 1,756 |
   | `hunch_task` card | 1,473 |
   | SessionStart | 1,025 |
   | PreToolUse edit grounding | 0 (1,132 mean) |

   The shell-write grounding is the largest item. It sends a full grounding block for up to 3 written files, and most
   of each block is a list of up to 12 `graph | blast/d1 | <symbol> @ <file>` lines. Task-scored selection does not
   filter those lines, or the constraints, landscape and retired-code lines.

3. **The finish ritual: 1 to 2 extra model calls at the end of every run.** All 20 Hunch runs ended with
   `hunch_task finish`, 10 of them after a `ToolSearch` just to load that tool, and then echoed the card in the final
   answer. The prompt hook requires it whenever `task verify` was used, which is every run. Those calls come when the
   context is largest: about 65,000 to 115,000 input tokens per run (8% to 15% of the run), but only $0.02 to $0.03,
   since they are cache reads.

Input-token difference per task (median, Hunch minus no Hunch): continuation +32k, convention +117k, operation
+221k, repeated-bug +162k, self-contained -55k.

Not a cause: both arms edit mostly through shell scripts (`python3 - <<'EOF'`), so the shell-write grounding fires
on real writes (41 of 47 events follow a command that plainly writes); Hunch did not change how agents edit.

## What changes from version 5

- Arms, tasks, model, timeout, validators, neutral user configuration, exclusions, pricing and criteria: unchanged
  from version 5, so the two versions compare directly.
- Build under test (`current-hunch`): a release carrying the lean-delivery changes below and nothing else new. Each
  change is generic: every host and every repository, not a Claude Code or benchmark special case.
  1. **Small always-loaded block.** The `CLAUDE.md`/`AGENTS.md` block keeps one line saying to call
     `hunch_context(target)` first, and the blocking invariants as id plus a title of at most 120 chars. The moment
     list moves into the `hunch_context` tool description. Target: at most 1,200 chars.
  2. **Short MCP instructions.** At most 500 chars.
  3. **Lean SessionStart.** Orientation line and escalations only; the operating loop is no longer injected by
     default (it stays available through `hunch_runbook`).
  4. **Hook grounding without graph lists.** PreToolUse and shell-write grounding carry no `blast`, `components` or
     landscape lines; those stay in `hunch_context`, `hunch_blast_radius` and `hunch_get_dependents`. Constraints
     in hook grounding are those whose scope matches the file; constraints already served in the session become a
     one-line reference.
  5. **One shell-write block.** A shell command that writes several files gets one merged block, deduplicated
     across files and against grounding already served, not one block per file.
  6. **Short start reply.** The `hunch_task` start reply drops the long instruction paragraph already printed by
     the prompt hook and keeps one line: task id, state and the exact `task verify` command. The finish card stays
     in both `content` and `structuredContent`: Claude Code shows the model only `structuredContent` when a tool
     returns both (`fnd_0ad2885943`), and each host reads one channel, so the copy costs no host anything.
     `task verify` output was checked and is not duplicated.
  7. **No finish call after a verify check alone.** On hosts whose Stop hook closes the task, a `task verify` check
     no longer obliges the agent to call `hunch_task finish`: the Stop hook already closes the task and shows the
     verify evidence. The agent still finishes when it made a `hunch_*` call or has an application to claim. Hosts
     without a Stop hook keep the current rule. Chosen by the maintainer on 2026-10-01 over keeping the rule and
     over dropping agent-side finish entirely (still rejected, as on 2026-09-20); it amends `dec_0bf3bda2c1`.
- Harness: `feat/task-benchmark` with the confinement fix for variable-split launcher forms (`DEVIATIONS.md` (q)):
  a `task verify` launcher held in shell variables and invoked (`$N $H task verify`, `"$N" "$H" task verify`, a
  quoted launcher run through `eval`) no longer flags. Any other use of those paths still flags. Correction to
  `DEVIATIONS.md` (q): the rule never limited which subcommand the launcher runs, so `report --json` is allowed;
  `self-contained-394` run 3 flagged only because the name of its variable `C` also appeared in a Python
  `for c in …` loop in the same command. It too was a false positive, and it still flags under the version 6 fix,
  which does not change the verdict (it was left out either way).
- Seed `pilot5-gate-a-v6`. Output `/Users/Shared/bench-out/pilot5-gate-a6`. Same Mac, kept idle. Build, harness and
  Claude Code versions pinned in the manifest; a mismatch stops the schedule.
- Build: `<package@version, tag, commit>`. Harness: `feat/task-benchmark` at `ceaaafde`. Claude Code: `<claude --version
  at preflight>`.
- Repetitions: 4 per task per arm (40 scored runs), as in version 5.

## Preconditions (all must pass before the first timed run)

1. **Fixed-cost check.** One untimed `current-hunch` and one `no-hunch` smoke session on the same task: the
   first-call input-token difference is at most 1,500 (version 5: about 4,000).
2. **Injection check.** An offline replay of the five tasks (hooks only, as for version 5) shows injected hook text
   at most 50% of the version 5 build's, with micro precision not below the version 5 build's replay (22%) and
   micro recall not below it (34%).
3. **Confinement replay.** The version 6 harness rechecks all 40 version 5 transcripts: exactly one flag
   (`self-contained-394` run 3), no others.
4. Neutral preflight canaries, verify-hint smoke check, one untimed smoke run per arm end to end, frozen and hashed
   eligibility lists: as in version 5.
5. The analysis plan (`GATE-A6-ANALYSIS-PLAN.md`, the version 5 plan with names and paths updated) is hashed before
   the first timed run.

## Criteria (pre-registered, unchanged from version 5)

| # | Measure | Win if |
| --- | --- | --- |
| P1 | Quality: validator pass rate | not more than 5 points below `no-hunch` (a guard: failing it means no win on anything) |
| P2 | Cost ($4 input, $20 output, $0.20 cache read, $5 cache write per million) | pooled ratio below 1.00 |
| P3 | Provider input tokens | pooled ratio below 1.00 |
| P4 | Main-agent steps | pooled ratio below 1.00 |

Verdict: WIN if P1 holds and P2 to P4 all move down. PARTIAL if one or two move down. LOSS otherwise. Secondary
measures as in version 5, plus: first-call input tokens per arm, and injected chars per run by source (the table
above), so the next report can say which cut paid off.

Honesty rule: a win is set up here, not promised. With 4 repetitions the noise (version 5: log SD 0.16 to 0.27)
cannot resolve a 20% difference on any one measure; the verdict uses point ratios, as pre-registered, and the report
says so.

## Lessons applied

| Mistake in version 5 | Guard in version 6 |
| --- | --- |
| Context overhead (fixed 4k per call plus 17k chars per run) not repaid | Lean-delivery build; preconditions 1 and 2 prove the cut before any timed run |
| Task selection left graph lists and constraints unfiltered | Change 4 removes graph lists from hook grounding; constraints filtered by scope and deduplicated |
| Confinement false positives on variable-split launchers voided 3 runs | Harness fix; precondition 3 |
| Breakdown of overhead only reconstructed after the run | Fixed cost and injection by source are reported as secondary measures |
