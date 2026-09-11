# Infection review-memory integration trial

Date: 2026-09-10. Target: `infection/infection` at
`bd7e49f8763e811e29eccf2b5cd2d09cf9de29d7`.

[Inspectable JSON report](infection-review-memory-trial.json) includes all 53
candidate threads with source comments, the two explicit rule selections, the
captured constraints, observed check results and limits. To reproduce the preview,
save its `review_packet` as `packet.json` and `selections` as `rules.json`, then run:

```sh
hunch review-memory capture --from packet.json --rules rules.json
```

This command previews only; it does not apply rules.

This tests Hunch review ingestion, capture and delivery on real public review
data. It is not a benchmark of bug prevention or an execution of Infection's PHP
test suite. Rules were drafted explicitly for the trial, not inferred or endorsed
by Infection maintainers. No upstream files, comments or branches were changed.

## Corpus

The latest 100 inline review comments returned by GitHub covered 11 PRs:
3522, 3525, 3535, 3536, 3538, 3539, 3542, 3545, 3549, 3555 and 3562.
The first preparation correctly refused a reply whose root was outside that
100-comment page (`3890736448`). Fetching the complete paginated comment export
for each of those PRs produced 102 comments, 53 candidate threads and 6 excluded
bot-account comments. Some User-account comments disclose joint human/AI review;
User is not proof of exclusively human authorship.

## Results

| Check | Result |
| --- | --- |
| Prepare complete PR exports | Passed: 53 candidates, no automatic constraints |
| Reverse input order | Identical packet |
| Missing root in initial bounded page | Refused, named the missing root |
| Selection with changed evidence hash | Refused |
| Preview | Produced explicit rules without applying them |
| Capture two rules into isolated clone | Passed |
| File-specific constraint delivery | Each affected file returned its rule and check |
| Unrelated file | No review rule delivered |
| Source provenance | Original review URL and evidence hash retained |
| Authority | Warning / agent_recorded; no blocking authority |
| Repeated capture | Refused existing rule; no overwrite |
| Rule for a missing current file | Refused before writing |

The two captured examples:

1. `con_8582e49ce7`: a container-created executable-path provider uses the injected
   shared filesystem, without constructing a fallback. Based on
   [PR 3538 review](https://github.com/infection/infection/pull/3538#discussion_r3903730977)
   and its replies. The current provider constructor requires `FileSystem`.
   The proposed verification checks that a distinct injected implementation is
   used. That PHP behavioral test was not executed in this trial.
2. `con_4e6552a374`: the initial-test command prints the executed command line
   before the initial suite runs. Based on
   [PR 3525 review](https://github.com/infection/infection/pull/3525#discussion_r3943485828)
   and the reply agreeing it was a regression. The current implementation has a
   subscriber printing `Command executed:` and the event's command line before
   calling `executeInitialRun()`. The proposed stdout assertion was not executed.

The rejected missing-file example came from
[PR 3549](https://github.com/infection/infection/pull/3549#discussion_r3943662519):
`tests/e2e/Source_Symbol_Selection/infection.json5` is absent at the tested HEAD.
This demonstrates why historical review advice requires current-code inspection.

## Isolation and limits

All capture writes were confined to a temporary clone with `autoCommit:false`
and no private overlay. Hunch also refreshed that clone's existing AGENTS and
Copilot grounding files, exercising its normal delivery route. Nothing was
committed or pushed. Local exports, packet, selections, verification script and
JSON result are under `%TEMP%/hunch-infection-review-trial/`.

This validates plumbing with two selected rules. It does not establish that all
53 threads contain useful invariants, that automated rule extraction works, or
that the feature reduces regressions. Rule selection and wording remain manual.
The complete Hunch release gate still needs to run before a release.
