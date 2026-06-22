# Deep Synthesis — brain-worker decision capture (`backfill --deep`)

> Status: **proposed** (design doc). One brain, many workers: several subscription
> models draft the same decision independently, a reviewer judges and merges them,
> and confidence tracks their *agreement*. An optional quality tier for the WRITE
> path — never the guard path, never the pay-per-token API.

## The gap it closes

Today, capturing a decision is **single-shot, single-model**: `selectProvider()` returns the
*first* available CLI ([provider.ts:476](../src/synthesis/provider.ts#L476)) — claude → codex →
cursor → deterministic — and that one model's draft *is* the record. One model, one angle, one
chance. A weak draft (vague "why", missed `alternatives_rejected`, wrong root intent) is what gets
stored, at `llm_draft` confidence 0.65.

For the **backfill** path especially — a one-time replay of history where quality compounds for
months — that's the wrong economy. We have three subscription CLIs sitting installed and a worker
pool already overlapping them across commits ([mapPool](../src/cli/index.ts#L193)). We're just not
using more than one *per commit*.

**Deep synthesis** turns the single draft into an **ensemble + review**: every available worker
drafts the same commit, a brain reviews them, and the merged record carries an
*agreement-weighted* confidence — so a unanimous, well-grounded decision reads as trustworthy and a
contested one reads as exactly that.

## Architecture — brain + workers, on rails that already exist

```
                       ┌─────────── workers (subscription CLIs, draft in parallel) ───────────┐
  commit ──► fan-out ──┤  claude-cli   codex-cli   cursor-agent   (each: provider.draftDecision)│
                       └──────────────────────────────┬──────────────────────────────────────┘
                                                       │  N independent DecisionDrafts
                                                       ▼
                                   brain (claude-cli reviewer)  ── judges + merges ──►  one DecisionDraft
                                                       │                                 source: "ensemble+review"
                                                       ▼                                 confidence: f(agreement)
                                              advisory record (never auto-blocks)
```

- **Workers** = the providers Hunch *already detects* — `ClaudeCliProvider`, `CodexCliProvider`,
  `CursorCliProvider` ([provider.ts:454](../src/synthesis/provider.ts#L454)). "Models you choose" =
  the CLIs you have installed, plus the existing `HUNCH_*_MODEL` env overrides. Each one already
  drafts via the same `SynthProvider.draftDecision(input)` contract and already strips API-key env
  vars — so the ensemble is subscription-billed **by construction**.
- **Brain** = a `claude-cli` **reviewer** pass: it receives the N worker drafts + the structured
  diff, picks the most accurate / best-grounded, grafts the strongest points from the others, and
  returns one merged `DecisionDraft`. The brain is a *judge*, not a fourth drafter.
- **Output** = a normal `DecisionDraft` ([provider.ts:107](../src/synthesis/provider.ts#L107)). The
  rest of the system never knows an ensemble ran — same as every provider today.

## The ensemble provider

A new `SynthProvider` that *composes* the existing ones — drops into `selectProvider` / `syncCommit`
with zero changes downstream.

```ts
// src/synthesis/ensemble.ts  (new)
export class EnsembleProvider implements SynthProvider {
  readonly name = "ensemble";
  constructor(private workers: SynthProvider[], private brain: SynthProvider) {}

  async available() { return this.workers.length >= 1; }

  async draftDecision(input: CommitInput): Promise<DecisionDraft> {
    // 1. fan out — every worker drafts the SAME commit, independently + concurrently.
    //    A worker that throws/degrades is dropped (Promise.allSettled), never fatal.
    const drafts = (await Promise.allSettled(this.workers.map((w) => w.draftDecision(input))))
      .filter((r): r is PromiseFulfilledResult<DecisionDraft> => r.status === "fulfilled")
      .map((r) => r.value);
    if (!drafts.length) throw new Error("ensemble: every worker failed"); // → safe fallback

    // 2. trivial cases skip the brain (cost): one draft, or unanimous → no review needed.
    if (drafts.length === 1) return drafts[0]!;

    // 3. brain reviews + merges → one record, agreement-weighted confidence (capped).
    return reviewAndMerge(this.brain, input, drafts);
  }

  draftBug(input: FailureInput) { /* same shape, bug variant */ }
}
```

`draftBug` gets the identical treatment (the failure-root-cause hypothesis benefits even more from
multiple angles).

## The review + merge (the brain)

The brain is `claude-cli` driven with a **review** prompt (sibling to the existing `commitPrompt`):
it sees the commit + the N candidate drafts and emits a single merged decision plus an
**agreement signal**.

```ts
// agreement → confidence, with a deliberate CEILING below the strict gate
function reviewAndMerge(brain, input, drafts): Promise<DecisionDraft> {
  // brain returns: { merged: DecisionDraft-ish, agreement: 0..1 }
  // confidence = base + agreement boost, but NEVER ≥ STRICT_MIN_CONFIDENCE (0.8):
  //   an auto-draft must not cross into auto-enforceable territory without a human.
  const confidence = Math.min(0.78, 0.55 + 0.23 * agreement);
  return { ...merged, confidence, source: "ensemble+review" };
}
```

**Why the 0.78 ceiling.** `isStrictBlocker` lets a constraint block on `confidence ≥ 0.8` alone
([strictgate.ts:11](../src/core/strictgate.ts#L11)). Deep synthesis must *raise quality, not arm
enforcement* — so even a unanimous ensemble stays advisory; a human still confirms before anything
blocks. Same boundary veto draws: **the LLM drafts, a human arms** ([docs/veto.md](veto.md),
dec_a466655539).

## Where it runs (and where it must not)

- **`hunch backfill --deep`** — the home use case. One-time history replay, quality compounds, and
  the user opted into the cost explicitly. Reuses [mapPool](../src/cli/index.ts#L193) for
  cross-commit concurrency; the per-commit worker fan-out nests inside, with a combined cap (see
  limits).
- **`hunch sync --deep <sha>`** — deep-capture one important commit on demand.
- **Opt-in config** — `synthesis.deep: true` for teams that want it on the post-commit hook. Default
  **off**: a 3-worker + reviewer fan-out on *every* commit would make commits slow and burn
  subscription quota, breaking the "byproduct of normal work, no toil" promise.
- **The significance gate still applies.** `isSignificant` ([synthesize.ts:40](../src/synthesis/synthesize.ts#L40))
  decides paid-model vs deterministic *before* the ensemble — trivial commits never fan out.

### Two boundaries that do not move
1. **Determinism on the guard path.** Deep synthesis touches *drafting only*. `hunch check`, veto,
   the strict gate — still a deterministic set-intersection over human-vouched records. **No model,
   single or ensemble, sits in the block path.**
2. **Subscription, never the API.** Workers are the existing CLI providers, which already strip
   `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (con_2ce3f2a547). Deep mode adds **no** new model
   transport — it only runs more of what's already subscription-billed. Wiring a worker to a
   pay-per-token API would violate the core invariant; the design forbids it.

## Worked example

```
$ hunch backfill --deep --since 180d --concurrency 3

  commit a1b2c3d  "switch sessions to Redis"
    worker claude-cli  → "Move sessions server-side; JWT carries opaque id…"   (conf 0.65)
    worker codex-cli   → "Adopt Redis-backed sessions to enable revocation…"   (conf 0.6)
    worker cursor-agent→ "Server-side session store; drop stateless JWT…"      (conf 0.65)
    brain review       → agreement 0.9 → MERGED, rejected-alt grafted from codex
  ✓ a1b2c3d  Store sessions in Redis, not JWT-only   ⟨ensemble+review, 0.76⟩
```

Three angles, one record, confidence that reflects their consensus — still advisory, still one
`hunch review --accept` away from being enforceable.

## Honest limits (state them — same shape as the moat)

- **It costs N×.** Three workers + a reviewer ≈ 4 spawns per substantive commit vs 1 today. That's
  why it's opt-in and backfill-first. The **combined concurrency cap** matters: `outer commits ×
  inner workers` must stay ≤ the pool limit (16), or you fork-bomb the machine — bound it as
  `commitConcurrency × workerCount ≤ 16`.
- **Diversity needs ≥2 CLIs.** With only `claude` installed, the "ensemble" is one drafter + a
  self-review (a useful critique pass, but no cross-model diversity). `hunch doctor` should report
  how many workers deep mode would actually use, so the gain isn't oversold.
- **The brain is a single model.** The reviewer is `claude-cli`; its judgment is one perspective on
  the workers' output. It reduces single-*draft* risk, not single-*judge* risk. (A future tier could
  rotate the brain across CLIs.)
- **Non-deterministic.** Two deep runs of the same commit can merge differently. Fine — the output
  is advisory; nothing downstream assumes draft stability (the decision id is seeded from the
  *commit*, not the title, so re-runs update in place — [synthesize.ts:67](../src/synthesis/synthesize.ts#L67)).
- **Latency.** The reviewer adds a round-trip after the slowest worker. Acceptable for backfill;
  another reason it's off the per-commit hot path by default.

## Implementation map

| # | change | file |
|---|---|---|
| 1 | `EnsembleProvider` (fan-out workers, `allSettled`, drop failures) | `src/synthesis/ensemble.ts` (new) |
| 2 | `reviewAndMerge` brain pass + review prompt + agreement→confidence (capped <0.8) | `src/synthesis/ensemble.ts`, [provider.ts](../src/synthesis/provider.ts) |
| 3 | `selectProvider({ deep })` builds the ensemble from available workers + brain | [src/synthesis/provider.ts](../src/synthesis/provider.ts) |
| 4 | `--deep` on `backfill` + combined concurrency cap; thread through `syncCommit` | [src/cli/index.ts](../src/cli/index.ts), [src/synthesis/synthesize.ts](../src/synthesis/synthesize.ts) |
| 5 | `hunch sync --deep`, `synthesis.deep` config, `HUNCH_DEEP_WORKERS` selection | [src/cli/index.ts](../src/cli/index.ts), [src/core/config.ts](../src/core/config.ts) |
| 6 | provenance: record per-worker drafts + agreement in `evidence`; `hunch doctor` worker count | [src/synthesis/synthesize.ts](../src/synthesis/synthesize.ts) |

## Build order

1. `EnsembleProvider` fan-out — workers draft concurrently, failures dropped, single-worker passes
   through unchanged. (+ unit tests: 3 fake providers → 3 drafts; one throws → 2; all throw → throw.)
2. `reviewAndMerge` brain pass + the confidence ceiling (<`STRICT_MIN_CONFIDENCE`). This is the
   quality gain; build it next, not last.
3. `selectProvider({ deep })` + `backfill --deep` with the `commits × workers ≤ 16` cap.
4. `sync --deep` + `synthesis.deep` config.
5. `HUNCH_DEEP_WORKERS` (choose the worker set / models) + per-brain model override.
6. Auditable provenance (per-worker drafts + agreement) + `hunch doctor` reporting.

Tiers 1–3 are a shippable, opt-in `backfill --deep`. 4 makes it routine. 5–6 make it tunable and
auditable. Nothing here touches enforcement, and nothing adds a non-subscription model path.
