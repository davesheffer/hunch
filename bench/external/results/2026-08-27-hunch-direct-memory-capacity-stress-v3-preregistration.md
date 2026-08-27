# Preregistration: direct memory capacity stress, protocol v3

Status: **frozen before v3 model calls** on 2026-08-27 at base commit
`5dd9f27aa91e94e96eae6490fecfe2863c5c0d50`.

The calibration-valid v2 benchmark found no loss after twelve rewrites: every
condition scored 96/96. Protocol v3 is a separate, prospectively specified
capacity-stress extension. No v3 replacement or QA call has been made. Unit
tests, typechecking, dry runs, hashing, and CLI version inspection do not invoke
a model.

## Question and hypotheses

When accumulated useful information exceeds a bounded rewritten memory's
comfortable capacity, does repeated LLM replacement lose stable original facts
that remain available in an immutable additive log?

- **H1, capacity degradation:** Rewritten protected-fact accuracy will be lower
  than Additive protected-fact accuracy.
- **H2, authoritative rescue:** restoring the original seed after the final
  rewrite will recover a material share of protected facts harmed by rewriting.
- **H3, Hunch design relevance:** Additive will remain close to Clean while
  Rewritten falls. Passing this supports Hunch's immutable-additive design
  principle under information pressure, not whole-product coding efficacy.

## Frozen case bank

- Six synthetic projects.
- Twelve unique protected nonce facts per original seed: queue, retry cap,
  idempotency header, forbidden fallback, primary region, schema namespace,
  encryption profile, audit topic, health path, lease seconds, recovery
  contact, and checksum salt.
- Thirty later non-conflicting observations per project.
- Six scored later facts introduced at rounds 3, 8, 13, 18, 23, and 28:
  current owner, documentation locale, deployment zone, rollout window,
  compliance tag, and escalation room.
- Similar-looking queue, retry, header, fallback, schema, encryption, health,
  audit, region, and lease distractors are explicitly scoped to other
  components. Updates never re-expose protected nonce text.
- Original seeds fit below the 100-word limit before the first update.

There are 72 primary protected units and 36 later-fact units per condition per
repeat.

## Conditions

1. **Clean:** authoritative original seed only.
2. **Additive:** original seed plus all thirty immutable update records.
3. **Rewritten:** memory replaced sequentially thirty times. Each call receives
   only the previous generated memory and one new non-conflicting observation.
   The returned memory must contain at most 100 whitespace-delimited words; the
   runner enforces the cap and treats an over-cap response as a protocol
   failure.
4. **Rescue:** final Rewritten memory plus the authoritative original seed.

Every QA condition is a fresh model call, receives no condition label, asks the
same eighteen questions, and must return `UNKNOWN` for absent facts. The updater
batches six isolated cases; case order rotates by round and repeat.

## Execution plan

- Model: `claude-sonnet-5` through Claude Code CLI 2.1.186 using subscription
  authentication. API keys and Bedrock/Vertex routing variables are removed.
- Isolation: safe mode, no tools, no slash commands, no session persistence,
  fixed system prompt, JSON Schema constrained output, neutral temporary
  working directory, and at most two CLI turns for StructuredOutput delivery.
- Three independent repeats, indexed 1–3.
- Thirty replacement calls plus four QA calls per repeat: 34 invocations per
  repeat and 102 planned invocations total.
- QA order rotates:
  - repeat 1: Clean, Additive, Rewritten, Rescue;
  - repeat 2: Additive, Rewritten, Rescue, Clean;
  - repeat 3: Rewritten, Rescue, Clean, Additive.
- All repeats will run without outcome-based stopping. There are no manual
  retries, substitutions, or outcome exclusions. CLI/schema/shape/word-cap
  failures are preserved as protocol or infrastructure failures and are not
  scored as memory errors.

## Scoring and estimands

No LLM judge is used. Exact scoring applies Unicode NFKC normalization,
trimming, case folding, and whitespace collapse only. Numeric words do not
match digit answers, and explanations are not stripped.

Primary outcome: protected-fact exact accuracy. The primary contrast is pooled
Additive minus Rewritten accuracy over 216 paired protected units (6 projects ×
12 facts × 3 repeats).

For each unit:

- **harm:** Additive correct, Rewritten wrong;
- **win:** Additive wrong, Rewritten correct;
- **rescued harm:** a harm that is correct under Rescue.

Secondary outcomes are six later-fact accuracies, per-round literal protected
retention, and memory size. Literal retention is a trace; downstream QA is the
usefulness outcome.

## Frozen validity gates

The result is interpretable only if all 102 calls complete, all returned
replacement memories obey the 100-word cap, and every repeat meets all three
calibration gates:

- Clean protected accuracy at least 70/72 (97.22%);
- Additive protected accuracy at least 70/72 (97.22%); and
- Additive later-fact accuracy at least 34/36 (94.44%).

If any gate fails, raw evidence is reported but the experiment is labelled
calibration-invalid and does not confirm or refute the mechanism.

## Frozen decision rules

Subject to validity, the result supports bounded repeated-replacement
degradation only if all conditions hold:

- pooled Additive protected accuracy exceeds pooled Rewritten by at least 10
  percentage points;
- paired harms outnumber paired wins;
- Additive exceeds Rewritten in at least two of three repeats; and
- Rescue recovers at least 50% of harmed units.

The result supports the Hunch immutable-additive mitigation pattern only if the
mechanism rule passes and pooled Additive is no more than 5 percentage points
below pooled Clean.

If validity passes but the mechanism rule does not, the conclusion is "no
evidence of material capacity-induced replacement degradation under this
frozen configuration." Thresholds will not change after outcomes are observed.

## Limits fixed in advance

This deliberately tests bounded consolidation under information pressure. A
positive result supports that narrower causal claim; it does not show that loss
occurs without a capacity limit or at the v2 load. Cases are synthetic, calls
batch six projects, downstream QA uses the same model family, and only one
model/configuration is tested. The benchmark does not measure Hunch retrieval,
production incidence, or coding-task success.
