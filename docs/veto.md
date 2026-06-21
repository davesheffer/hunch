# Veto — the Decision Guard for *rejected* alternatives

> Status: **proposed** (design doc, not yet implemented). Tiers 1–4 below are a shippable demo;
> 5–6 make it live in the agent loop. Git remembers *what* changed. Hunch's veto remembers what
> you *decided against* — and won't let a fresh session quietly re-introduce it.

## The gap it closes

Hunch already has a **Regression Guard** (`store.regressionHits`). It fires when a diff re-adds a
symbol or dependency that an in-force decision deliberately **removed** — it reads
`decision.retired.{symbols,deps}`. That only works for things that *once existed in code*.

A rejected **alternative** never existed in code. `decision.alternatives_rejected` is prose:
*"extension queries an MCP/API server for data — adds latency and runtime coupling."* Nothing was
retired, so the regression guard is blind to it. The day an agent re-introduces that exact approach,
nothing fires.

| | trigger signal | source field | catches `dec_49916d02c9`? |
|---|---|---|---|
| `regressionHits` | re-adds a **retired** symbol / dep | `decision.retired.{symbols,deps}` | ❌ retired sets are empty |
| `vetoHits` (new) | re-introduces a **rejected** approach | `decision.rejected_tripwires` | ✅ |

`dec_49916d02c9` ("Read-only visualization layer over committed `.hunch/` JSON") rejected
*"extension queries MCP/API server for data"* with confidence 0.95, `human_confirmed`. It retired no
symbol. Veto is the guard that fires.

## How a rejected alternative becomes machine-checkable

`alternatives_rejected: string[]` stays untouched (back-compat). A decision gains an optional parallel
array of **tripwires** — the thing that turns prose into a set/regex a guard can test.

```ts
// src/core/types.ts  (additive)
export interface RejectedTripwire {
  alternative: string;          // the human text — printed verbatim in the receipt
  scope: string[];              // globs, e.g. ["vscode-extension/**"]
  forbids: {
    deps?: string[];            // external imports that signal it: ["axios", "node-fetch"]
    symbols?: string[];         // identifiers: ["fetch", "XMLHttpRequest"]
    patterns?: string[];        // scoped line regexes (last resort): ["/api/", "\\bfetch\\("]
  };
  embed_ref?: string;           // optional handle into `embeddings` for the advisory tier
  provenance: Provenance;       // the tripwire's OWN trust — NOT inherited from the decision
}
// Decision gains:  rejected_tripwires?: RejectedTripwire[]
```

The **tripwire carries its own provenance**, separate from the decision's. This is the load-bearing
detail: a decision can be `human_confirmed` at 0.95 while a tripwire auto-drafted for it is only
`llm_draft`. Trust travels with the tripwire, because the tripwire is the thing that blocks.

Tripwires are minted three ways, each with provenance:

1. **At capture** — the LLM drafting the decision also drafts tripwires → `llm_draft` → **advisory only**.
2. **At review** — a human confirms in `hunch decide` → `human_confirmed` → **eligible to block**.
3. **Backfill** — `hunch veto backfill` proposes tripwires for existing `alternatives_rejected`
   strings, queued for one-tap confirm.

> Curation is the cost, and the moat. With no confirmed tripwire, a rejected alternative is only
> catchable semantically — i.e. advisory. The feature's strength scales with confirmed tripwires,
> the same shape as every honest memory system: the value is the curation layer.

## The matching ladder

`store.vetoHits(diff, addedLinesByFile)` mirrors `regressionHits`. It considers only **in-force**
decisions (not superseded) whose tripwire `scope` intersects the touched files, and walks a
precision-first ladder — cheapest, most precise tier first. The tier sets how clean the evidence is
(and so how the receipt reads); whether a hit can **block** is decided uniformly by the gate below.

| tier | match | precision | can block? |
|---|---|---|---|
| `dep` | `diff.addedDeps ∩ tripwire.forbids.deps` | exact set intersection — highest | ✅ once tripwire `human_confirmed` |
| `symbol` | added identifiers in scoped lines ∩ `forbids.symbols` | identifier match | ✅ once tripwire `human_confirmed` |
| `pattern` | scoped regex (`forbids.patterns`) over added lines | regex — lowest | ✅ once tripwire `human_confirmed` |
| `semantic` | cosine(added-hunk embedding, alternative embedding) ≥ τ | similarity | ❌ never — advisory escalator only |

One block rule, all tiers: **a confirmed tripwire blocks, an unconfirmed one only warns** (see the
gate below). Tier no longer gates *whether* it can block — it gates *how much you trust the evidence*,
which drives advisory ranking and how the receipt reads.

> **Note on `symbol`/`pattern` precision.** A raw-text identifier match has the
> `prefetch`-contains-`fetch` hazard, so these tiers are noisier than `dep`. Tokenizing the match
> (word-boundary minimum; AST-derived via the symbol graph is the honest bar) is what makes a
> human comfortable confirming one. The symbol graph also catches a wrapped/aliased call
> (`const f = fetch`) on the *next* index — first introduction may slip; veto is for the honest
> re-introduction, not an adversary.

### The one new extraction

`analyzeDiff` today counts `addedLines` as a *number*. Veto needs the *text* of added lines per file
(call sites aren't declarations), so the diff parser gains:

```ts
addedLinesByFile: Map<string, string[]>   // repo-relative path -> added line bodies
```

This is small and non-breaking — `analyzeDiff` already iterates every line with the current file in
hand ([src/extractors/diff.ts](../src/extractors/diff.ts)); it just accumulates the bodies it already
sees. It is the only new parsing work.

## The gate — deterministic, no model in the enforcement path

The block lives next to `isStrictBlocker`, in [src/core/strictgate.ts](../src/core/strictgate.ts), and
keys on the **tripwire's** trust — not the decision's:

```ts
export function isVetoBlocker(
  d: { status?: string; superseded_by?: string | null },     // the rejecting decision (in-force gate)
  tw: { provenance?: { confidence?: number; source?: string } }, // the TRIPWIRE (trust gate)
  tier: "dep" | "symbol" | "pattern" | "semantic",
  stale: boolean,
): boolean {
  if (d.status === "superseded" || d.superseded_by) return false; // in-force decisions only
  if (stale) return false;                                        // freshness gate
  if (tier === "semantic") return false;                          // never block on similarity
  // Progressive enforcement: an auto-drafted tripwire is ALWAYS advisory. Only a
  // human-vouched tripwire can fail a build — for ANY tier. Confidence ranks the
  // advisory warning; it never substitutes for the vouch (an LLM self-score is not
  // a licence to fail someone's commit). One predictable rule: confirmed → blocks.
  return tw.provenance?.source?.includes("human_confirmed") ?? false;
}
```

Why the tripwire and not the decision: if the gate read `decision.provenance`, an LLM-drafted tripwire
hung on any confidence-≥0.8 decision would block — exactly the hallucinated-veto failure the design
forbids. Keying on the tripwire keeps the promise: **what fails your commit is a set-intersection over
a human-vouched record.** No model sits in the enforcement path; the LLM only ever *drafts* tripwires
(advisory). And the rule is one line a developer can hold in their head — *it blocks only what I
confirmed* — which is the foundation of the seamless DX below.

> `.includes("human_confirmed")` matches the real `+`-joined source strings Hunch writes
> (`"llm_draft+human_confirmed"`), not just the bare token.

## Where it fires

Veto rides the existing rails — no new enforcement surface is required.

1. **`hunch check` / CI Constraint Guard.** `CheckReport` gains `vetoes: VetoHit[]` and `vetoBlocking`.
   `verdict()` and `reportFailsStrict()` count `vetoBlocking` alongside `regBlocking`
   ([src/core/checkreport.ts](../src/core/checkreport.ts)), so the terminal output and the PR comment
   both light up for free. Add a "Reverses a decision" section to `renderText` / `renderMarkdown`.
2. **Pre-edit agent hook.** A sibling to `blockingInScope`
   ([src/core/hookpolicy.ts](../src/core/hookpolicy.ts)): `vetoInScope(store, file, proposedAddedLines)`
   returns the deny text *before* the edit is staged. The refusal states only the decision and the
   receipt — never how to lower enforcement (mirrors `hookpolicy`).
   - **Hook caveat (honest).** The hook extracts the proposed edit text from `tool_input`
     ([src/cli/index.ts](../src/cli/index.ts)) across all three edit tools — `new_string` (Edit),
     `content` (Write), and `edits[].new_string` (MultiEdit) — and feeds them as `proposedAddedLines`.
     The `dep` tier only sees `import axios …` if that import is in *this* edit — a `Write` of the
     whole file carries it; an incremental `Edit` of a call site may not. So the `dep` block is
     rock-solid at commit/CI (a real diff) and best-effort live.
3. **MCP — no new tool.** Once `CheckReport` carries vetoes, they surface through the existing
   read-only `hunch_merge_verdict`, which renders the *whole* report
   ([src/mcp/server.ts](../src/mcp/server.ts)). An agent replaying its patch before a PR gets vetoes
   for free — same call it already makes. This keeps the MCP surface client-agnostic
   (con_e04226bd05); a veto-specific tool would only re-walk the same `buildCheckReport` path.
4. **CLI.** `hunch veto [--strict]` (the rejected-alternative class in isolation, for the demo and
   debugging) and `hunch veto backfill`.

`VetoHit` reuses the causal `why` shape but keyed on the decision you already hold
(`decision → caused_by_bug`), not the constraint-centric `causalChain(constraint_id)`
([src/core/checkreport.ts](../src/core/checkreport.ts)) — a small dedicated resolver, not a drop-in.

```ts
export interface VetoHit {
  decision: string;     // the dec_ that rejected this approach
  title: string;
  alternative: string;  // the rejected text — the receipt headline
  chosen: string;       // decision.decision — what you did instead
  tier: "dep" | "symbol" | "pattern" | "semantic";
  evidence: string[];   // matched dep / symbol / file:line
  blocks: boolean;      // passed isVetoBlocker
  why?: { bug?: { id: string; title: string; root_cause: string } };
}
```

## Worked example (deterministic, reproducible on this repo)

An agent writes into `vscode-extension/src/extension.ts`:

```ts
import axios from "axios";
const data = await axios.get("/api/memory");
```

Pipeline: `analyzeDiff` → `addedDeps: ["axios"]`, scope `vscode-extension/**`. `vetoHits` matches
`dec_49916d02c9` (in force, scope intersects) at tier `dep`. The tripwire for *"extension queries
MCP/API server for data"* is `human_confirmed` → `isVetoBlocker` = **true**:

```text
⛔ VETO — this reverses dec_49916d02c9 ("Read-only visualization layer over committed .hunch/ JSON").
   You rejected: "extension queries MCP/API server for data"
   reason:       adds latency and runtime coupling.
   You chose:    read directly from committed JSON, no backend dependency.
   active since 2026-06-15 · confidence 0.95 · human-confirmed
   evidence:     +import axios   (vscode-extension/src/extension.ts)
```

No human in the loop at edit time. The agent self-corrects against a receipt read straight from
version-controlled JSON.

## Seamless DX — making curation free

The feature's one real cost is "a human must confirm a tripwire before it blocks." Good DX makes that
cost invisible and makes the block moment a teacher, not a wall. Six rules, in priority order:

1. **Zero hand-authoring — tripwires are drafted, never typed.** The synthesis LLM already runs at
   capture and already has the birthing commit's `analyzeDiff` output. It populates
   `forbids.{deps,symbols}` from what that commit actually avoided. A developer never writes a regex or
   a glob — they only ever *react* to a draft.
2. **Confirm rides `hunch review` — no new ritual.** There is already a flow to promote auto-records to
   `human_confirmed`. Drafted tripwires appear *inline there*: `block on this? [y/N]`, one keypress, the
   same muscle used to confirm the decision itself. No separate `hunch veto review` ceremony to learn.
3. **Curation never goes in the VS Code extension.** Tempting (a visual toggle), but `dec_49916d02c9` —
   the decision this very demo protects — makes the extension **read-only; it never modifies the
   store**. A confirm-toggle there would make it read-write and *violate the decision veto exists to
   guard*. The extension may *display* a tripwire next to its rejected alternative; it must not edit
   one. (Hunch catching its own DX shortcut is the feature working.)
4. **Progressive enforcement: warn → confirm → block.** A fresh install blocks nothing. An unconfirmed
   (auto-drafted) tripwire prints only a soft *"heads-up — this looks like something you rejected."*
   Confirm once and it blocks. Trust is earned per-tripwire, so day-one is zero friction and zero
   false-positive rage — and it matches the gate above exactly (`human_confirmed` ⇒ blocks).
5. **The agent block is the hero moment — silent self-correction.** When veto fires in the pre-edit
   hook, the deny text hands the agent everything it needs (what you rejected, why, what you chose), so
   it rewrites *before staging*. The human never sees a failed commit. The wall is invisible because
   nobody hits it.
6. **Escape hatch, asymmetric.** Requirements change — sometimes you *want* the rejected approach now.
   The human-facing block (commit / CI) must cite the legitimate path: `hunch supersede dec_…`. The
   **agent**-facing deny must *not* (anti-coaching — the same rule `hookpolicy` already follows). Show
   the override to the person; hide it from the bot. A guard with no documented override breeds
   rage-bypass; an override the agent can self-invoke breeds bypass-by-default.

**The whole DX in one sentence:** you never author a rule, you confirm drafts with one key during a
review you already do, day-one is advisory-only, and when it finally blocks it is an agent
self-correcting against a receipt — not a human hitting a wall.

## Honest limits

- **Confirmation is the cost.** No confirmed tripwire ⇒ advisory only, for every tier. Auto-drafting
  at capture and `hunch veto backfill` shrink it to a one-key reaction (see *Seamless DX*); they don't
  erase it — by design, since the human vouch is what makes the block safe.
- **Lower tiers have false positives** — a raw-text match can fire on `prefetch` for `fetch`. Mitigated
  two ways: only a `human_confirmed` tripwire ever blocks (any tier), and tokenizing the match makes a
  human comfortable confirming it in the first place.
- **Anchors miss obfuscation** (wrap `fetch` in a helper). Defense-in-depth: the symbol graph catches
  the helper on the next index; the *first* introduction may slip. The guard is for the honest
  re-introduction — a fresh session that forgot — which is the common case, not an adversary.

## Implementation map

| # | change | file |
|---|---|---|
| 1 | `addedLinesByFile` out of `analyzeDiff` | [src/extractors/diff.ts](../src/extractors/diff.ts) |
| 2 | `RejectedTripwire` type + `Decision.rejected_tripwires` (Zod) | [src/core/types.ts](../src/core/types.ts) |
| 3 | `vetoHits()` + `isVetoBlocker()` (+ unit tests, mirror the regression tests) | [src/store/hunchStore.ts](../src/store/hunchStore.ts), [src/core/strictgate.ts](../src/core/strictgate.ts) |
| 4 | `CheckReport.vetoes` + `vetoBlocking` + renderers + `verdict`/`reportFailsStrict` | [src/core/checkreport.ts](../src/core/checkreport.ts) |
| 5 | `vetoInScope` hook (+ `new_string`/`content` extraction) + `hunch veto` CLI | [src/core/hookpolicy.ts](../src/core/hookpolicy.ts), [src/cli/index.ts](../src/cli/index.ts) |
| 6 | `hunch veto backfill` + capture-time tripwire drafting | [src/synthesis/synthesize.ts](../src/synthesis/synthesize.ts) |

## Build order

1. `addedLinesByFile` (the only new extraction).
2. `RejectedTripwire` type + `Decision.rejected_tripwires`, each tripwire carrying its **own** provenance.
3. `vetoHits()` + `isVetoBlocker()` keyed on **tripwire** provenance — this is the gate fix, not a
   later refinement; building it any other way ships a guard that blocks on un-vouched LLM drafts
   (+ unit tests, mirror the regression tests).
4. `CheckReport.vetoes` + renderers + `verdict`/`reportFailsStrict`. This lights up `hunch check`,
   the CI guard, **and** `hunch_merge_verdict` together — no per-surface work.
5. `vetoInScope` hook (with `new_string`/`content` extraction) + `hunch veto` CLI. No `hunch_veto`
   MCP tool — vetoes already ride `hunch_merge_verdict` from tier 4.
6. `hunch veto backfill` + capture-time tripwire drafting.

Tiers 1–4 are a shippable demo — the dep-tier block at commit/CI is the strong, honest core. Tier 5
makes it live in the agent loop (with the partial-edit caveat above). Tier 6 makes it scale.

## Acceptance criteria (the DX is the spec, not a nicety)

A tier is not "done" until its DX rule holds. These are testable:

- **Gate (tier 3).** `isVetoBlocker` returns `true` **only** when the tripwire is `human_confirmed`,
  for every tier; an `llm_draft` tripwire never blocks regardless of confidence or tier. Unit-tested
  against fixtures for all four tiers × {drafted, confirmed}.
- **Progressive enforcement (tier 4).** With a drafted-only graph, `hunch check --strict` exits 0 and
  prints the soft heads-up; after confirming the tripwire, the same diff exits non-zero. One toggle,
  observable in the exit code.
- **One write, three surfaces (tier 4).** A single `CheckReport.vetoes` change makes `hunch check`,
  the CI markdown comment, and `hunch_merge_verdict` all render the veto — asserted by a test that
  builds one report and checks all three renderers. No `hunch_veto` MCP tool is added.
- **Zero hand-authoring (tier 6).** Capturing a decision whose chosen commit avoided a dep emits a
  drafted tripwire with `forbids.deps` populated from `analyzeDiff` — no human types a `forbids` array.
- **Confirm rides `hunch review` (tier 6).** Drafted tripwires surface in the existing review flow with
  a one-key confirm; there is no separate `hunch veto review` command.
- **Asymmetric escape hatch (tier 5).** The commit/CI block text contains `hunch supersede`; the
  agent-facing deny text does **not** — asserted by a string test on both renderers (mirrors the
  `hookpolicy` anti-coaching test).
- **Read-only extension preserved.** No tier writes a confirm path into `vscode-extension/**`;
  `hunch check` over the veto branch must not itself trip `dec_49916d02c9`.
