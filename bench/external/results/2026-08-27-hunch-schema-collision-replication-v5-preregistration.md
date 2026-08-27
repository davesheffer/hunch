# Preregistration: isolated schema-collision replication, protocol v5

Status: **frozen before v5 model calls** on 2026-08-27 at base commit
`2fc3e8b65372c3a64dccdf15a7ad817038f4260c`.

Capacity stress v4 produced one correlated batch-level fault: in repeat 3, all
six rewritten memories merged a production schema namespace with a separate
prototype namespace, causing 6/72 protected answers to fail. Additive and
Rescue were perfect. The pooled v4 effect did not meet its frozen confirmation
threshold because the pattern appeared in only one of three batched repeats.

V5 is a prospective targeted replication of that specific signature. No v5
model call has been made. It does not replace or reinterpret the v4 verdict.

## Question and hypotheses

When each project is rewritten in its own independent session from the last
pre-merge memory state, does the production/prototype namespace merge recur?

- **H1, targeted recurrence:** the Rewritten arm will produce multiple paired
  production-namespace harms relative to Additive.
- **H2, signature match:** a material share of harms will contain both the
  protected production namespace and the word `prototype`, matching the v4
  semantic-merge shape rather than simple omission.
- **H3, rescue:** an authoritative record keeping production and prototype
  namespaces distinct will recover most harms.
- **H4, Hunch relevance:** immutable Additive records will remain as accurate
  as the pre-merge Baseline while Rewritten incurs confirmed harms.

## Frozen fixtures and independent units

- Source evidence is the committed v4 repeat-3 raw record with SHA-256
  `7a1c098f913993fba2c3732110c487edfc4a9b0c6b52348b58b69f31750e9244`.
- For each of six projects, the fixture is its generated round-25 memory, where
  production and prototype schema namespaces are still separate.
- Each trajectory applies the exact five later observations from source rounds
  26–30.
- There are 18 trajectories: three fresh, isolated sessions per project. No
  updater call contains another project. This removes the v4 batch-level
  dependence between the six cases.
- Repeated trajectories for a project share the frozen fixture and prompts but
  use fresh model sessions. Results will also be reported by project so shared
  fixture dependence is visible.

The updater is not told which fact is the scored target. It receives the same
compact-memory treatment as v4: target at most 90 words, absolute maximum 100,
and omission of lower-priority details when necessary.

## Conditions and calls

Each trajectory runs five sequential Rewritten calls, followed by four fresh
QA calls:

1. **Baseline:** frozen round-25 pre-merge memory.
2. **Additive:** pre-merge memory plus five immutable update records.
3. **Rewritten:** final memory after five isolated sequential replacements.
4. **Rescue:** final rewritten memory plus an authoritative record explicitly
   preserving the two distinct namespace values.

QA asks only for the production and prototype schema namespaces. Condition
order rotates by trajectory. Every condition uses a fresh, tool-free session.

- 9 CLI invocations per trajectory;
- 18 trajectories;
- 162 planned invocations total.

All trajectories will run without outcome-based stopping. There are no manual
retries, substitutions, or outcome exclusions. CLI/schema/shape/word-cap
failures are recorded as infrastructure failures, not memory errors.

## Model and isolation

- `claude-sonnet-5` through Claude Code CLI 2.1.186 using subscription auth;
- API keys and Bedrock/Vertex routing variables removed;
- safe mode, no tools, no slash commands, no session persistence;
- neutral temporary working directory, fixed system prompt, JSON Schema
  outputs, and at most two CLI turns for StructuredOutput delivery.

## Frozen outcomes

No LLM judge is used. Exact scoring applies Unicode NFKC normalization,
trimming, case folding, and whitespace collapse only.

Primary unit: production schema namespace in one trajectory.

- **harm:** Additive correct and Rewritten wrong;
- **win:** Additive wrong and Rewritten correct;
- **rescued harm:** a harm correct under Rescue;
- **semantic-merge harm:** a harm whose Rewritten answer contains the protected
  production namespace and `prototype`.

Secondary outcome: prototype namespace accuracy. Memory text, word count, and
literal presence are manipulation traces.

## Frozen validity gates

The targeted replication is interpretable only if all 162 calls complete, all
90 rewritten checkpoints obey the 100-word cap, and:

- Baseline production accuracy is at least 17/18;
- Additive production accuracy is at least 17/18;
- Baseline accuracy across both namespace questions is at least 34/36; and
- Additive accuracy across both namespace questions is at least 34/36.

If any gate fails, raw results are reported but do not confirm or refute the
signature.

## Frozen decision rules

Subject to validity, the v4 namespace-collision signature is confirmed only if
all conditions hold:

- at least 4/18 trajectories are paired harms;
- harms outnumber wins;
- harms occur in at least two distinct projects;
- at least half of harms match the semantic-merge signature; and
- Rescue recovers at least 75% of harms.

The Hunch immutable-additive mitigation pattern is supported only if the
signature rule passes and Additive production accuracy is no more than 5
percentage points below Baseline.

If validity passes but the signature rule fails, the conclusion is "the v4
namespace merge did not replicate at the preregistered frequency and breadth."
Thresholds will not change after outcomes are observed.

## Limits fixed in advance

This is a targeted replication selected after observing v4 and therefore
estimates recurrence of one known failure shape, not general memory-error
incidence. It starts from model-generated round-25 snapshots rather than replaying
the full thirty-round history. Three trajectories per project share one fixture,
and only one model/configuration is tested. The experiment does not measure
Hunch retrieval or coding-task performance.
