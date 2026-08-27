# Preregistration amendment: direct memory degradation protocol v2

Status: **frozen before v2 experimental calls** on 2026-08-27 at base commit
`adb09d4083989abad50902ffdd0bb42214c53cb1`.

The complete design, hypotheses, scoring, validity gates, decision rules, and
limitations remain exactly those frozen in
`2026-08-27-hunch-direct-memory-degradation-preregistration.md`.

## Reason for amendment

The three v1 processes all stopped before replacement checkpoint one and before
any QA call. Claude Code's JSON Schema mode returns data through its
StructuredOutput protocol: the first generation emits the structured tool call,
and another CLI protocol turn finalizes it into the outer envelope's
`structured_output` field. The frozen v1 limit of one turn caused
`error_max_turns` with stop reason `tool_use` in all three processes. No memory
outcome was exposed or scored. The failures and diagnosis are preserved in the
repository and are not v2 repeats.

## Sole execution changes

- Increase `--max-turns` from 1 to 2 for every CLI invocation.
- Mark raw records with `protocol_version: 2`.
- Write new immutable filenames ending in `v2-repeat-1.json`,
  `v2-repeat-2.json`, and `v2-repeat-3.json` so v1 evidence cannot be
  overwritten.

No case, fact, observation, prompt text, system prompt, schema, condition,
condition order, model, scoring rule, validity gate, decision threshold, repeat
count, or planned invocation count changed. There will still be 16 CLI
invocations per repeat and 48 total. The CLI's schema-finalization turn is not a
new experimental observation or a manual retry.

## Frozen v2 hashes

- Case bank:
  `b328919518e05e7409213dc30567166d986417bd7ece88bce3a587a04f052ccf`
- Runner:
  `be6b94199399fbd47fc158775711ed602585ff445d9479f2fc538caac1b93583`
- Unit tests:
  `177594b3ae74211831327d86c6ae270076113c19c0e5d9400355a8a783d0f9bb`
- System prompt:
  `09795251b3f87c1f23db45bda79ec222568bb6b7007878ef86801456a821996b`
- Update schema:
  `2042fa02dab0a4f7eb840405527e382e8edcda9b297971e6ac8c363018a3ca8d`
- QA schema:
  `a3e493c3921aa5e34c22086c3339ada1cb559aab19c6691b1a3febde042960d0`

Six unit tests, TypeScript typechecking, and dry runs for repeat indices 1, 2,
and 3 passed after the amendment. Dry runs make no model calls.
