# PILOT5 selection rule (preregistered)

Frozen 2026-09-27, before any issue card was built and before any benchmark arm ran.
Plan: `docs/HUNCH-CONTEXT-EFFICIENCY-POC.md`, sections 8 and 15.

## Population

- GitHub issues in `davesheffer/hunch` numbered #211–#400 (created 2026-09-13 to 2026-09-22).
- Closed as fixed, with a merged fix commit on `main`. The pilot is **retrospective only**:
  open issues would be prospective measurements, and the plan forbids blending the two.

## Qualification (every item must hold)

1. The starting commit is the first parent of the earliest fix commit, and the problem is present there.
2. The starting-state proof is deterministic and reproduces on this machine (Windows 11, Node 22).
   Platform-only defects for macOS or Linux, timing races and network-dependent defects are excluded.
3. An independent validator exists or can be derived from the fix's own regression test.
   It must fail at the starting commit, pass at the fix commit, and run outside the agent workspace.
4. The fix touches at most 6 non-test source files, so one agent run fits the timeout.
5. The fix is not bundled so tightly with another issue's fix that the validator cannot isolate it.
6. Issue text available at task arrival does not disclose the solution.

## Categories

Assign each candidate from its issue text and the memory available at its creation time.

| Category | Criterion |
| --- | --- |
| repeated-bug | The issue names an earlier issue or fix of the same defect family. |
| continuation | The issue continues a recorded decision or a sibling issue in the same series. |
| convention | The correct fix is governed by an existing constraint or recorded repository convention. |
| operation | Release, CI, packaging or verification work. |
| self-contained | None of the above; Hunch should abstain. |

## Order within a category

Walk the candidate list in the order below (issue number, descending) and take the **first** issue that
qualifies. Log every skipped candidate with its reason. Do not skip a qualifying candidate because
its memory looks weak or strong. If no candidate qualifies, the category has no card; do not relax
the rules to fill the quota.

The lists come from issue titles only. A candidate whose issue text contradicts its category is
logged as `excluded: category mismatch` and the walk continues.

| Category | Candidates in order |
| --- | --- |
| repeated-bug | #360, #335, #334, #331, #316 |
| continuation | #375, #372, #371, #370, #369, #266 |
| convention | #357, #315, #314, #312, #310 |
| operation | #398, #379, #378, #270, #268, #211 |
| self-contained | #397, #395, #394, #307, #301 |

## Memory cutoff

Memory eligible for a card is what existed before the issue's `createdAt`, proven by the record
file's first commit time in `.hunch/` (public) or in the private overlay repository, together with
the record's own capture timestamp. A record imported later with an older timestamp is excluded.
Today's memory snapshot is never substituted for historical memory.
