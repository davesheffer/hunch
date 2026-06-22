# 🧠 Hunch — Engineering Memory OS

[![npm version](https://img.shields.io/npm/v/@davesheffer/hunch?color=2742ff&label=npm)](https://www.npmjs.com/package/@davesheffer/hunch)
[![npm downloads](https://img.shields.io/npm/dw/@davesheffer/hunch?color=2742ff)](https://www.npmjs.com/package/@davesheffer/hunch)
[![license](https://img.shields.io/npm/l/@davesheffer/hunch?color=2742ff)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-2742ff)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-native-2742ff)](https://modelcontextprotocol.io)

> Git stores *what* the code is. **Hunch** stores ***why*** it is that way — a persistent,
> git-native reasoning graph over your codebase, surfaced to Claude Code at reasoning time
> so the AI stops re-deriving understanding and stops undoing intentional design.

### ⚡ 60-second start

```bash
npm i -g @davesheffer/hunch
cd your-repo && hunch init && hunch backfill --since 90d
hunch why src/some/file.ts     # …or just ask Claude Code: "why is X built this way?"
```

<sub>Works with **Claude Code, Cursor, Copilot & Windsurf** from one shared graph.</sub>

### 📚 **[Read the full documentation → hunch-pi.vercel.app/docs](https://hunch-pi.vercel.app/docs)**

The docs site is the complete reference — setup, every CLI command and MCP tool, the
guards, troubleshooting. This README is the tour. Jump to:
[Install](https://hunch-pi.vercel.app/docs#install) ·
[MCP setup](https://hunch-pi.vercel.app/docs#mcp) ·
[Firmness](https://hunch-pi.vercel.app/docs#firmness) ·
[CLI reference](https://hunch-pi.vercel.app/docs#cli) ·
[Troubleshooting](https://hunch-pi.vercel.app/docs#doctor)

## The problem

Every AI coding session starts from zero. The model re-reads your code, re-guesses the
intent, and happily "fixes" the thing you deliberately did last month — because the
*reasoning* behind the code lives in PRs, Slack, and people's heads, not in the repo.

**Hunch** captures that reasoning as a **byproduct of normal work** — commits and test
failures — stores it as a git-tracked graph next to your code, and feeds it back to
Claude Code so every session is grounded in the decisions, bugs, and invariants that
came before. Local-first, no documentation toil, no SaaS.

## How it works

```
   commit / test failure              .hunch/  (git-tracked JSON)            Claude Code
 ┌───────────────────────┐         ┌──────────────────────────┐         ┌──────────────┐
 │ post-commit hook   ───┼────────▶│ Decisions  (why a change) │────────▶│ MCP tools     │
 │ record-bug         ───┼────────▶│ Bugs       (root causes)  │  read   │ /hunch-* cmds │
 │ structured diff +     │  write  │ Constraints(invariants)   │◀────────│ CLAUDE.md     │
 │ Claude (or heuristic) │         │ Components / Symbols/Edges │         │ CLI           │
 └───────────────────────┘         └──────────────────────────┘         └──────────────┘
```

- **Index** (no LLM): tree-sitter parses your repo into a symbol/dependency graph —
  functions, call edges, imports, components — plus churn and fan-in metrics.
- **Learn**: each commit becomes a structured **Decision** (an ADR); a failing test
  becomes a **Bug** with a ranked suspect list; recurring or severe bugs are promoted
  into **Constraints** (do-not-break invariants) and raise a component's *fragility*.
- **Ground**: any MCP assistant reads it through an **MCP server**, an auto-maintained
  **`CLAUDE.md`**, and **slash commands** — every answer cites `provenance`
  (source + confidence + evidence), so nothing is a blind assertion.

→ Concepts in depth: [the reasoning graph](https://hunch-pi.vercel.app/docs#graph) ·
[provenance](https://hunch-pi.vercel.app/docs#provenance) ·
[time-travel](https://hunch-pi.vercel.app/docs#time-travel)

## Getting started

```bash
npm install -g @davesheffer/hunch   # Node ≥ 20; puts `hunch` on your PATH
cd your-repo
hunch init                          # scaffold .hunch/, index, install hooks, wire up assistants
hunch backfill --since 90d          # cold start: seed decisions from recent git history
hunch why src/auth/session.ts       # …then ask your assistant: "why is X built this way?"
```

`hunch init` scaffolds `.hunch/`, indexes the repo, installs the git hooks + merge driver,
writes `.mcp.json` + slash commands + an auto-maintained `CLAUDE.md`, and wires up **every
detected assistant** (Claude Code, Cursor, VS Code/Copilot, Windsurf, Codex) to the same
graph — merging idempotently into existing files. **Reload your assistant in the repo**
afterward to pick up the `hunch_*` tools. Each teammate runs `hunch init` once; the
`.hunch/` content is shared via git.

> Synthesis is billed to **your coding-assistant subscription** (Claude/Codex/Cursor CLI),
> **never** a pay-per-token API key — and falls back to a deterministic heuristic if no CLI
> is present. Details: [Synthesis & billing](https://hunch-pi.vercel.app/docs#synthesis).
> On Windows, prefer `hunch init` over a global `claude mcp add`; if tools don't appear,
> `hunch doctor` heals it ([why](https://hunch-pi.vercel.app/docs#windows)).

**Full walkthrough →** [Getting started](https://hunch-pi.vercel.app/docs#install) ·
[MCP & assistants](https://hunch-pi.vercel.app/docs#mcp) ·
[MCP tools](https://hunch-pi.vercel.app/docs#mcp-tools) ·
[slash commands](https://hunch-pi.vercel.app/docs#slash) ·
[the 22-command CLI](https://hunch-pi.vercel.app/docs#cli)

## Enforcement: memory that holds the line

Hunch isn't just recall — it's a set of **guards** that stop the AI (and you) from undoing
intentional design. All ride the same rails: the pre-edit hook, `hunch check`, the
`hunch_merge_verdict` MCP tool, and the CI Constraint Guard. How hard they push is one
committed knob — [**firmness**](https://hunch-pi.vercel.app/docs#firmness)
(`off` → `advisory` → `firm` → `strict`).

### Never Twice — corrections become enforced invariants

You tell the agent "no, never call the pay-per-token API here," it complies once, and next
session it does it again — because the feedback was stored as advisory text. Hunch closes
that loop: a correction is captured as a first-class **Constraint** (`human_confirmed`) via
`hunch_record_correction`, and from then on the **same hook + CI guard** hold *every*
assistant to it. → [docs](https://hunch-pi.vercel.app/docs#never-twice)

### Causal Merge Verdict — does this change re-open a closed bug?

A diff-only reviewer sees *what* changed; it can't see that the line you're deleting is the
fix for an incident. Hunch can — `hunch_merge_verdict` replays a diff against the graph and
returns a cited **BLOCK / WARN / PASS**:

```text
VERDICT: ⛔ BLOCK — this change breaks a recorded invariant or re-opens a known bug.

⛔ pay() must verify the session before charging — con_pay
   🧠 why: "Charge must verify the session first" (dec_pay)
   🐞 guards against: Double-charge on unverified session (bug_…)
```

Deterministic (no LLM), and safe as a merge gate — it blocks only on a direct,
high-confidence, non-stale blocking invariant. → [docs](https://hunch-pi.vercel.app/docs#merge-verdict)

### Decision Guard (Veto) — re-introducing a *rejected* approach is blocked

The most expensive reversal is re-adding an approach a decision **rejected** (latency, a
forbidden dependency) — code that never existed, so a diff reviewer is blind to it. A
decision carries machine-checkable **tripwires**; re-introduce one and Hunch blocks it with
the receipt of what you rejected and why. → [docs](https://hunch-pi.vercel.app/docs#veto)

### Redundancy Guard — "this already exists"

An agent works from a *local* context window, so it re-implements a helper that already
lives three modules over, or re-adds a dependency the codebase already has — sprawl a
diff-only reviewer can't see, but Hunch's symbol graph can. Add a function or class already
defined elsewhere and `hunch check` / the CI guard / `hunch_merge_verdict` flag it with the
existing location. Deterministic and **advisory** — it never blocks; tuned to stay quiet
(stopword + length filters, scoped to the change's own project root, move-aware so a
refactor isn't mistaken for a duplicate). → [docs](https://hunch-pi.vercel.app/docs#redundancy)

Plus the **Regression Guard** (re-adding deliberately-retired code) and the
**[CI Constraint Guard](https://hunch-pi.vercel.app/docs#ci)** (`hunch ci` — a PR gate that
comments the affected `con_`/`dec_` ids and fails on a blocking one).

## Working as a team

The `.hunch/` JSON is the **source of truth** — diffable, reviewable in PRs, synced for free
over `git push` / `pull`. `hunch init` registers a git **merge driver** so concurrent edits
merge **by record id** (human-confirmed beats auto, then confidence, then recency). The graph
is **OS-agnostic**: paths are stored in POSIX form and an installed Hunch registers its MCP
server by package name, so Windows / macOS / Linux teammates share one memory without
per-machine fixups. → [docs](https://hunch-pi.vercel.app/docs#team)

## Continuous learning (CI)

The decision half of the loop is automatic (the post-commit hook). Light up the bug/constraint
half by wrapping your test run — it captures failures as **Bugs** (recurrences auto-promote
**Constraints**) and resolves fixed ones, preserving the runner's exit code:

```bash
hunch test                  # runs `npm test`; any runner: hunch test -- pytest -q
```

Drop `npx hunch test` into CI, and `hunch ci` to scaffold the PR merge gate.
→ [docs](https://hunch-pi.vercel.app/docs#ci)

## Semantic search (optional)

`hunch query` uses fast keyword search out of the box. For recall on paraphrases, opt into
**local embeddings** (`npm i -g @huggingface/transformers && hunch embed`) — local, free, and
opt-in. Vectors live in the derived SQLite index and never drift from the JSON source of truth.

## VS Code

A companion **[VS Code extension](vscode-extension/)** (on
[Open VSX](https://open-vsx.org/extension/davesheffer/hunch-vscode) — VS Code / Cursor /
Windsurf / VSCodium) brings the graph into the editor: a tree of decisions / invariants /
bugs / bug-lineage / fragility / stale records, CodeLens summaries, hover with bug history,
invariants in the Problems panel, an interactive component graph, and a status-bar invariant
counter. It reads the committed `.hunch/` JSON directly; writes delegate to the `hunch` CLI.

## Architecture

```
src/
├─ core/         types (Zod schema), ids, paths, glob, schema migration, atomic file I/O
├─ store/        JSON source of truth ←→ SQLite/FTS5 derived index; merge driver; compaction
├─ extractors/   tree-sitter parse, git introspection, the indexer
├─ synthesis/    write path: subscription CLI (Claude/Codex/Cursor) or deterministic fallback
├─ mcp/          MCP stdio server (the hunch_* tools)
├─ integrations/ post-commit hook, CLAUDE.md writer, .mcp.json + slash commands, merge driver
└─ cli/          commander entrypoint
```

Everything lives under `.hunch/` as git-tracked JSON (the source of truth); SQLite is a
throwaway derived index. → [storage layout](https://hunch-pi.vercel.app/docs#storage) ·
[DESIGN.md](DESIGN.md) for the full conceptual model.

## Notable engineering decisions

- **Subscription-billed synthesis, never the API.** The write path drives your Claude
  subscription via the `claude` CLI; `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are
  stripped from the child env to force subscription auth. A deterministic, no-LLM fallback
  means the loop never hard-requires credentials.
- **Native `tree-sitter` (0.21.1)**, not web-tree-sitter — the prebuilt WASM grammars have an
  incompatible ABI; the native bindings ship Node-20 prebuilds and a simpler synchronous API.
- **`better-sqlite3` pinned to `12.9.0`** — 12.10.x ships no Node-20 prebuild.
- **Atomic, durable writes.** All `.hunch/` writes go through temp-file + rename; an
  interrupted write can't truncate the index, and `put`/`delete` refuse to rewrite a corrupt one.
- **OS-agnostic by construction.** Paths are canonicalized to POSIX before comparison, and
  committed configs reference Hunch by package name, never a machine-local path.

## Develop

```bash
npm run dev -- <args>   # run the CLI from source via tsx (no build step)
npm run typecheck       # strict tsc — the gate
npm test                # node:test suite
npm run build           # compile to dist/ (the published artifact)
```

Hunch is pure TypeScript ESM, Node ≥ 20, licensed **Apache-2.0**. See
[CONTRIBUTING.md](CONTRIBUTING.md), [DESIGN.md](DESIGN.md), and the full
[developer docs](https://hunch-pi.vercel.app/docs#develop).
