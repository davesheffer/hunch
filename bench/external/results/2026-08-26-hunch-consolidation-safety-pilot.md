# Hunch consolidation-safety pilot

## Verdict

**Mixed/inconclusive because of a complete floor effect.** All 24 preregistered sessions were valid,
and every condition scored 0/6 on hidden source accuracy and 0/6 on the independent issue
contracts. Accumulated Hunch memory produced no paired harm, but relevant-only memory, raw episodes,
and no memory also produced no wins. This experiment therefore neither validates the harmful-memory
mechanism from [Zhang et al., "Useful Memories Become Faulty When Continuously Updated by
LLMs"](https://arxiv.org/abs/2605.12978) for Hunch nor establishes that Hunch is protected from it.

The paper repeatedly rewrites a textual memory bank. Hunch stores immutable, commit-keyed records.
This pilot tested the closest applicable transfer mechanism: whether adding 162 unrelated
abstractions can crowd out or misdirect delivery while the five relevant records remain unchanged.

## Integrity

- Preregistration: `ba38aa6`; snapshot manifest: `0a9fc96`.
- Solver: `claude-sonnet-5` via Claude Code 2.1.186; three repeats; 50-turn maximum;
  `--no-repro`; forced Hunch consultation for both Hunch conditions.
- 24/24 rows valid; zero infrastructure exclusions or retries.
- All runs report future-free history through the pre-fix commit, isolated scoring, deny-all network,
  and denied web tools.
- Full-memory provenance: 167/167 commits reachable. Relevant-only provenance: 5/5 reachable.
- The five relevant record files are byte-identical between the full and relevant-only snapshots.
- Three ordinary failure rows touched an existing upstream test file: A once and E twice. These rows
  remain in the totals as preregistered. The separate scorer checkout was clean in every row.

## Primary results

| Condition | Source passes | Issue-contract passes | Wins vs A | Harms vs A |
|---|---:|---:|---:|---:|
| A — no memory | 0/6 | 0/6 | — | — |
| E — bounded raw episode | 0/6 | 0/6 | 0 | 0 |
| C-rel — five relevant abstractions | 0/6 | 0/6 | 0 | 0 |
| C-full — 167 accumulated abstractions | 0/6 | 0/6 | 0 | 0 |

The direct accumulation comparison is also all ties:

| Comparison | Accumulation wins | Accumulation harms | Concordant failures |
|---|---:|---:|---:|
| C-full vs C-rel | 0 | 0 | 6 |

All discordant-pair counts are zero, so an exact McNemar calculation contains no information. No
`C-full`-specific loss occurred; the preregistered record-surgery follow-up was therefore not
triggered.

## Secondary outcomes

| Condition | Mean turns | Mean elapsed | Hunch calls | Decisions delivered | Supplements delivered | Abstentions / withheld | Item token cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| A | 50.5 | 488.7 s | 0 | 0 | 0 | 0 / 0 | — |
| E | 50.7 | 384.5 s | 0 | 0 | 0 | 0 / 0 | — |
| C-rel | 49.5 | 314.6 s | 14 | 3 | 44 | 1 / 1 | 2,626 |
| C-full | 49.3 | 352.9 s | 18 | 3 | 20 | 4 / 25 | 2,070 |

`Hunch calls` includes all Hunch MCP invocations. Each Hunch row made exactly one structured
`hunch_context` call; `Item token cost` sums the token-cost fields on delivered decisions and
supplements, not wrapper text or the solver's total context usage.

For `zod-5917`, both snapshots delivered one decision per repeat. C-rel delivered
`dec_875001003a` in all three repeats; C-full delivered `dec_875001003a` twice and
`dec_2fbac4f75a` once. Both are among the five fixed relevant records. None produced a passing fix.

For `zod-5937`, neither snapshot delivered a decision. C-full abstained on all three structured
context calls and withheld 24 low-confidence or low-relevance decisions; C-rel delivered eight
structural-symbol supplements per call. Both still failed. The remaining one C-full abstention and
one withheld record occurred on `zod-5917` repeat 3.

## Retrieval checkpoints

Before any solver score was inspected, the same two fixed issue queries were run against the
structural graph, chronological 25/50/75/100-percent decision prefixes, and the relevant-only
snapshot. Ranks below are within the top eight results and list only fixed relevant records.

| Snapshot | Decisions | zod-5917 relevant ranks | zod-5937 relevant ranks |
|---|---:|---|---|
| structural-only | 0 | — | — |
| prefix 25% | 41 | `875@1`, `2fb@3`, `5db@4` | `875@2`, `2fb@4` |
| prefix 50% | 83 | `875@1`, `2fb@5`, `5db@6` | `875@2`, `2fb@4` |
| prefix 75% | 125 | `875@1`, `2fb@5`, `5db@6` | `875@2`, `2fb@3` |
| C-full | 167 | `875@1`, `4cf@2`, `2fb@5`, `5db@6` | `875@1`, `2fb@3`, `4cf@5` |
| C-rel | 5 | `875@1`, `4cf@2`, `2fb@4`, `5db@5` | `875@3`, `4cf@4`, `2fb@5` |

Abbreviations are the distinguishing prefixes of `dec_875001003a`, `dec_4cf174e125`,
`dec_2fbac4f75a`, and `dec_5db25c7e3c`.

Accumulation inserted distractors into `zod-5917` ranks 3–4 and moved two relevant records down one
place, but kept them in the top six. For `zod-5937`, accumulation moved all three shown relevant
records upward while also adding distractors. The rank audit therefore shows neither destructive
loss nor uniformly monotonic degradation.

The checkpoint audit used the text-only `hunch query` command. It preserves IDs and ranks but does
not emit token-cost, abstention, or withheld-record fields. This is an instrumentation deviation
from the preregistration. Those fields are available above for the actual solver MCP calls, but
cannot be retroactively attributed to the fixed pre-solver queries.

## Frozen-rule interpretation

- **Paper-warning transfer:** not supported. C-full had zero accumulation harms and the same net
  direction as C-rel.
- **Hunch architectural mitigation:** not established. Records were additive and byte-stable, and
  weak candidates were visibly filtered in the live calls, but the checkpoint series had rank
  displacement and the complete accuracy floor prevents a safety inference.
- **Episodic-first delivery:** not supported. E tied C-full on passes and harms; it did not have
  strictly fewer harms.
- **Overall:** mixed/inconclusive, exactly as the preregistration assigns to outcomes outside those
  three rules.

## What this changes

Do not cite this pilot as evidence that Hunch accumulation is safe or harmful. Its useful result is
methodological: the immutable-snapshot and retrieval-audit setup works, full-memory filtering is
observable, and the selected task/model pair has no discriminatory headroom under this protocol.

A follow-up should first calibrate tasks to a nonzero, non-ceiling no-memory pass rate under the
same sealed harness. Only then should it repeat the byte-identical C-rel/C-full contrast. Increasing
repeats on these two tasks without restoring baseline headroom would only measure the same floor
more precisely.

## Artifacts

- Preregistration: `2026-08-26-hunch-consolidation-safety-pilot-preregistration.md`
- Snapshot manifest: `2026-08-26-hunch-consolidation-safety-pilot-manifest.json`
- Machine-readable summary: `2026-08-26-hunch-consolidation-safety-pilot.json`
- Raw accumulated/control/episode shards:
  `2026-08-26T18-40-12-129Z-p79616.json`,
  `2026-08-26T18-40-12-129Z-p79617.json`, and
  `2026-08-26T18-40-12-129Z-p79618.json`
- Raw relevant-only shards: `2026-08-26T19-22-32-492Z-p65452.json`,
  `2026-08-26T19-28-20-854Z-p21049.json`, and
  `2026-08-26T19-27-11-445Z-p19590.json`
