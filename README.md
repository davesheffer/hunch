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
