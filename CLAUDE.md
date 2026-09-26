# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Hunch is an **engineering-memory and architectural-conformance layer**: a CLI + MCP server that builds a persistent, git-native reasoning graph (decisions, bugs, constraints, components), delivers the relevant evidence to coding assistants, and checks their changes deterministically. Published as `@davesheffer/hunch` (`hunch` binary). Pure TypeScript ESM, Node ≥22.13, no build step at dev time (run via `tsx`).

Hunch keeps memory *true* along two spokes: **graph≠code** (Architectural Conformance / intent-conformance — does the code still satisfy recorded intent?) and, as of v0.39.0, **doc≠graph** (**decision-grounding** — does the prose still match the live decision?). The doc≠graph spoke extends to markdown itself (`src/core/docanchors.ts`): a `<!-- hunch:topic <topic> [dec_id] -->` marker in AGENTS.md/CLAUDE.md/docs grounds the pre-edit hook with that topic's current decision, and a *pinned* marker whose decision gets superseded fires deterministic `doc-anchor-stale` drift (CI-gated in `hunch drift`, healed via `hunch heal`). A decision can carry an optional `topic` anchor (drift-detection key; defaults null, no schema bump, existing graphs load unchanged) with a `current`/`history`/`rejected` query contract. Read-time grounding surfaces a file's topic-anchored decisions on the pre-edit hook (doc-precedence framing: follow the graph, not a stale doc — including what each decision *rejected*), and the deterministic `anchor-stale` drift kind fires when a file is still anchored to a SUPERSEDED decision while a current one exists for its topic.

## Commands

```bash
npm run dev -- <args>        # run the CLI from source via tsx (e.g. npm run dev -- doctor)
npm run hunch -- <args>      # alias for the above
npm run build                # clean + tsc -> dist/ (the published artifact; bin = dist/cli/index.js)
npm run typecheck            # tsc --noEmit
npm test                     # fixture-safe runner over test/*.test.ts
node tooling/run-tests.mjs test/check.test.ts  # run a single test file
```

There is no separate lint step; `typecheck` (strict `tsc`) is the gate. The `site/` and `vscode-extension/` dirs are independent sub-projects with their own tooling.

## Architecture

Data flows: **events → extract → synthesize → store → ground**. Source of truth is git-tracked JSON in `.hunch/`; SQLite (`node:sqlite`) is a derived FTS5 + graph + vector index, never authoritative.

- `src/cli/index.ts` — Commander entry point; defines every subcommand (`init`, `index`, `backfill`, `sync`, `query`, `why`, `check`, `ci`, `hook`, `mcp`, `migrate`, `compact`, `doctor`, `drift`, `reconcile-topics`, `heal`, `workspaces`, `branches`, etc.). `src/cli/invocation.ts` holds shared command logic. The workspace ledger (`docs/workspace-ledger.md`: `src/core/workspace.ts`, `src/core/machine.ts`, `src/extractors/workspaces.ts`) records each machine's worktrees and branches with deterministic merged verdicts; this machine is always read live from git, stored records are display-only. Decision-grounding adds: `hunch drift` (CI-gateable; exits non-zero on `anchor-stale` drift or topic collisions), `hunch reconcile-topics` (fails on >1 live decision per topic — the invariant a git merge can violate; wire into a post-merge hook / CI), and `hunch heal` (read-only doc↔graph reconciliation, never rewrites prose silently). `hunch init` scaffolds `/capture` and `/heal` slash commands.
- `src/extractors/` — deterministic, no-LLM layer: tree-sitter parsing (`parse.ts`), diff analysis, git history, test-report parsing, and `indexer.ts` which builds the symbol/dependency/component graph.
- `src/synthesis/` — turns a commit/diff into a structured Decision. Runs an external coding-assistant CLI (`claude`/`codex`/`cursor-agent`) on the user's **subscription**; falls back to a deterministic heuristic. `provider.ts` does detection.
- `src/store/` — `jsonStore.ts` (JSON source of truth, atomic writes), `db.ts`/`schema.ts` (SQLite index), `embedder.ts` (optional local embeddings via the optional `@huggingface/transformers` peer dep), `merge.ts`/`compact.ts`.
- `src/core/` — `types.ts` + Zod schemas, `migrate.ts` (forward-migration before validation), `io.ts` (atomic file IO), `hookpolicy.ts`/`strictgate.ts` (the Claude Code edit-hook gate), `checkreport.ts` (constraint-check output), `topics.ts` (topic anchor + `current`/`history`/`rejected` contract, one-live-decision-per-topic uniqueness guard), `drift.ts` (deterministic drift kinds incl. `anchor-stale`; explicit topic anchors only, no semantic guessing), `capturetoken.ts` (capture-session token).
- `src/mcp/server.ts` — MCP server (`hunch mcp`) exposing the `hunch_*` tools; must stay client-agnostic. Decision-grounding adds `hunch_capture_decision` (returns a one-question-at-a-time grilling protocol + a capture-session token) and `hunch_current_decision(topic)`; `hunch_record_decision` is now GATED by the store-scoped uniqueness guard (refuses a SECOND live decision per topic — never silently two) and accepts an optional `capture_token` (un-token'd writes still work but get nudged toward `/capture`).
- `src/integrations/` — writers that wire Hunch into a repo: `scaffold.ts`, `providers.ts`, `hooks.ts` (git post-commit, pre-commit, and post-merge — the last opportunistically detects a decision's commit provenance going orphaned by a squash-merge via `hunch repair-provenance` and queues the match in `.hunch/pending-commit-repairs.json`; a human confirms with `--apply`, since the match signal isn't strong enough to trust an unattended write), `claudemd.ts` (regenerates the auto block below), `ciAction.ts` (CI Constraint Guard), `mergeDriver.ts`, `gitignore.ts`.

This repo's full engineering memory lives in a **private overlay**; a **curated subset** — foundational decisions whose substance is already public in commit messages, plus the enforced constraints — is committed under `.hunch/` so the repo demos its own graph (the counts below). Maintainers with the overlay configured (`hunch private`) see the full graph via the `hunch_*` MCP tools.

<!-- HUNCH:START — auto-generated, do not edit by hand -->
<!-- hunch:template 2 -->
## 🧠 Hunch (Engineering Memory)

This repo has **Hunch**, a graph of *why* the code is the way it is. It holds **336 decisions, 2 bugs, 31 constraints, 22 components, 3 policies, 25 open findings**. Use the `hunch_*` MCP tools by moment:

- **Start:** reuse the task ID and `task verify` command the prompt hook printed; with none, call `hunch_task(action: "start", title)` once. Then `hunch_context(target, task_id)` first. Orient with `hunch_structure`, `hunch_workspaces`, `hunch_runbook(task)`. Ask the user about each `hunch_escalations()` entry; silence is never approval.
- **Design:** `hunch_why(target)` (includes what was rejected), `hunch_current_decision(topic)`, `hunch_bug_lineage(symptom_or_symbol)`, `hunch_compare(candidates)`, `hunch_query(query)`.
- **Edit:** `hunch_check_constraints(scope)`, `hunch_get_dependents(symbol)` / `hunch_blast_radius(target)`, `hunch_findings(scope?)`.
- **Merge:** `hunch_conformance()`, `hunch_pr_impact(base?)`, `hunch_merge_verdict`. Policy review: `hunch_policy_evaluate`, `hunch_policy_plan(policy_id)`, `hunch_policy_card(policy_id)`, `hunch_policy_proof`; only a human activates a policy.
- **Record:** `hunch_capture_decision` → `hunch_record_decision`; `hunch_record_correction` turns a human correction into an enforced rule; `hunch_record_finding` keeps an observation with evidence. Pass the task_id.
- **Finish:** run checks through the `task verify` launcher. If the task used Hunch, you started it, or no host stop hook closes it, call `hunch_task(action: "finish", task_id)` and show its card verbatim. Its `applications` schema carries the claim rules.
- To update Hunch, run `hunch update` from the repo root.

### ⛔ Top invariants (do not break)
- **[blocking]** Synthesis must use an explicitly selected coding-assistant subscription CLI or the deterministic local fallback; never call a pay-per-token API _(scope: src/synthesis/**; con_2ce3f2a547)_
- **[blocking]** This repo's generated wiki must never be committed to the public repo — private overlay wiki only (hunch wiki --private); wiki/ stays gitignored _(scope: wiki/**; con_547fff76bd)_
- **[blocking]** Config/provider writers must merge idempotently into existing user files and refuse to clobber an unparseable file _(scope: src/integrations/claudeConfig.ts, src/integrations/claudemd.ts, src/integrations/providers.ts, src/integrations/scaffold.ts; con_8460b6770f)_
- **[blocking]** All JSON writes to .hunch/ must be atomic (temp-file + rename) so an interrupted write can never truncate the index _(scope: src/store/**, src/core/io.ts; con_902759b3dc)_
- **[blocking]** Forward-migrate raw JSON to the current schema BEFORE Zod validation; never silently drop unmigratable records _(scope: src/core/migrate.ts, src/store/jsonStore.ts; con_947c578b2c)_
- **[blocking]** Semantic vectors are a derived layer in SQLite, never the source of truth; reconcile by content hash on reindex _(scope: src/store/**; con_a87360128b)_
- **[warning]** Replace the blue-violet palette in the homepage particle helicoid with the prior green Hunch palette; convey gene mapping through structured loci, paired bands, quiet gaps, and moving mapped regions… _(scope: site/dna-hero.js; con_009f720549)_
- **[warning]** Memory hygiene is the agent's job, done without waiting for the human: accept shipped roadmap proposals, settle provenance-repair escalations (apply the true commit or drop), re-anchor or stale… _(scope: .hunch/**, ROADMAP.md, docs/autonomous-development.md; con_039cee7367)_

_Records carry provenance and confidence; treat low-confidence items as advisory._
<!-- HUNCH:END -->
