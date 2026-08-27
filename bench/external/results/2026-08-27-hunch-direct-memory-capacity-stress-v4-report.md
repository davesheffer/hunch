# Direct memory capacity stress: protocol v4 report

## Outcome

The stress benchmark is **valid and complete**. It found a genuine
replacement-only semantic corruption in one repeat, but the effect did **not**
meet the preregistered threshold for confirming a repeatable material
degradation mechanism.

All 102 planned CLI invocations completed across three repeats. All 540
generated replacement memories obeyed the 100-word maximum, and every repeat
passed all Clean and Additive calibration gates.

| Repeat | Clean | Additive | Rewritten | Rescue | Paired harms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 72/72 | 72/72 | 72/72 | 72/72 | 0 |
| 2 | 72/72 | 72/72 | 72/72 | 72/72 | 0 |
| 3 | 72/72 | 72/72 | 66/72 | 72/72 | 6 |
| **Pooled** | **216/216** | **216/216** | **210/216** | **216/216** | **6** |

All conditions also scored 108/108 on their later-fact checks; for Clean this
means correctly returning `UNKNOWN`, and for the other conditions it means
retaining all six scored later facts.

## What went wrong in repeat 3

At round 22, each case received a prototype schema namespace that was explicitly
separate from its protected production schema namespace. Beginning at round 26,
repeat 3 compressed the two facts into one combined value for every case, for
example:

`schema_namespace=aster.violet/prototype`

The protected answer was `aster.violet`. The downstream QA model copied the
combined value, producing six exact-score failures—one schema-namespace failure
per case. Additive kept the two records separate and answered all six correctly.
Rescue restored the original authoritative seed and recovered all six.

This is a meaningful fault rather than simple omission: the original nonce
remained literally present inside the merged string. Consequently, the
per-round substring trace reported 6,480/6,480 protected values retained even
though downstream QA was wrong. Literal-presence checks alone would have missed
the semantic corruption.

The six failures are one correlated batch-level pattern, not six independent
replications. Repeats 1 and 2 retained production and prototype namespaces as
separate fields and remained perfect.

## Frozen-rule verdict

- Calibration: **pass** in every repeat.
- Additive minus Rewritten: **2.78 percentage points**, below the required 10.
- Harms versus wins: **6 versus 0**, passes that directional component.
- Repeat consistency: Additive exceeded Rewritten in **1/3** repeats, below the
  required 2/3.
- Rescue: **6/6 harms recovered**, passing the 50% rescue component.
- Overall bounded-replacement mechanism: **not supported under the frozen
  rule**.
- Overall Hunch mitigation pattern: **not supported under the full frozen
  rule**, because mechanism confirmation was required first. The Additive arm
  itself nevertheless matched Clean at 216/216 and avoided the observed merge.

The correct conclusion is: **one reproducible-within-batch semantic corruption
signal, but not yet a repeatable material effect across independent runs**.

## Comparison with the earlier null test

The v2 test used four protected facts, twelve rewrites, and a 120-word limit; all
conditions scored 96/96. V4 used twelve protected facts, thirty rewrites, and a
compact 100-word hard limit. It moved from a complete null to one
replacement-only fault pattern, while Clean, Additive, and Rescue remained
perfect.

That progression is consistent with information pressure increasing risk, but
the preregistered evidence is insufficient to claim the paper's mechanism as a
stable effect for this model.

## Integrity and execution

- Frozen v4 commit: `4fed7c2ee7b060846a4cbb6273d21e5b4f520729`
- Model: `claude-sonnet-5`
- Claude Code CLI: 2.1.186
- Runner SHA-256:
  `b62a6dfc36355039e89a6e12ab810890e7da8a19a94f8ff12e0fd917a50737eb`
- Case-bank SHA-256:
  `3805543c8fa5a5373e35ba7efbb429eebc5e58b95463172151d51d64c6f31f2e`
- CLI-reported cost: approximately $15.4924
- Aggregate call duration: 42.15 minutes; concurrent wall time: about 15.4
  minutes.

The raw files preserve every prompt hash, generated checkpoint, memory length,
CLI envelope, structured output, exact unit score, and paired score. The v3
protocol-stop records are preserved separately and excluded: they produced no
QA outcome.

## Scientifically clean next step

A new targeted replication should isolate namespace-like fact collisions,
execute each case in separate calls to remove batch correlation, and increase
independent repeat count. It must be preregistered as a replication of this
specific merge signature—not used to reinterpret or replace the frozen v4
verdict.
