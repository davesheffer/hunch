# Direct repeated-memory degradation benchmark: v2 report

## Outcome

The benchmark is **valid and complete**, but it did **not** reproduce material
memory degradation in this configuration.

All 48 preregistered CLI invocations completed across three repeats. Every
repeat passed both frozen calibration gates. Clean, immutable Additive,
repeatedly Rewritten, and seed-restored Rescue memory each scored 96/96 on the
pooled protected-fact outcome.

| Condition | Protected facts | Accuracy | Later-fact check |
| --- | ---: | ---: | ---: |
| Clean | 96/96 | 100% | 48/48 absent as expected |
| Additive | 96/96 | 100% | 48/48 retained |
| Rewritten | 96/96 | 100% | 48/48 retained |
| Rescue | 96/96 | 100% | 48/48 retained |

Primary Additive minus Rewritten difference: **0 percentage points**. There
were zero paired harms and zero paired wins. With no harmed unit, rescue rate is
undefined rather than zero.

## Frozen-rule verdict

- Calibration validity: **pass**. Each repeat scored 32/32 Clean protected
  facts and 16/16 Additive later facts, above the frozen 31/32 and 15/16 gates.
- Repeated-replacement mechanism: **not supported**. The required effect was at
  least 10 percentage points; observed effect was zero.
- Hunch immutable-additive mitigation: **not supported under the full frozen
  rule**. Additive did match Clean exactly, but the rule also required an
  observed Rewritten harm to mitigate.

The correct conclusion is the preregistered null wording: **no evidence of
material repeated-replacement degradation under this frozen configuration**.
This does not universally refute Zhang et al.; it bounds the claim for this
model, prompt, horizon, and fact load.

## Manipulation trace

Literal protected values remained present in 1,152/1,152 per-round checks (32
facts × 12 rounds × 3 repeats). Final rewritten memories averaged 116.875 words
(range 116–118) under the 120-word cap. The updater therefore approached the
capacity boundary but still fit the accumulated memory while preserving every
scored original and later fact for downstream QA.

This trace makes the null interpretable: the test did not fail because QA was
incapable or because the replacement arm was accidentally given the immutable
seed. The replacement operation itself retained all tested facts across twelve
rewrites.

## Integrity and execution

- Frozen v2 commit: `f2f639dc95435793e582b31f258f3963681de649`
- Model: `claude-sonnet-5`
- Claude Code CLI: 2.1.186
- Runner SHA-256:
  `be6b94199399fbd47fc158775711ed602585ff445d9479f2fc538caac1b93583`
- Case-bank SHA-256:
  `b328919518e05e7409213dc30567166d986417bd7ece88bce3a587a04f052ccf`
- Total CLI-reported cost: approximately $4.3701
- Aggregate call duration: 11.63 minutes; the three repeats ran concurrently.

The three raw v2 files preserve every generated checkpoint, prompt hash, outer
CLI envelope, structured output, exact unit score, and paired score. The first
v1 launch is also preserved separately as an infrastructure stop: its one-turn
limit was incompatible with Claude Code's StructuredOutput finalization, and it
produced zero completed checkpoints and zero QA calls. Protocol v2 changed only
that transport limit and output filenames before refreezing.

## What this establishes for Hunch

This experiment avoids the source-accuracy floor that invalidated the earlier
coding-agent pilots. It establishes that the direct mechanism is measurable and
that Hunch's immutable-additive representation is lossless on this case bank.
It does not show that immutable storage prevented a loss here, because the
replacement control also remained lossless.

A separate preregistered stress extension—not a post-hoc reinterpretation of
this run—would be needed to test longer horizons, information loads that exceed
the consolidation cap, noisier observations, and other models. Only if such a
run produces paired Rewritten harms with Additive and Rescue controls intact can
it support the paper mechanism and the Hunch mitigation claim.
