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
hunch constitution delta dec_fix_or_revert --public-only
hunch constitution bootstrap --history --public-only --since 90d --max-candidates 3
hunch policy compile dec_service_boundary --through OrderService
hunch policy plan pol_… --history 20 --mutations 3
hunch policy prove pol_…
hunch policy accept pol_… --blocking --actor github:your-name
hunch policy evaluate pol_… --json
```

The model-free bootstrap considers only current, accepted, human-confirmed decisions carrying
exactly one structured `conformance` predicate. It normalizes auditable evidence and keeps a bounded
queue of at most three unreviewed candidates. Re-running is idempotent, private evidence inherits
private storage, and every candidate starts with `authority: null`—bootstrap can never activate or
block on its own.

The opt-in history path reads the exact blobs for a human-confirmed fix/revert commit and its first
parent—without checking out code or running hooks. It enumerates only assertions the current graph
can bind exactly and whose symbol/call identifiers the human judgment explicitly names. One
supported meaning may become a compiled candidate; zero, multiple, missing,
or ambiguous meanings are stored as `uncompilable`, never silently approximated. `constitution
delta` previews that evidence and candidate set without writing policy state.

Local correction, incident, and test-failure records can be normalized with `constitution ingest`.
The adapter stores references and hashes, inherits private storage, and creates no policy authority.
`policy plan` then writes a content-addressed ProofPlan before execution: exact source/current commits,
known-good/known-bad corpus, deterministic mutation operators, expectations, and resource budgets.
Planning runs no replay, test, model, or activation; `policy prove` binds its receipt to that plan.
Proof execution checks out each unique immutable commit into a disposable worktree with hooks,
user-global Git configuration, private-overlay discovery, and provider selection disabled. It
indexes code with Hunch's pinned static evaluator, records canonical current/known-good/known-bad/
accepted-history receipts, then removes every checkout and derived graph. Project code, builds, and
tests are never executed. Timeouts, unresolved refs, unknowns, and errors remain explicit.

The first Level-1 evaluator is `must-pass-through`: every statically discovered path from A to C
must contain B. CLI, MCP (`hunch_policy_evaluate`), and strict CI share the exact canonical receipt.
Models do not participate in evaluation or activation. Plan-bound proofs cover the committed current
baseline, known-good/known-bad fixtures, bounded accepted history, and one deterministic mutation.
Historical hits are not called false positives until classified, and unclassified hits or replay
errors prevent blocking approval. Shadow evidence and broader compiler inference remain follow-on
work and are reported as limitations in the proof artifact.

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

## Learn more

- [Full documentation](https://hunch-pi.vercel.app/docs)
- [Interactive product site](https://hunch-pi.vercel.app)
- [VS Code extension](vscode-extension/README.md)
- [Architecture benchmark](bench/architectural-conformance.md)
- [15-second demo](demo/architectural-conformance.sh)

Apache-2.0
