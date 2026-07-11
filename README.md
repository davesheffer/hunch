# Hunch

## Your AI can write code. Hunch makes it remember the consequences.

[![npm version](https://img.shields.io/npm/v/@davesheffer/hunch?color=2742ff&label=npm)](https://www.npmjs.com/package/@davesheffer/hunch)
[![GitHub stars](https://img.shields.io/github/stars/davesheffer/hunch?color=2742ff&label=%E2%98%85%20star)](https://github.com/davesheffer/hunch)
[![license](https://img.shields.io/npm/l/@davesheffer/hunch?color=2742ff)](LICENSE)

**Hunch is engineering memory and a deterministic Change Gate for AI-assisted codebases.**
It captures the decisions, rejected approaches, and bug history behind your code—then gives every
assistant the same evidence before it changes anything.

Not another chat history. Not a wiki your team must remember to update. A git-native reasoning
graph that turns “we already learned this the hard way” into something your tools can actually use.

```bash
npm i -g @davesheffer/hunch
cd your-repo
hunch init
```

Then ask any connected assistant: **“Why is this built this way?”**

## The problem Hunch solves

AI can read your current code. It does not know the decision you made six months ago, the incident
that made it necessary, or the approach you deliberately rejected yesterday.

That gap is where architectural drift starts:

| Without Hunch | With Hunch |
| --- | --- |
| A refactor passes tests but bypasses a hard-won service boundary. | The change is checked against the decision, its constraint, and the incident behind it. |
| A new coding session starts from scratch. | Claude Code, Cursor, Copilot, Windsurf, Antigravity, and Codex retrieve the same project memory over MCP. |
| A correction disappears into a chat transcript. | “Never do that again” becomes a scoped, auditable guard. |
| Code review sees a diff, not the reason behind it. | Change Gate produces a PASS / WARN / BLOCK receipt with causal evidence. |

## What you get in five minutes

```bash
hunch init                         # index code + wire supported assistants
hunch backfill --since 90d         # optional: seed memory from recent history
hunch check --working --strict     # review the whole working tree before a commit
```

Hunch creates a local graph of:

- **Decisions** — what was chosen, why, and what alternatives were rejected.
- **Constraints** — the invariants a change must not violate.
- **Bug lineage** — the root cause behind fixes, recurrences, and regression guards.
- **Architecture** — symbols, components, dependencies, blast radius, and fragility.

It then puts that context where work happens: MCP tools, the CLI, a VS Code Change Gate, git hooks,
and an optional pull-request guard.

## One graph. Every assistant. No lock-in.

Hunch is agent-agnostic by design. It scaffolds MCP and grounding for Claude Code, Cursor, VS Code / Copilot,
Windsurf, Google Antigravity, Codex, and any agent that can read `AGENTS.md`; where a client exposes hooks,
it adds a native lifecycle adapter too.

Your memory is plain JSON that you own. Hunch adds a SQLite index only as a rebuildable derived
layer—your decisions never disappear into a proprietary hosted memory system.

Synthesis is just as portable: Hunch can use Claude Code, Codex, or Cursor through the subscription
CLI you choose. It never guesses which of several installed subscriptions to bill—set your local,
gitignored preference with `hunch provider codex-cli` (or `claude-cli` / `cursor-agent`); otherwise
Hunch uses a subscription only when exactly one is available, and falls back to deterministic local
drafting when the choice is ambiguous.

```text
Claude Code  ─┐
Cursor       ├── MCP ──> .hunch/ reasoning graph ──> deterministic checks
Copilot      ┤
Codex        ┤
Windsurf     ┤
Antigravity  ┘
```

## The Change Gate: review intent, not just code

Before you commit, ask Hunch to review staged files, your working tree, or a branch against its
base. It returns a receipt your human reviewer or any coding agent can understand:

```text
BLOCK  src/payments/charge.ts

  [blocking] Controllers must not reach the database directly
  why: dec_service_boundary → bug_n_plus_one_2025
  evidence: charge() now imports dbQuery
```

The gate is deterministic: no prompt-quality lottery and no model call in the enforcement path.
Start advisory. Turn on strictness only when the rules have earned it.

```bash
hunch firmness strict
hunch check --staged --strict
hunch conform --strict
```

### Hunch Constitution — experimental Gate G1 + evidence bootstrap

Hunch can now lift one structured architectural decision into versioned Policy IR, prove its
deterministic behavior with a clean baseline plus a mutation, and require an explicit human event
before it becomes enforceable:

```bash
hunch constitution bootstrap --public-only --since 90d --max-candidates 3
hunch constitution ingest --public-only --since 90d
hunch constitution ingest --public-only --instructions --from pr-export.json
hunch constitution delta dec_fix_or_revert --public-only
hunch constitution bootstrap --history --public-only --since 90d --max-candidates 3
hunch policy compile dec_service_boundary --through OrderService
hunch policy corpus pol_… --import corpus.json
hunch policy plan pol_… --history 20 --mutations 3
hunch policy prove pol_…
hunch policy history pol_…
hunch policy history pol_… --commit <full-sha> --classify true_positive_actionable --actor github:your-name --reason "Confirmed historical violation"
hunch policy shadow pol_… --record
hunch policy shadow pol_…
hunch policy card pol_…
hunch policy relations pol_…
hunch policy accept pol_… --blocking --actor github:your-name
hunch policy evaluate pol_… --json
hunch policy evaluate pol_… --working --json
hunch policy evaluate pol_… --staged --json
```

Private G2 dogfood stays evidence-only until a separate human signoff. An exact private plan selects
at least ten P3+ policies and seven category-specific runbooks; drills write no evidence by
themselves, rehearsals bind the resulting hashes, and historical shadow backfill commits only after
the complete policy/commit matrix has produced no unknown or error result:

```bash
hunch constitution g2 --plan private-g2-plan.json
hunch constitution g2 --drill all
hunch constitution g2 --rehearse rb_g2_evaluator_error_01 --result passed \
  --actor human:owner --evidence sha1:… --notes "Exact recovery drill passed."
hunch constitution g2 --backfill 20
hunch constitution g2 --queue 20
hunch constitution g2 --strict
```

Backfill uses distinct real first-parent commits, excludes commits predating an executable policy's
fixing commit, and deduplicates by exact policy/proof/repository/graph identity. A failed preflight
writes nothing. Neither a ready packet nor a passed drill activates, warns, blocks, or claims G2;
the strongest machine result is `eligible_for_human_g2_signoff`.

The model-free bootstrap considers only current, accepted, human-confirmed decisions carrying
exactly one structured `conformance` predicate. It normalizes auditable evidence and keeps a bounded
queue of at most three unreviewed candidates. Re-running is idempotent, private evidence inherits
private storage, and every candidate starts with `authority: null`—bootstrap can never activate or
block on its own.

The opt-in history path reads the exact blobs for a human-confirmed fix/revert commit and its first
parent—without checking out code or running hooks. It also admits an architectural replacement
when a human-confirmed decision carries an explicit `retired.deps` entry that exactly matches a
removed external package. It enumerates only assertions the current graph can bind exactly and
whose symbol/call/package identifiers the human judgment explicitly names. One
supported meaning may become a compiled candidate; zero, multiple, missing,
or ambiguous meanings are stored as `uncompilable`, never silently approximated. `constitution
delta` previews that evidence and candidate set without writing policy state.

The external-import slice is deliberately narrow: removing a human-named static ESM package
specifier can compile into a file-scoped `not-reaches(..., external:<package>)` boundary. Package
subpaths canonicalize to their package root, the anchor must exist before and after the change, and
an explicitly retired dependency filters unrelated call/symbol facts from the same replacement
commit. Exact relative JS/TS imports across two derived components can also compile to direct
`reaches`/`not-reaches` policies over `depends_on` edges when both component meanings are explicitly
human-grounded. Same-component imports, ambiguous/missing targets, import-map aliases, `require()`,
dynamic `import()`, runtime loading, and positive external-package requirements remain visibly
unsupported.

Local correction, incident, and test-failure records can be normalized with `constitution ingest`.
The adapter stores references and hashes, inherits private storage, and creates no policy authority.
Add `--instructions` to hash committed AGENTS/CLAUDE/Copilot/Cursor/Windsurf instructions and ADRs
from immutable Git blobs. Add `--from` for one or more strict local review, conversation, or PR
export JSON files. Raw prose is never copied into EvidenceEvents; only bounded metadata, references,
and content hashes persist. Mixed batches validate before the first write, public-only mode refuses
private/secret items, and unsupported meaning stays explicitly `uncompilable` instead of being
approximated into a policy.

```json
{
  "version": 1,
  "source": "pr_export",
  "items": [{
    "id": "pr-431-review-7",
    "kind": "review",
    "occurred_at": "2026-07-10T10:10:00Z",
    "actor": "maintainer:alice",
    "commit": "abc1234",
    "files": ["src/orders.ts"],
    "text": "Use OrderService; do not call persistence here.",
    "data_class": "private",
    "maintainer_confirmed": true
  }]
}
```

`policy plan` then writes a content-addressed ProofPlan before execution: exact source/current commits,
known-good/known-bad corpus, deterministic mutation operators, expectations, and resource budgets.
`policy corpus --import` accepts bounded labeled `known_bad`/`known_good` Git refs, resolves them
once to full immutable commit SHAs, stores the manifest in the policy's public/private home, and
hash-binds it into every resulting plan. A commit cannot be labeled both good and bad, and stale
policy-bound corpora must be re-imported after semantic policy changes. A `known_good` fixture may
also carry an explicit human attestation—`{ "actor": "github:your-name", "reason": "…" }`—to
document why that accepted variant belongs in the corpus. Attested fixtures are replayed once as
named corpus evidence and excluded from accepted-history sampling; the attestation cannot waive a
policy result or create authority.
`policy relations` is a read-only view of those explicit exception-parent links. It shows the
selected policy, its parent if any, linked narrower exceptions, and a visible missing-parent marker
for a manually damaged record. When the broad parent is planned, proved, or evaluated, every linked
exception descendant is instead hash-bound into one canonical composition. The deepest applicable
explicit scope selects the result; equal-scope ambiguity, missing bindings, or unsupported component
path precision stays unknown/error rather than falling through to the broad rule.
`policy consolidation` is also read-only. When a compiler-produced advisory scope suggestion exists,
it groups only matching narrow policies with the same assertion/data class and syntactically contained
scopes, then requires three independent decision references with no exception, active-policy,
conflict, or counterexample signal before marking the packet reviewable. It never merges or widens a
policy.
`policy history` inspects every violated accepted-history receipt and its current human disposition.
Disposition records are strict, content-addressed, stored in the policy's public/private home, and
bound to the exact policy hash, proof, plan, commit, and replay receipt. Corrections append a new
record with `--supersedes`; prior judgments remain auditable. Only `true_positive_actionable` clears
the history-evidence gate. False positives, insufficient-parser unknowns, and accepted exceptions
remain blockers until the policy/evaluator or combined exception semantics are repaired and
re-proved. A disposition never activates policy: blocking still requires a separate explicit human
`policy accept`, and a later corrected disposition is rechecked on every gate evaluation.
`policy shadow --record` appends one content-addressed evaluation for the exact current graph and
deduplicates retries of the same receipt. Violations use a separate append-only human disposition
chain, while `policy shadow` reports raw recent-window counts, confirmed and lower-bound precision,
unknown/error rate, mutation sensitivity, thresholds, and P4-review eligibility. Shadow records
never warn, block, change proof class, or activate policy; the MCP shadow tool is read-only.
Planning runs no replay, test, model, or activation; `policy prove` binds its receipt to that plan.
Proof execution checks out each unique immutable commit into a disposable worktree with hooks,
user-global Git configuration, private-overlay discovery, and provider selection disabled. It
indexes cold snapshots through a bounded four-worker pool (hard maximum eight), reuses
content-validated data-class-separated graph caches, records canonical current/known-good/
known-bad/accepted-history receipts, then removes every checkout and transient graph. Scheduling
and cache statistics never enter proof hashes. Project code, builds, and tests are never executed.
Timeouts, worker failures, unresolved refs, unknowns, and errors remain explicit.

Level-1 evaluators include `must-pass-through` (every statically discovered path from A to C must
contain B), exact external-package boundaries, and component/component-id selectors over static
`depends_on` edges. CLI, MCP (`hunch_policy_evaluate`), and strict CI share the exact canonical
receipt. Direct `reaches`/`not-reaches` contradictions are stored as conflict evidence without
minting a second policy or changing authority. Candidate records retain the exact alternatives,
unsupported facts, incumbent, and conflict IDs for proof-card review. Equivalent evidence enriches
the incumbent idempotently without changing its assertion, scope, proof, lifecycle, or authority.
Three independently grounded component-policy sources may add an advisory common-path scope
suggestion, while same-named behavior outside a narrow symbol scope is surfaced as a counterexample.
Suggestions and counterexamples are review evidence only: the compiled scope is never widened
automatically.

Executable-behavior policies keep their proof and history replay bound to immutable commits and
exact dependency snapshots. For advisory delivery, `policy evaluate --staged`, `--working`, the MCP
workspace option, and the pre-commit `check` path materialize the selected pending snapshot in a
disposable checkout before running the same hash-pinned test. The receipt binds the base commit,
snapshot hash, and changed paths; untracked regular files are included, repository hooks and global
Git configuration remain disabled, and dependency-manifest changes return an explicit error rather
than using stale dependencies. Advisory violations warn but never block, and `--public-only` never
loads private policies.
An intentional narrow opposite can be linked explicitly with `hunch policy exception <child>
--parent <parent> --actor human:<identity> --reason "…"`. The relationship requires identical
bindings/relation, opposite `reaches` semantics, matching data class/home, and a strictly contained
scope. Linking invalidates the child's prior proof and authority and returns it to non-blocking
`compiled` state. The broad parent remains the enforcement unit: its plan, proof, replay and mutation
receipts bind the full exception tree, and any later exception change retracts blocking eligibility
until a fresh composite proof is generated. Proof never activates the parent; a separate human
`policy accept` remains mandatory.
Models do not participate in evaluation or activation. Plan-bound proofs cover the committed current
baseline, known-good/known-bad fixtures, bounded accepted history, and a canonical mutation
manifest. The primary mutation is applied to an immutable disposable source checkout, must remain
parseable, and persists its exact Git diff plus resulting graph diff. Comment/string parser and
same-name ambiguity controls remain separate; any failed required receipt prevents blocking review.
Optional project build/test status is reported separately and is never required for evaluator
sensitivity. Historical hits are
not called false positives until classified, and unclassified hits or replay errors prevent
blocking approval. Shadow evidence and broader compiler inference remain follow-on work and are
reported as limitations in the proof artifact.

`policy card` (also `hunch_policy_card` over MCP) renders the same deterministic review surface for
every client: exact assertion and scope, raw evidence vector, unclassified hits, unknown/errors,
blocking readiness, current authority, limitations, and next actions. It never averages evidence
into a confidence score and never grants authority.

The versioned 20-case EXP-03 compiler bank is recomputed with:

```bash
hunch constitution scorecard
```

The scorecard reports the raw numerator/denominator, the absolute difference from the preregistered
70% threshold, a Wilson 95% interval, per-outcome counts, and silent semantic substitutions. One
unsupported-to-assertion substitution fails the gate even when the aggregate rate remains above the
threshold. This curated scorecard measures deterministic compiler classification, not real-user
authoring speed or acceptance; those human-review arms remain a separate EXP-03 study.

## Private when the reasoning is sensitive

Open-source the code without open-sourcing the reasoning.

```bash
hunch private ~/work/hunch-private/.hunch
hunch record-bug --private --test "billing regression" --message "…"
hunch review --private
```

Private decisions, bugs, constraints, and wiki pages live in a separate overlay you control.
Local checks enforce them; public CI reports use `--public-only`, so private memory never appears in
a pull-request comment or committed grounding file. Private captures default to deterministic local
synthesis, keeping sensitive diffs and failure messages out of subscription-model drafting.

## A workflow your team can trust

Hunch is deliberately conservative:

- **Human-confirmed rules get the teeth.** Drafted memory advises; confirmed, precise invariants can block.
- **Every result carries receipts.** Decisions, constraints, bugs, confidence, and evidence are connected.
- **Drift is visible.** `hunch doctor` catches stale references, stale generated docs, and broken overlay pointers.
- **Public surfaces are public-only.** Private overlay data stays local unless you explicitly choose to share it.
- **No magic rewrite bot.** Hunch proposes and checks; you decide what becomes truth.

## Try the moment it earns its keep

Imagine an assistant “simplifies” a controller by querying the database directly. Linters are green.
Unit tests pass. The architecture is still wrong.

Hunch can answer with the actual context: this boundary exists because of the N+1 incident, the
service layer was the chosen repair, and the direct import violates a confirmed constraint. That is
the missing layer between fast code generation and durable engineering judgment.

## Certify a release candidate

```bash
npm run gate:release
```

The same fail-closed runner gates pull requests, main, and npm publication. It binds the package
version and optional release tag to HEAD; runs typecheck, the full suite, core and VS Code builds,
a fresh public repository index plus strict architectural conformance, a clean-installed tarball replay/privacy rehearsal, and the
production dependency audit; then writes a content-addressed receipt under
`.hunch-cache/release/`. A failed prerequisite stops later commands, a tag/version/commit mismatch
refuses before execution, and publication remains unreachable unless the exact tagged checkout is
clean and every gate passes. The receipt includes the prior-version rollback command; it never
activates, promotes, warns, or blocks a Constitution policy.

## Learn more

- [Full documentation](https://hunch-pi.vercel.app/docs)
- [Interactive product site](https://hunch-pi.vercel.app)
- [VS Code extension](vscode-extension/README.md)
- [Architecture benchmark](bench/architectural-conformance.md)
- [15-second demo](demo/architectural-conformance.sh)

Apache-2.0
