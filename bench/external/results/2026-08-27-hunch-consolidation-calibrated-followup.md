# Hunch consolidation-safety calibrated follow-up

## Verdict

**Stopped after calibration: no eligible task.** All six preregistered candidates scored 0/2 on
primary source accuracy. The frozen rule required exactly 1/2, so the C-top/C-full treatment phase
was not run.

This is a successful guard against repeating the 2026-08-26 floor-effect pilot, but it produces no
new evidence for or against the harmful-memory mechanism in [Zhang et al., "Useful Memories Become
Faulty When Continuously Updated by LLMs"](https://arxiv.org/abs/2605.12978).

## Calibration results

| Task | Source passes | Issue-contract passes | Turns | Eligible? |
|---|---:|---:|---|---|
| `zod-4461` | 0/2 | not available | 40, 51 | No — floor |
| `zod-5229` | 0/2 | not available | 24, 21 | No — floor |
| `zod-5296` | 0/2 | not available | 30, 18 | No — floor |
| `zod-5625` | 0/2 | 2/2 | 49, 48 | No — source floor |
| `zod-5842` | 0/2 | not available | 25, 20 | No — floor |
| `zod-5917` | 0/2 | 0/2 | 51, 34 | No — floor |

`zod-5625` is informative about the scorer boundary: both agents satisfied the narrower issue
contract, but both failed the authentic merged-fix test suite, including codec inversion behavior in
classic and mini. Because source accuracy was preregistered as primary, it correctly remains 0/2
and ineligible.

## Integrity

- Preregistration committed as `da6f3d1` before any calibration solver call.
- Snapshot manifest committed as `db459fb` before any calibration solver call.
- Solver: `claude-sonnet-5` via Claude Code 2.1.186; A arm only; two repeats; 50-turn maximum;
  `--no-repro`.
- 12/12 rows valid; zero infrastructure exclusions, retries, or replacement assignments.
- Future-free history, pre-fix-only ancestry, isolated hidden scoring, deny-all network, and denied
  web tools were reported for every shard.
- One ordinary `zod-5296` failure touched an existing upstream test file. It remains in the totals.
- Every row changed at least one file; the floor is not explained by agents simply making no edit.

## Frozen memory work

Before calibration, six task-specific C-top snapshots were derived from the existing immutable
167-decision snapshot. They contain 4–5 query-selected decisions each. Retained decision JSON was
byte-identical to C-full, the structural graph used the same cutoff revision, and all snapshots were
clean committed checkouts.

No snapshot reached a solver because calibration admitted no task. Consequently there are no
memory calls, paired harms/wins, delivery IDs, abstentions, token costs, or record-surgery result in
this follow-up. Treating the unused snapshots as treatment evidence would be invalid.

## Interpretation

The first pilot showed an evaluation floor on two tasks. This broader screen shows that the problem
persists across six task areas under the current exact-source protocol and model argument. Prior
sealed runs had different pass rates for several of these tasks, so historical headroom was not a
safe substitute for fresh calibration. The model argument also does not expose a deterministic seed
or a pinned serving-build receipt.

The correct next move is a new preregistration that changes one calibration dimension deliberately:
a stronger pinned solver receipt if available, a task pool constructed for partial exact-source
success, or a separately justified contract-level primary outcome. Adding post-hoc repeats or tasks
to this run would violate its no-extension rule.

## Artifacts

- Preregistration: `2026-08-27-hunch-consolidation-calibrated-followup-preregistration.md`
- Snapshot manifest: `2026-08-27-hunch-consolidation-calibrated-followup-manifest.json`
- Machine-readable summary: `2026-08-27-hunch-consolidation-calibrated-followup.json`
- Raw shards: `2026-08-27T02-58-29-323Z-p8849.json`,
  `2026-08-27T02-58-29-323Z-p8850.json`, and
  `2026-08-27T02-58-29-324Z-p8851.json`
