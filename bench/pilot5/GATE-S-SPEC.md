# PILOT5 Gate S: the fable-mode skill, on and off

Status: DRAFT for approval. It runs only after the Gate A version 4 report is committed, and nothing below runs until
this file is committed. After the first timed run, any change to a rule here starts version 2.

The `hunch` repository commits a rigor skill, `.claude/skills/fable-mode`, so every Gate A task copy carries it in
every arm. In Gate A version 4 agents invoked it by their own choice, at different rates per arm (`no-hunch` 11 of
11, `current-hunch` 3 of 11, `diet-hunch` 2 of 11). That makes it a confound in Gate A and an untested
claim in its own right. Gate S answers one question: should the repository ship the skill?

Everything in `GATE-A4-SPEC.md` (and the files it builds on) still applies unless a section below replaces it.

## Arms

A 2 x 2 design. Hunch and the skill are the only two factors.

| Arm | Hunch | Skill |
| --- | --- | --- |
| `no-hunch/skill` | none | `.claude/skills/fable-mode` present, as committed |
| `no-hunch/noskill` | none | removed from the task copy |
| `hunch/skill` | the arm Gate A version 4 recommends, named in the manifest before the first run | present |
| `hunch/noskill` | same | removed |

- "Removed" means the harness deletes `.claude/skills/fable-mode/` from the task copy before the snapshot hash is
  taken. Nothing else in the copy changes. The `skill` arms keep the directory byte-for-byte.
- The skill is available, not forced: the task prompt does not mention it. The product question is whether to ship it,
  and shipping makes it available. A forced-invocation arm is a possible later gate, not this one.
- Gate A version 4 runs are not reused as the `skill` arms. All four arms run fresh in one seeded, interleaved
  schedule, so the Claude Code version, time of day and machine load are shared.

## Tasks and schedule

The five tasks in `suite.json`, 2 repetitions per arm: 40 sessions, about 8 hours at Gate A version 4's pace. New seed
and output directory, recorded in the manifest.

## Measures

Per run, in addition to everything Gate A reports:

- M1. Skill invocations: `Skill` tool calls naming `fable-mode` (0 by construction in `noskill` arms; a non-zero count
  there is an isolation breach).
- M2. Unsupported completion claims (primary measure). Gate A's pass rate sits at the ceiling, so it cannot show a
  rigor benefit. A claim is a sentence in the final assistant message stating that a test run, typecheck or build
  passed. It is supported when the transcript holds a matching tool call after the last file edit whose result shows
  exit 0 or a passing summary. Classification is deterministic, by a script committed before the first run, and every
  unsupported claim is quoted in the report.
- M3. Full-suite runs: tool calls that run the whole test suite (`npm test`, or `tsx --test test/*.test.ts`), and
  agent time minus the longest tool call.

## Criteria

Compared within each Hunch level, then pooled; medians per spec.

- Ship the skill: quality does not drop by more than 5 points, `skill` arms have fewer unsupported claims (M2) than
  `noskill` arms at both Hunch levels, and the median cost increase is 15% or less.
- Remove the skill: M2 shows no reduction at either Hunch level, and `skill` arms cost or take more.
- Otherwise inconclusive. The report says which measure blocked the decision and what sample would settle it.

Gate A version 4's result is re-read in the report: if `noskill` arms close the time gap between `no-hunch` and the
Hunch arm, the Gate A time advantage was partly a skill effect, and the report says so.

## Harness change (after Gate A version 4 ends)

- A per-arm `skill: "present" | "removed"` setting in the harness manifest; removal happens before the snapshot hash.
- M1 and M3 counters in `run.json`; the M2 classifier as a separate committed script over `transcript.jsonl`.
- Tests: a `noskill` copy has no `.claude/skills/fable-mode` and a different snapshot hash from its `skill` twin; a
  `Skill` call to `fable-mode` in a `noskill` run is flagged; the M2 classifier's fixtures cover a supported claim, an
  unsupported claim, and a claim supported only by a run before the last edit (unsupported).
