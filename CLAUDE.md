# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Hunch is an **Engineering Memory OS**: a CLI + MCP server that builds a persistent, git-native reasoning graph (decisions, bugs, constraints, components) over a codebase and surfaces it to coding assistants. Published as `@davesheffer/hunch` (`hunch` binary). Pure TypeScript ESM, Node ≥22.13, no build step at dev time (run via `tsx`).

Hunch keeps memory *true* along two spokes: **graph≠code** (Architectural Conformance / intent-conformance — does the code still satisfy recorded intent?) and, as of v0.39.0, **doc≠graph** (**decision-grounding** — does the prose still match the live decision?). The doc≠graph spoke extends to markdown itself (`src/core/docanchors.ts`): a `<!-- hunch:topic <topic> [dec_id] -->` marker in AGENTS.md/CLAUDE.md/docs grounds the pre-edit hook with that topic's current decision, and a *pinned* marker whose decision gets superseded fires deterministic `doc-anchor-stale` drift (CI-gated in `hunch drift`, healed via `hunch heal`). A decision can carry an optional `topic` anchor (drift-detection key; defaults null, no schema bump, existing graphs load unchanged) with a `current`/`history`/`rejected` query contract. Read-time grounding surfaces a file's topic-anchored decisions on the pre-edit hook (doc-precedence framing: follow the graph, not a stale doc — including what each decision *rejected*), and the deterministic `anchor-stale` drift kind fires when a file is still anchored to a SUPERSEDED decision while a current one exists for its topic.

## Commands

```bash
npm run dev -- <args>        # run the CLI from source via tsx (e.g. npm run dev -- doctor)
npm run hunch -- <args>      # alias for the above
npm run build                # clean + tsc -> dist/ (the published artifact; bin = dist/cli/index.js)
npm run typecheck            # tsc --noEmit
npm test                     # tsx --test over test/*.test.ts
tsx --test test/check.test.ts   # run a single test file
```

There is no separate lint step; `typecheck` (strict `tsc`) is the gate. The `site/` and `vscode-extension/` dirs are independent sub-projects with their own tooling.

## Architecture

Data flows: **events → extract → synthesize → store → ground**. Source of truth is git-tracked JSON in `.hunch/`; SQLite (`node:sqlite`) is a derived FTS5 + graph + vector index, never authoritative.

- `src/cli/index.ts` — Commander entry point; defines every subcommand (`init`, `index`, `backfill`, `sync`, `query`, `why`, `check`, `ci`, `hook`, `mcp`, `migrate`, `compact`, `doctor`, `drift`, `reconcile-topics`, `heal`, etc.). `src/cli/invocation.ts` holds shared command logic. Decision-grounding adds: `hunch drift` (CI-gateable; exits non-zero on `anchor-stale` drift or topic collisions), `hunch reconcile-topics` (fails on >1 live decision per topic — the invariant a git merge can violate; wire into a post-merge hook / CI), and `hunch heal` (read-only doc↔graph reconciliation, never rewrites prose silently). `hunch init` scaffolds `/capture` and `/heal` slash commands.
- `src/extractors/` — deterministic, no-LLM layer: tree-sitter parsing (`parse.ts`), diff analysis, git history, test-report parsing, and `indexer.ts` which builds the symbol/dependency/component graph.
- `src/synthesis/` — turns a commit/diff into a structured Decision. Runs an external coding-assistant CLI (`claude`/`codex`/`cursor-agent`) on the user's **subscription**; falls back to a deterministic heuristic. `provider.ts` does detection.
- `src/store/` — `jsonStore.ts` (JSON source of truth, atomic writes), `db.ts`/`schema.ts` (SQLite index), `embedder.ts` (optional local embeddings via the optional `@huggingface/transformers` peer dep), `merge.ts`/`compact.ts`.
- `src/core/` — `types.ts` + Zod schemas, `migrate.ts` (forward-migration before validation), `io.ts` (atomic file IO), `hookpolicy.ts`/`strictgate.ts` (the Claude Code edit-hook gate), `checkreport.ts` (constraint-check output), `topics.ts` (topic anchor + `current`/`history`/`rejected` contract, one-live-decision-per-topic uniqueness guard), `drift.ts` (deterministic drift kinds incl. `anchor-stale`; explicit topic anchors only, no semantic guessing), `capturetoken.ts` (capture-session token).
- `src/mcp/server.ts` — MCP server (`hunch mcp`) exposing the `hunch_*` tools; must stay client-agnostic. Decision-grounding adds `hunch_capture_decision` (returns a one-question-at-a-time grilling protocol + a capture-session token) and `hunch_current_decision(topic)`; `hunch_record_decision` is now GATED by the store-scoped uniqueness guard (refuses a SECOND live decision per topic — never silently two) and accepts an optional `capture_token` (un-token'd writes still work but get nudged toward `/capture`).
- `src/integrations/` — writers that wire Hunch into a repo: `scaffold.ts`, `providers.ts`, `hooks.ts` (git post-commit), `claudemd.ts` (regenerates the auto block below), `ciAction.ts` (CI Constraint Guard), `mergeDriver.ts`, `gitignore.ts`.

This repo's full engineering memory lives in a **private overlay**; a **curated subset** — foundational decisions whose substance is already public in commit messages, plus the enforced constraints — is committed under `.hunch/` so the repo demos its own graph (the counts below). Maintainers with the overlay configured (`hunch private`) see the full graph via the `hunch_*` MCP tools.

<!-- HUNCH:START — auto-generated, do not edit by hand -->
## 🧠 Hunch (Engineering Memory)

This repo has **Hunch** — a curated graph of *why* the code is the way it is (decisions, bug history, invariants). It currently holds **12 decisions, 0 bugs, 7 constraints, 10 components**.

**Before reasoning about or editing this codebase, consult Hunch via the `hunch_*` MCP tools:**
- `hunch_why(target)` — why a file/symbol is shaped this way (decisions, bugs, constraints).
- `hunch_check_constraints(scope)` — invariants you must not break. **Always run before editing.**
- `hunch_get_dependents(symbol)` — blast radius before a change.
- `hunch_bug_lineage(symptom_or_symbol)` — has this bug happened before? what was the root cause?
- `hunch_query(query)` — free-text search across all of Hunch.
- `hunch_runbook(task)` — the proven steps for a recurring task (e.g. "add an MCP tool", "cut a release").
- `hunch_compare(candidates)` — rank N candidate branches/commits by architectural fit (fewest invariant hits).
- `hunch_conformance()` — does the code still SATISFY recorded intent? (e.g. `pay` still reaches `verifySession`). Run before a refactor.
- `hunch_record_decision(...)` — write back a decision after a non-trivial choice.

### ⛔ Top invariants (do not break)
- **[blocking]** Synthesis must run on the Claude subscription, never the pay-per-token API: strip ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from the spawned env _(scope: src/synthesis/**; con_2ce3f2a547)_
- **[blocking]** Config/provider writers must merge idempotently into existing user files and refuse to clobber an unparseable file _(scope: src/integrations/**; con_8460b6770f)_
- **[blocking]** All JSON writes to .hunch/ must be atomic (temp-file + rename) so an interrupted write can never truncate the index _(scope: src/store/**, src/core/io.ts; con_902759b3dc)_
- **[blocking]** Forward-migrate raw JSON to the current schema BEFORE Zod validation; never silently drop unmigratable records _(scope: src/core/migrate.ts, src/store/jsonStore.ts; con_947c578b2c)_
- **[blocking]** Semantic vectors are a derived layer in SQLite, never the source of truth; reconcile by content hash on reindex _(scope: src/store/**; con_a87360128b)_
- **[warning]** The agent hook must never block an edit on failure: any error or unrecognized input emits nothing and exits 0 _(scope: src/core/hookpolicy.ts; con_03a0b94b2e)_
- **[warning]** The MCP server must stay client-agnostic: all assistants point to the same .hunch/ graph; no Claude-only behavior in the server _(scope: src/mcp/**; con_e04226bd05)_

_Hunch updates itself from commits and test failures. Records carry provenance + confidence; treat low-confidence items as advisory._
<!-- HUNCH:END -->
