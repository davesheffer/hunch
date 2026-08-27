# Preregistration amendment: capacity stress protocol v4

Status: **frozen before v4 model calls** on 2026-08-27 at base commit
`53740ce1496c5cc59ae6353bd229c70d5ed523a3`.

Protocol v4 inherits every case, question, condition, score, validity gate,
decision threshold, limitation, repeat count, and condition order from the v3
preregistration.

## Reason for amendment

All three v3 repeats completed five replacement checkpoints and then stopped
before QA. At checkpoint five, every memory was 93 words. On update six, one
rotated case in each process returned 101 words against the frozen 100-word
limit. No downstream QA or primary protected-accuracy outcome was produced or
inspected. V3 partial records and the protocol-stop diagnosis are preserved and
will not be counted as experimental repeats.

The v3 prompt simultaneously required preservation of every fact and compliance
with the cap. At the boundary the model preferred completeness, so the intended
bounded-consolidation treatment was not delivered.

## Sole treatment correction

V4 changes only the updater instructions and evidence filenames:

- the 100-word maximum is explicitly absolute and takes priority over
  completeness;
- the updater is told to use compact `key=value` clauses;
- it targets at most 90 words, leaving headroom below the enforced maximum;
- when not everything fits, it must omit lower-priority details rather than
  exceed the limit; and
- raw evidence uses `v4-repeat-*.json`, with `protocol_version: 4` and the
  90-word target recorded.

The hard maximum remains 100 words. The case bank, thirty observations, twelve
protected facts, six later facts, model, schemas, QA prompts, additive/clean/
rescue packets, exact scorer, 102-call plan, validity gates, and frozen decision
rules are unchanged. All three repeats will again run without outcome stopping
or manual retry.

## Frozen v4 hashes

- Runner:
  `b62a6dfc36355039e89a6e12ab810890e7da8a19a94f8ff12e0fd917a50737eb`
- Unit tests:
  `6b4fbec7ef84d171721115f474172f2cb3f1302d60c4100c516ad0c930c1db60`
- Case bank:
  `3805543c8fa5a5373e35ba7efbb429eebc5e58b95463172151d51d64c6f31f2e`
- System prompt:
  `fb06f5a610d1b9f7109e838b417e1274aefba5068f09599ce129d21e7294b275`
- Update schema:
  `5e4dc907c9d28d99cc0a3f36d924e28bef30eae138a4e81aed0d11aafdf295eb`
- QA schema:
  `711f94c890e100ba309393a1bbebb137a5a4f83f964c56da02b0c268cdeffb46`

Seven unit tests, TypeScript typechecking, and no-model dry runs for all repeat
indices passed after the amendment.
