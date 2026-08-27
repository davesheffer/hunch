# Preregistration: direct repeated-memory degradation benchmark

Status: **frozen before experimental model calls** on 2026-08-27 at base commit
`0973ec903b4407ec904653d855cf5cae1ace69d5`. Dry runs, unit tests, typechecking,
and `claude --version` were run before freezing; none invokes a model. No
benchmark update or QA call has been made.

## Question

Does repeatedly replacing a useful textual memory cause loss of stable facts,
relative to retaining the same information as immutable additive records? If
so, does restoring the authoritative original record rescue downstream use?

This directly tests the mechanism reported by Zhang et al., *Useful Memories
Become Faulty When Continuously Updated by LLMs* (arXiv:2605.12978v1), rather
than using coding-task success as a noisy proxy. The locally supplied source
PDF has SHA-256
`16613d73b3dfe8de8dd73d42c4fb7b2e803b84a78d7ecf748c9e23a7e3b4aa92`.

## Frozen hypotheses

- **H1, degradation:** repeatedly replaced memory will have lower downstream
  protected-fact accuracy than an immutable additive log.
- **H2, rescue:** appending the authoritative original record to the final
  rewritten memory will recover a material share of protected facts harmed by
  replacement.
- **H3, Hunch design relevance:** the immutable-additive condition will remain
  close to the clean seed condition. Passing H3 supports Hunch's immutable
  record design principle; it does not establish whole-product coding efficacy
  or reproduce Hunch's selective retrieval layer.

## Frozen materials

- Eight synthetic projects.
- Four protected stable facts per project: queue, retry cap, idempotency header,
  and forbidden fallback. Values are unique nonces and appear in the original
  seed memory.
- Twelve later, non-conflicting observations per project. Similar queue,
  retry, and header facts are explicitly scoped to other components. Protected
  nonce text is never re-exposed in an update.
- Two later facts per project, current owner at update four and rollout window
  at update nine, measure whether new facts are incorporated.
- Case-bank validation, packet construction, exact scoring, paired scoring, and
  CLI-envelope parsing are covered by six unit tests.

The frozen case bank contains 32 primary protected units per repeat and 16
later-fact units per condition per repeat.

## Conditions

Each downstream QA condition is a fresh, tool-free model invocation and sees no
condition label.

1. **Clean:** authoritative original seed only.
2. **Additive:** original seed plus all twelve immutable update records. Later
   records add information and do not replace earlier records.
3. **Rewritten:** final memory produced by twelve sequential replacement calls.
   Each call receives the previous generated memory and one new non-conflicting
   observation, and must return a self-contained memory of at most 120 words.
4. **Rescue:** final rewritten memory plus the authoritative original seed as a
   recovery record.

The updater operates on all eight cases in a batch but must return one isolated
memory per unchanged case ID. Case order rotates by update round and repeat.
Downstream QA asks the same six questions in every condition. Absent values must
be returned as `UNKNOWN`.

## Execution plan

- Model: `claude-sonnet-5` through Claude Code CLI 2.1.186 using subscription
  authentication, with API keys and Bedrock/Vertex routing variables removed.
- Isolation: `--safe-mode`, no tools, no slash commands, no session persistence,
  fixed system prompt, JSON Schema constrained output, neutral temporary working
  directory, and one turn per invocation.
- Three independent repeats, indexed 1, 2, and 3.
- Sixteen CLI invocations per repeat: twelve sequential replacement updates,
  then four fresh QA calls. Total planned invocations: 48.
- QA order rotates to reduce order/time confounding:
  - repeat 1: Clean, Additive, Rewritten, Rescue;
  - repeat 2: Additive, Rewritten, Rescue, Clean;
  - repeat 3: Rewritten, Rescue, Clean, Additive.
- All three repeats will be run without outcome-based stopping. There are no
  manual retries, substitutions, or exclusions. A CLI/schema/shape failure is
  recorded as an infrastructure failure, not scored as a memory error. The
  CLI's own schema-constrained generation is part of one invocation.

## Scoring and estimands

No LLM judge is used. String scoring applies Unicode NFKC normalization,
trimming, case folding, and whitespace collapse only. Numeric words are not
accepted for digit answers, and explanations are not stripped.

Primary outcome: protected-fact exact accuracy for each condition. The primary
causal contrast is pooled Additive minus Rewritten accuracy over 96 paired
protected units (8 projects × 4 facts × 3 repeats).

For every paired unit:

- a **harm** is Additive correct and Rewritten wrong;
- a **win** is Additive wrong and Rewritten correct;
- a **rescued harm** is a harm that becomes correct under Rescue.

Secondary outcomes are later-fact accuracy, per-round literal retention of each
protected value in rewritten memory, and memory word/character counts. Literal
retention is a manipulation trace, not the primary outcome; QA accuracy decides
whether a memory remains useful.

## Frozen validity gates

The experiment is interpretable only if every planned call completes and every
repeat meets both calibration gates:

- Clean protected accuracy is at least 31/32 (96.875%).
- Additive later-fact accuracy is at least 15/16 (93.75%).

If either gate fails in any repeat, all raw evidence will still be reported,
but the run will be labelled calibration-invalid and will not confirm or refute
the mechanism.

## Frozen decision rules

Subject to the validity gates, the result supports the repeated-replacement
mechanism only if all of the following hold:

- pooled Additive protected accuracy exceeds pooled Rewritten accuracy by at
  least 10 percentage points;
- paired harms outnumber paired wins;
- the same direction, Additive above Rewritten, appears in at least two of the
  three repeats; and
- Rescue recovers at least 50% of harmed units.

The result supports the Hunch immutable-additive mitigation pattern only if the
mechanism rule above passes and pooled Additive protected accuracy is no more
than 5 percentage points below pooled Clean accuracy.

If the validity gates pass but the mechanism rule does not, the conclusion is
"no evidence of material repeated-replacement degradation under this frozen
configuration," not a universal falsification of the paper. Thresholds will
not be changed after outcomes are observed.

## Limitations fixed in advance

The cases are synthetic and compact, the model is also used as downstream QA,
the eight cases share batched calls, and only one model/configuration is tested.
The benchmark isolates a mechanism and its additive-record mitigation; it does
not estimate production incidence, long-horizon coding quality, retrieval
quality, or effects for other models.
