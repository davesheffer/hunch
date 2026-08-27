# Isolated schema-collision replication: protocol v5 report

## Outcome

The targeted replication is **valid and complete**, but the v4 namespace-merge
signature **did not replicate at the preregistered frequency and breadth**.

All 162 planned CLI calls completed across 18 isolated trajectories, with three
fresh sessions for each of six projects. All 90 replacement checkpoints obeyed
the 100-word hard cap. Rewritten memory answered the protected production
namespace correctly in 18/18 trajectories and produced zero paired harms.

| Condition | Production namespace | Prototype namespace | Both questions |
| --- | ---: | ---: | ---: |
| Baseline | 18/18 | 18/18 | 36/36 |
| Additive | 17/18 | 18/18 | 35/36 |
| Rewritten | 18/18 | 18/18 | 36/36 |
| Rescue | 18/18 | 18/18 | 36/36 |

The single error was in the opposite direction from the proposed failure:
trajectory 16's Additive QA returned `UNKNOWN` for Delta Beacon's production
namespace, while Rewritten returned the correct `delta.cobalt`. Under the
frozen paired scoring, that is one Rewritten win and not a replacement harm.

## Frozen validity gates

Every validity gate passed:

- completed calls: 162/162;
- cap-compliant replacement checkpoints: 90/90, with a maximum of 46 words;
- Baseline production: 18/18, above the required 17/18;
- Additive production: 17/18, meeting the required 17/18;
- Baseline across both questions: 36/36, above the required 34/36; and
- Additive across both questions: 35/36, above the required 34/36.

The result is therefore interpretable under the preregistration.

## Frozen confirmation decision

| Requirement | Required | Observed | Pass |
| --- | ---: | ---: | :---: |
| Paired harms | at least 4 | 0 | No |
| Harms outnumber wins | yes | 0 vs 1 | No |
| Projects with harms | at least 2 | 0 | No |
| Semantic-merge share of harms | at least 50% | no harms | No |
| Rescue rate among harms | at least 75% | no harms | No |

Because none of the confirmation components passed, the v4
production/prototype namespace collision is **not confirmed** by this targeted
replication. The Hunch immutable-Additive mitigation pattern is also **not
supported under the frozen rule**, which required the collision signature to
be confirmed first. Additive production accuracy was also 5.56 percentage
points below Baseline, just outside the separate five-point tolerance.

## Results by project

Production-namespace accuracy is shown below. Each cell contains three fresh
trajectories over the same frozen project fixture.

| Project | Baseline | Additive | Rewritten | Rescue | Paired harms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Aster Relay | 3/3 | 3/3 | 3/3 | 3/3 | 0 |
| Birch Ledger | 3/3 | 3/3 | 3/3 | 3/3 | 0 |
| Cinder Index | 3/3 | 3/3 | 3/3 | 3/3 | 0 |
| Delta Beacon | 3/3 | 2/3 | 3/3 | 3/3 | 0 |
| Ember Archive | 3/3 | 3/3 | 3/3 | 3/3 | 0 |
| Fable Router | 3/3 | 3/3 | 3/3 | 3/3 | 0 |

## Interpretation

In plain terms: the earlier v4 run once blended a real production value with a
prototype value. When the exact risky five-update sequence was repeated 18
times with each project kept in its own session, that blend never happened.
This makes the v4 result look more like a correlated batch episode than a
stable, frequently recurring isolated failure for this model and prompt.

This is a non-replication, not proof that replacement memory can never corrupt
a fact. V5 deliberately targeted one post-selected failure signature, used only
six source fixtures, shared each fixture across three sessions, began from
model-generated round-25 snapshots, and tested one model/configuration. It did
not replay 18 independent full histories or measure Hunch retrieval and coding
performance.

The evidence does not justify promoting an immutable-Additive implementation
as a validated Hunch fix. A stronger next test would generate independent full
histories, keep cases isolated from the start, and preregister the same exact
semantic-collision outcome before any runs.

## Integrity and execution

- Frozen v5 commit: `33cd6483bc7cf0faf2826c60edb306abc33d8c5f`
- Model: `claude-sonnet-5`
- Claude Code CLI: 2.1.186
- Runner SHA-256:
  `f3bd2a02569e0fa886cf4941ac0c5796678bb8fda8b695119a2e1f1d931a2f71`
- Source v4 repeat-3 SHA-256:
  `7a1c098f913993fba2c3732110c487edfc4a9b0c6b52348b58b69f31750e9244`
- CLI-reported cost: approximately $7.4836
- Aggregate call duration: 36.08 minutes; concurrent wall time: 13.23 minutes
- Concurrency cap: 3; manual retries: 0

The 18 raw trajectory files preserve every prompt hash, generated checkpoint,
word count, CLI envelope, structured answer, exact condition score, and paired
classification. Their individual SHA-256 digests are recorded in the summary.
