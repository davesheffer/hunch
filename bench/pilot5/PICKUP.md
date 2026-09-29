# PILOT5: where to pick up (after Gate A version 4)

Read `GATE-A4-REPORT.md` first ("In short" and "Recommendations").

## State on 2026-09-29

- Gate A version 4 ran in full: 33 runs, output kept on the benchmark machine only (`C:/bench-out/pilot5-gate-a4`,
  about 4.6 GB of transcripts and patches; not in git).
- Committed with the report: the analysis plan (`GATE-A4-ANALYSIS-PLAN.md`), deviation (k) in `DEVIATIONS.md`, the
  draft follow-up gate (`GATE-S-SPEC.md`, not yet reviewed) and the analysis tools in `tools/`
  (`gate-a4-tooltime.mjs`, then `gate-a4-stats.ps1` under PowerShell 7; both read the run output directory).
- The private store is registered back to its normal location; the overlay redirect used during the run is undone.

## Next steps, in order

1. Harness: fix the confinement tokenizer for unused variable assignments (`DEVIATIONS.md` (k)). This is a rule
   change, so the next timed run is a new gate version.
2. Product, context efficiency:
   - `task verify` defaults to targeted tests and a budget below the 10-minute Bash cap.
   - Memory selected by task text and named files, silent without a confident match; no recent-by-date or roadmap
     lists at session start; no re-injection after a shell write when records are unchanged.
3. Gate S: critic review of `GATE-S-SPEC.md`, then run it (the `fable-mode` confound).
4. Next measured gate: main-agent steps and input tokens as primary measures; wall time is too noisy at this n
   (about 120 runs per arm to see a 20% time difference).
5. A gate with Codex as the agent (same suite, `no-hunch` against `current-hunch`): spec to be drafted.
