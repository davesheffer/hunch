# Copilot instructions

<!-- HUNCH:START — auto-generated, do not edit by hand -->
## 🧠 Hunch (Engineering Memory)

This repo has **Hunch** — a curated graph of *why* the code is the way it is (decisions, bug history, invariants). It currently holds **26 decisions, 0 bugs, 8 constraints, 11 components**.

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
- **[blocking]** This repo's generated wiki must never be committed to the public repo — private overlay wiki only (hunch wiki --private); wiki/ stays gitignored _(scope: wiki/**; con_547fff76bd)_
- **[blocking]** Config/provider writers must merge idempotently into existing user files and refuse to clobber an unparseable file _(scope: src/integrations/**; con_8460b6770f)_
- **[blocking]** All JSON writes to .hunch/ must be atomic (temp-file + rename) so an interrupted write can never truncate the index _(scope: src/store/**, src/core/io.ts; con_902759b3dc)_
- **[blocking]** Forward-migrate raw JSON to the current schema BEFORE Zod validation; never silently drop unmigratable records _(scope: src/core/migrate.ts, src/store/jsonStore.ts; con_947c578b2c)_
- **[blocking]** Semantic vectors are a derived layer in SQLite, never the source of truth; reconcile by content hash on reindex _(scope: src/store/**; con_a87360128b)_
- **[warning]** The agent hook must never block an edit on failure: any error or unrecognized input emits nothing and exits 0 _(scope: src/core/hookpolicy.ts; con_03a0b94b2e)_
- **[warning]** The MCP server must stay client-agnostic: all assistants point to the same .hunch/ graph; no Claude-only behavior in the server _(scope: src/mcp/**; con_e04226bd05)_

_Hunch updates itself from commits and test failures. Records carry provenance + confidence; treat low-confidence items as advisory._
<!-- HUNCH:END -->
