# Hunch consolidation-safety pilot - preregistration

Frozen before any synthesis or solver-model call on 2026-08-26.

## Question

Does accumulating Hunch's per-commit LLM abstractions make a coding agent less accurate than the
same agent with no memory or with bounded raw execution episodes, as predicted by Zhang et al.,
"Useful Memories Become Faulty When Continuously Updated by LLMs" (arXiv:2605.12978v1)?

The paper studies repeatedly rewritten natural-language memory banks. Hunch instead stores
commit-keyed records without rewriting their source evidence. This pilot therefore tests the closest
remaining transfer mechanism: **logical overwrite at delivery time**, where additional abstractions
can crowd out, overgeneralize, or misdirect retrieval even though no record is physically destroyed.

## Frozen tasks and model

- Tasks: `zod-5917` and `zod-5937` from `bench/external/zod-tasks.json`.
- Reason for selection: both have pre-existing fixed-cutoff raw-episode fixtures, hidden future tests,
  and non-ceiling prior baselines. `zod-5625` is excluded because the prior no-memory baseline was
  already 3/3, leaving no useful room to measure improvement.
- Solver: `claude-sonnet-5` through the installed Claude Code subscription CLI.
- Three independent repeats per task and condition; 24 valid sessions total.
- Diagnosis mode: `--no-repro`; future regression tests remain hidden until isolated scoring.
- Maximum turns: 50. Network and web tools are denied by the existing sealed harness.
- No outcome-based stopping. The run ends only after all preregistered sessions are valid or a
  documented infrastructure block prevents completion.

## Frozen evidence and memory construction

The Zod memory source is checked out at the last commit on or before the suite cutoff
`2026-01-08`. Current Hunch builds the structural graph at that revision. Decision synthesis uses
the explicitly selected `claude-cli` subscription provider, default single-pass synthesis, at most
200 historical commits, and no critic/deep pass. The actual commit IDs, record counts, provider
receipts, Hunch revision, and Zod revision will be recorded in the final report.

All unique commits cited by the fixed raw episodes are explicitly synchronized if the general
backfill did not already capture them. This ensures that the relevant-abstraction and raw-episode
conditions derive from the same legitimate pre-cutoff evidence.

Two immutable Hunch snapshots are then derived from that one synthesis run:

1. **Relevant-only abstraction (`C-rel`)**: the structural graph plus only commit-keyed decisions
   whose provenance commits occur in the fixed episode fixtures for the two selected tasks.
2. **Accumulated abstraction (`C-full`)**: the same structural graph and relevant decisions plus all
   other captured pre-cutoff decisions. No record is re-synthesized between snapshots.

The comparison therefore changes accumulated abstraction volume, not the relevant record text,
code snapshot, solver, task, or evidence cutoff.

## Conditions

- `A` - no Hunch and no supplied episode.
- `E` - one bounded raw proven-work episode from
  `bench/external/zod-execution-episodes.json`; no Hunch graph.
- `C-rel` - forced `hunch_context` consultation against the relevant-only abstraction snapshot.
- `C-full` - forced `hunch_context` consultation against the accumulated abstraction snapshot.

The existing harness arm `C` is used for both Hunch snapshots in separate recorded invocations;
`memorySource` and a snapshot manifest disambiguate them. Arm ordering is alternated. Runs from
different conditions do not share an agent checkout or conversation.

## Outcomes

Primary outcome: source accuracy under the hidden merged-fix tests, using the harness's isolated
scorer. Existing upstream test files must remain untouched.

For each treatment `T`, paired against `A` by task and repeat number:

- harmful-memory regression: `A=PASS, T=FAIL`;
- memory win: `A=FAIL, T=PASS`;
- net treatment direction: wins minus harms;
- aggregate passes out of six.

For accumulation, `C-full` is also paired against `C-rel`:

- accumulation harm: `C-rel=PASS, C-full=FAIL`;
- accumulation win: `C-rel=FAIL, C-full=PASS`.

Secondary outcomes: issue-contract accuracy where available, turns, elapsed time, Hunch call count,
delivered decision IDs, abstentions, withheld-record count, and changed source files. With six pairs
per comparison, exact McNemar statistics are descriptive only; this is a mechanism pilot, not a
population-level efficacy claim.

## Retrieval checkpoint audit

Before solver scoring is inspected, replay each issue query against structural-only, relevant-only,
and 25/50/75/100-percent accumulated decision snapshots. Record delivered IDs, ranks, abstention,
token cost, and whether the fixed relevant decisions remain present and retrievable. This audit tests
monotonic accumulation without adding solver calls. Prefixes are derived from `C-full` by commit
time; records are never rewritten.

## Interpretation rules

- **Supports transfer of the paper's warning to Hunch:** `C-full` has at least one accumulation harm
  and net direction below `C-rel`, or it has more harms than wins versus `A` while `E` does not.
- **Supports Hunch's architectural mitigation:** relevant records remain byte-identical and
  recoverable at every checkpoint, `C-full` has no accumulation harms, and weak distractors are
  visibly abstained/withheld rather than silently displacing relevant evidence.
- **Supports episodic-first delivery:** `E` has fewer harms and at least as many passes as `C-full`.
- Anything else is **mixed/inconclusive**. No conclusion may be upgraded because of turns, prose
  quality, or an attractive individual trajectory.

## Causal follow-up

If and only if a `C-full`-specific loss occurs and its transcript identifies delivered memory that
plausibly changed the diagnosis, perform one fresh record-level surgery run with those record files
removed from a copy of `C-full`. This diagnostic is reported separately and never added to the
preregistered primary totals. If no such loss occurs, no post-hoc harmful record is invented.

## Exclusions and integrity

Exclude only rows the harness labels as infrastructure failures. Preserve and report all ordinary
failures, timeouts, unresolved completions, abstentions, and test-file violations. Every treatment
checkout must contain authentic Git ancestry only through the task's pre-fix commit; every memory or
episode provenance commit must be reachable; the target fix and future objects must be absent; hidden
tests run only in the separate scorer checkout.
