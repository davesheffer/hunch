# State recall evaluation

Shipped with Hunch 1.33.0, the repeatable public benchmark separates finding a record from
treating it as current or authorized. It uses 33 synthetic records, including 24 distractors,
with 8 literal questions across derived state, commitments, receipts, entities and conventions,
plus 4 paraphrases.
It is not a production corpus or a measurement of how an agent acts after reading state.

## Measured 2026-09-13

The [machine-readable result](../bench/state-recall-2026-09-13.json) includes every query,
exact corpus/question/runner hashes, source revision, dirty-worktree status and model settings.
Each question has one explicitly expected record. Scores below are means across questions;
MRR is the reciprocal rank of the first expected answer, with zero for a miss.

| Retrieval | Literal Recall@3 | Literal MRR | Paraphrase Recall@3 | Paraphrase MRR |
| --- | --- | --- | --- | --- |
| Kind-scoped keywords | 8/8 (100%) | 1.000 | 2/4 (50%) | 0.500 |
| Keywords + local MiniLM | 8/8 (100%) | 1.000 | 4/4 (100%) | 0.875 |

The CPU measurement used Transformers.js 3.8.1 and
[Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2), pinned to
`751bff37182d3f1213fa05d7196b954e230abad9`, with fp32 weights, mean pooling and normalized
384-dimensional vectors. The model runs locally; no hosted inference API receives the fixture.
It uses Hunch's existing kind-scoped retrieval and reciprocal-rank fusion, with a pinned
embedding adapter for reproducibility. This does not change the serving configuration.

Thirteen separate contract checks passed: superseded state stays out of current answers;
external keys and entity IDs resolve consistently; explicit invalidation removes the current
answer; unverified observations stay under observed; source/dependent access works before
revocation and is withheld afterward; exact lookup and retained history respect revocation;
and an ungranted partition refuses the request. These checks are not averaged into recall.

## Reproduce

```sh
node --import tsx bench/state-recall.ts --output /tmp/state-keywords.json
node --import tsx --test test/state-retrieval-eval.test.ts
```

The normal CI gate needs no model download. Its literal-answer floor is 100% Recall@3 and
MRR at least 0.75; all 13 invariant checks must pass. The paraphrase misses remain visible.
Change a golden answer only when its fixture meaning changes, with the reason in review.

For the pinned local-model measurement, install the optional runtime in a disposable directory
so the repository's locked dependency tree remains unchanged:

```sh
npm install --prefix /tmp/state-eval-runtime @huggingface/transformers@3.8.1
node --import tsx bench/state-semantic.ts \
  --runtime /tmp/state-eval-runtime/node_modules/@huggingface/transformers/dist/transformers.node.mjs \
  --output /tmp/state-semantic.json
```

The initial run downloads public model weights. Alternatively, `bench/state-recall.ts --semantic`
uses the real optional embedder installed for the checkout; it refuses a missing or stub model.
Do not label stub-vector tests as semantic-quality evidence.

## What remains to measure

Raw kind-scoped search is a trusted-store interface. The permission checks exercise the
authenticated state binding used by HTTP/MCP, not a newly exposed search API. Subject reads
return deterministic stored state; this benchmark does not add semantic matching to them.
Freshness is measured after a writer explicitly records invalidation, not by fetching an
external source. The fixture does not measure relationships, every language, load, or every
possible access graph.

Next evidence comes from a consented production corpus with frozen known answers, and the
two-user pilot: contradictions, stale answers, source reads/model calls, and time until another
agent notices a change. Strong scores on this small fixture do not satisfy those acceptance
gates or promote autonomous authority.
