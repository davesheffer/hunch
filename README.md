# 🧠 Hunch — Architectural Conformance for AI code

[![GitHub stars](https://img.shields.io/github/stars/davesheffer/hunch?color=2742ff&label=%E2%98%85%20star)](https://github.com/davesheffer/hunch)
[![npm version](https://img.shields.io/npm/v/@davesheffer/hunch?color=2742ff&label=npm)](https://www.npmjs.com/package/@davesheffer/hunch)
[![npm downloads](https://img.shields.io/npm/dw/@davesheffer/hunch?color=2742ff)](https://www.npmjs.com/package/@davesheffer/hunch)
[![license](https://img.shields.io/npm/l/@davesheffer/hunch?color=2742ff)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522.13-2742ff)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-native-2742ff)](https://modelcontextprotocol.io)

> **A linter checks whether code matches a *pattern*. Hunch checks whether code still matches your *architecture*** —
> and blocks the AI change that breaks it, citing the decision and the past bug it would reopen.
> The semantic invariants pattern-SAST can't express (layering, must-reach, dependency direction),
> enforced deterministically over a **git-native** graph of *why* — across any MCP assistant.

```bash
npm i -g @davesheffer/hunch
cd your-repo && hunch init

# record an architectural invariant — the kind Semgrep/SonarQube structurally can't express
hunch conform --add "controllers never reach the DB directly — go through the service layer" \
  --assert not-calls --subject listOrders --object dbQuery --why "the Mar-2025 N+1 meltdown"

hunch conform --strict     # ✅/⛔ deterministic gate — wire into CI; runs on every AI change
```

> An AI "optimizes" the controller to query the DB directly. **Semgrep: green. SonarQube: green.**
> (it's a legitimate internal import — no bad pattern.) **Hunch: ⛔ BLOCKED** — *"listOrders now reaches
> dbQuery — VIOLATED · why: the Mar-2025 N+1 meltdown · prevents recurrence of bug_0317."* See
> [`demo/architectural-conformance.sh`](demo/architectural-conformance.sh).

**It works both ways — prevent *and* catch — and you need both:**
- **Prevent** — in a reproducible benchmark ([`bench/`](bench/architectural-conformance.md): n=90, Haiku/Sonnet/Opus, 3 invariant classes), the recorded invariant in context cut architectural violations **58% → 16%** overall (Sonnet **67% → 0%**). But prevention is *necessary, not sufficient*: **even Opus ignored a layering rule 60% of the time when told.** Each violation passes a linter clean.
- **Catch** — which is exactly why the deterministic gate exists. `hunch check --strict` (the pre-commit hook + the [`hunch ci`](https://hunch-pi.vercel.app/docs#ci) PR gate) **blocks** what the model ignores — with the receipt, **no model in the gate**. Injection helps; the gate is the guarantee.

<sub>Works with **Claude Code, Cursor, Copilot, Windsurf & Google Antigravity** from one shared, git-native graph.</sub>

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

- **Index** (no LLM): Hunch maps your repo — how functions, files, and components
  connect — so it can see the ripple effect of any change.
- **Learn**: each commit becomes a structured **Decision** (an ADR); a failing test
  becomes a **Bug** with its likely cause; recurring or severe bugs are promoted
  into **Constraints** (do-not-break rules) and flag the riskiest parts of the code.
- **Ground**: any MCP assistant reads it through an **MCP server**, an auto-maintained
  **`CLAUDE.md`**, and **slash commands** — every answer cites `provenance`
  (source + confidence + evidence), so nothing is a blind assertion.

→ Concepts in depth: [the reasoning graph](https://hunch-pi.vercel.app/docs#graph) ·
[provenance](https://hunch-pi.vercel.app/docs#provenance) ·
[time-travel](https://hunch-pi.vercel.app/docs#time-travel)

## Why Hunch is different

"Memory for coding agents" is getting crowded, but most of it is a *server-side, ephemeral,
single-vendor* RAG cache over your current code. Hunch is the opposite on every axis — and that
combination is the moat:

| | Typical agent memory | **Hunch** |
|---|---|---|
| **Storage** | server-side / a vendor's cloud | **git-tracked JSON in your repo** — diff it, review it in PRs, sync it over `git push` |
| **Lifetime** | the session; often auto-expiring | the **lifetime of the codebase** — non-destructive supersede/veto keeps the *why-it-changed* trail |
| **Clients** | one vendor's agent | **client-agnostic** — one `.hunch/` graph serves Claude Code, Cursor, Copilot & Windsurf via MCP |
| **What's stored** | opaque extracted "facts" | **structured ADRs** — decisions with rejected-alternatives, bug lineage, and invariants |
| **Enforcement** | advisory / just-in-time hints | **fail-closed guards** — no model in the block path; a commit fails only on a rule you've vouched for |
| **Trust** | take it on faith | **provenance on every record** (source + confidence + evidence) and a measurable retrieval signal (`hunch eval`) |

The short version: **git tracks *what* changed; Hunch tracks *why*** — locally, durably, and under
your control, with guards that actually hold the line instead of just suggesting.

## Decision-grounding: memory that stays true to the doc

Architectural Conformance keeps the *code* honest to the graph (**graph ≠ code**). Decision-grounding
is its complement — it keeps your *docs* honest to the graph (**doc ≠ graph**). A comment or a README
says one thing; the decision that actually governs the file says another. Both are "memory that stays
true"; you want both.

The anchor is one optional field. A decision can carry a **`topic`** — the thing it's the current answer
for (e.g. `"auth.session"`) — and topic gives you a query contract: **current** (the one live answer),
**history** (the supersede trail), and **rejected** (what was ruled out and why). It's fully
backward-compatible: `topic` defaults to `null`, there's **no schema bump**, and existing graphs load
unchanged.

- **Read-time grounding.** The pre-edit (PreToolUse) hook now surfaces a file's topic-anchored decisions
  *before* the AI writes — with doc-precedence framing ("follow the graph, not a stale doc") and what each
  decision **rejected**, so the model doesn't happily re-add the approach you already ruled out.
- **`anchor-stale` drift — deterministic, no guessing.** A new drift kind fires when a file is still
  anchored to a **superseded** decision while a **current** one exists for its topic. It shows up in
  `hunch doctor` and in a CI-gateable `hunch drift`:

  ```bash
  hunch drift        # ⛔ exits non-zero on anchor-stale drift or a topic collision (>1 live decision)
  ```

  It only fires on **explicit** topic anchors — no semantic guessing, no false positives on prose it can't
  read.
- **Capture, gated.** `hunch_record_decision` now enforces a store-scoped **uniqueness guard**: it refuses
  a *second* live decision for a topic (you're never silently governed by two). The richer path is the new
  **`hunch_capture_decision`** tool — it returns a one-question-at-a-time grilling protocol plus a
  capture-session token; `record_decision` accepts an optional `capture_token`. Un-token'd writes still
  work, they just get a nudge toward `/capture`. **`hunch_current_decision(topic)`** returns the one answer
  that currently governs a topic.
- **`hunch reconcile-topics`.** A git merge is the one thing that can create two live decisions for a
  topic. This scans for it and exits non-zero — wire it into a post-merge hook or CI.
- **`hunch heal`** + the **`/capture`** and **`/heal`** slash commands (scaffolded by `hunch init`) do
  **read-only** doc↔graph reconciliation — they surface the mismatch and never rewrite your prose silently.

→ [docs](https://hunch-pi.vercel.app/docs#grounding)

## Getting started

```bash
npm install -g @davesheffer/hunch   # Node ≥ 22.13; puts `hunch` on your PATH
cd your-repo
hunch init                          # scaffold .hunch/, index, install hooks, wire up assistants
hunch backfill --since 90d          # cold start: seed decisions from recent git history
hunch why src/auth/session.ts       # …then ask your assistant: "why is X built this way?"
```

`hunch init` scaffolds `.hunch/`, indexes the repo, installs the git hooks,
writes `.mcp.json` + slash commands + an auto-maintained `CLAUDE.md`, and wires up **every
detected assistant** (Claude Code, Cursor, VS Code/Copilot, Windsurf, Codex, Google Antigravity) to the same
graph — merging idempotently into existing files. **Reload your assistant in the repo**
afterward to pick up the `hunch_*` tools. Each teammate runs `hunch init` once; the
`.hunch/` content is shared via git.

> Synthesis is billed to **your coding-assistant subscription** (Claude/Codex/Cursor CLI),
> **never** a pay-per-token API key — and falls back to a deterministic heuristic if no CLI
> is present. Details: [Synthesis & billing](https://hunch-pi.vercel.app/docs#synthesis).
>
> **Deep Synthesis** (`backfill --deep` / `sync --deep`): gathers several independent takes on a
> change and reconciles them into one more-trustworthy note — trusting it more when they agree.
> Add `--verify` to fact-check the note against the commit and drop anything it doesn't support.
> It always stays *advisory* until you confirm it. Subscription-only; falls back to a single
> draft when only one assistant is available.
> On Windows, prefer `hunch init` over a global `claude mcp add`; if tools don't appear,
> `hunch doctor` heals it ([why](https://hunch-pi.vercel.app/docs#windows)).

**Full walkthrough →** [Getting started](https://hunch-pi.vercel.app/docs#install) ·
[MCP & assistants](https://hunch-pi.vercel.app/docs#mcp) ·
[MCP tools](https://hunch-pi.vercel.app/docs#mcp-tools) ·
[slash commands](https://hunch-pi.vercel.app/docs#slash) ·
[the full CLI reference](https://hunch-pi.vercel.app/docs#cli)

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

No model in the loop, so it's safe as a merge gate — it blocks only on a high-confidence rule
you've confirmed, and warns on everything softer. → [docs](https://hunch-pi.vercel.app/docs#merge-verdict)

### Decision Guard (Veto) — re-introducing a *rejected* approach is blocked

The most expensive reversal is re-adding an approach a decision **rejected** (latency, a
forbidden dependency) — code that never existed, so a diff reviewer is blind to it. A
decision remembers what it rejected; re-introduce that approach and Hunch blocks it with
the receipt of what you rejected and why. → [docs](https://hunch-pi.vercel.app/docs#veto)

### Redundancy Guard — "this already exists"

An agent works from a *local* context window, so it re-implements a helper that already
lives three modules over, or re-adds a dependency the codebase already has — sprawl a
diff-only reviewer can't see, but Hunch's symbol graph can. Add a function or class already
defined elsewhere and `hunch check` / the CI guard / `hunch_merge_verdict` flag it with the
existing location. **Advisory** — it never blocks, and it's tuned to stay quiet so a refactor
that just moves code isn't mistaken for a duplicate. → [docs](https://hunch-pi.vercel.app/docs#redundancy)

See also **[Decision-grounding](#decision-grounding-memory-that-stays-true-to-the-doc)** — the doc ≠ graph
complement: topic anchors, read-time grounding in the pre-edit hook, and a deterministic `anchor-stale`
drift check (`hunch drift`) that fails CI when a file still points at a superseded decision.

Plus the **Regression Guard** (re-adding deliberately-retired code) and the
**[CI Constraint Guard](https://hunch-pi.vercel.app/docs#ci)** (`hunch ci` — a PR gate that
comments the affected `con_`/`dec_` ids and fails on a blocking one).

Name the actual violation — `record-constraint "…" --scope "src/**" --severity blocking
--forbid-dep "lodash"` — and it blocks the *real* change across the file's whole life instead
of relaxing to advisory after the file is edited again. The dep matcher reads the **parsed
import**, so a comment or string naming the module can't false-positive and a submodule
(`lodash/groupBy`) is still caught; a correction your assistant records gets the same matcher
automatically. (`--match <regex>` remains a lint-grade textual fallback.) None of these are a
bypass-proof boundary — deliberate indirection can still route around any rule.

## Working as a team

The `.hunch/` JSON is the **source of truth** — diffable, reviewable in PRs, synced for free
over `git push` / `pull`. `hunch init` sets things up so concurrent edits from different
teammates merge cleanly instead of throwing conflict markers, and it's **OS-agnostic** —
Windows / macOS / Linux teammates share one memory with no per-machine fixups.
→ [docs](https://hunch-pi.vercel.app/docs#team)

### Branches & worktrees

Memory follows you across every branch and **git worktree**, with no per-worktree setup — a
fresh `git worktree add` on any branch sees the same decisions, bugs, and invariants. Create one
already wired in with **`hunch worktree <path> [-b <branch>]`**, or just run `hunch init` / `hunch
shared` (or `hunch private`) once and every worktree picks it up. Parallel worktrees never corrupt or lose memory, and
`hunch doctor` confirms a worktree is sharing.

Need one **single source of truth** for memory in any repo (private or public)?
Use **`hunch shared --repo <url>`**. Every capture — decisions, bugs, constraints, runbooks —
routes to one shared overlay repo and, by default, auto-commits + pushes so teammates/other
worktrees stay in sync automatically. It also publishes a committed **`.hunch/team.json`**
pointing at the store, so a fresh clone auto-connects on `hunch init` (agents and CI wire up
the same way via the MCP server) — everyone, on every branch, resolves the same memory.

## Private memory (public repo, private context)

Open-source your code without open-sourcing your *reasoning*. **`hunch private`** sets up a
separate private store in one command — Hunch unions it into every query and guard **locally**
(MCP and the pre-edit hook see your sensitive decisions/bugs/constraints) while your public
`.hunch/` stays clean. It writes a gitignored `.hunch/local.json` so it's auto-detected — **no
env var, no shell-profile edit** (and `HUNCH_PRIVATE_DIR` still overrides per-shell). **Opt-in,
default-off** (no config → fully inert), and **leak-safe by construction**: committed files and
the CI PR comment render *public-only*, so a private record can't reach a public surface. Record
sensitive items with `private: true` (`hunch_record_decision` / `hunch_record_correction`);
post-commit synthesis can route there too. Every capture is **auto-committed by default** to the
store it lands in — the private repo is committed + pushed; a public capture is committed to
`.hunch/` only and rides your next push (Hunch never pushes or merges your code branch) —
recursion-safe, staging only `.hunch/`. Opt out with `--no-auto-commit`.

Already published a repo *with* its `.hunch/` memory and want it private after the fact?
`hunch private --repo <url> --migrate` does it in one shot: it **moves** your existing public
records into the overlay (union by id — nothing is lost), empties the public store, untracks +
gitignores the `.hunch/` memory tree, and regenerates the assistant grounding (CLAUDE.md, AGENTS.md,
…) so the repo becomes **code-only**. It commits the private overlay for you and prints the one
`git` command to commit the now-clean public repo.
→ [docs](https://hunch-pi.vercel.app/docs#private)

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
opt-in, and it never drifts from your committed memory.

## VS Code

A companion **[VS Code extension](vscode-extension/)** (on
[Open VSX](https://open-vsx.org/extension/davesheffer/hunch-vscode) — VS Code / Cursor /
Windsurf / VSCodium) brings the graph into the editor: a tree of decisions / invariants /
bugs / bug-lineage / fragility / stale records, CodeLens summaries, hover with bug history,
invariants in the Problems panel, an interactive component graph, and a status-bar invariant
counter. It reads the committed `.hunch/` JSON directly; writes delegate to the `hunch` CLI.

## Architecture

Everything lives under `.hunch/` as plain git-tracked JSON — the source of truth; a fast local
index is built from it and is throwaway. Subscription-billed synthesis (never a pay-per-token
API key) with a no-LLM fallback, and atomic writes so an interrupted write can't corrupt your
memory. → [the docs](https://hunch-pi.vercel.app/docs) for the conceptual model.

## Develop

Hunch is open source — pure TypeScript ESM, Node ≥ 22.13, licensed **Apache-2.0**. Contributions
welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [repo](https://github.com/davesheffer/hunch).
