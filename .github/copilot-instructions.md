# Copilot instructions

<!-- HUNCH:START — auto-generated, do not edit by hand -->
## 🧠 Hunch (Engineering Memory)

This repo has **Hunch** — a curated graph of *why* the code is the way it is (decisions, bug history, invariants). It currently holds **252 decisions, 2 bugs, 28 constraints, 22 components, 3 policies, 2 open findings**.

**Consult Hunch via the `hunch_*` MCP tools — pick by MOMENT, not from memory:**

**Orient (session/task start):**
- For a new user task, call `hunch_task(action: "start", title: <short task title>)` once and retain its `task_id`. If a native prompt hook already supplied a task ID, reuse its exact start arguments instead of creating another task; each new native prompt has its own ID. Otherwise reuse the ID for follow-up work on the same task; never borrow another task's ID. This is task bookkeeping; `hunch_context` remains the first memory lookup. If reporting fails, continue the work and disclose the gap.
- When the user asks to **update Hunch**, run `hunch update` from this repository root. It updates to the latest release and repairs all configured harness pins. Use `hunch update --global` to also update a global CLI alongside a repository dependency; reconnect active MCP sessions afterward.
- `hunch_context(target, task_id)` — the minimal relevant slice for what you're about to do; a task phrase falls back to the closest graph matches. **Call FIRST** for memory. Include the current task ID on each context call so its contribution is inspectable.
- `hunch_structure(target?)` — the indexed shape of the repo/dir/file/symbol — orient from the graph, not grep rounds.
- `hunch_runbook(task)` — the proven steps for a recurring task, before re-deriving them.
- `hunch_escalations()` — the decisions only the HUMAN can make (including one exact imported ADR at a time, topic conflicts, and policy calls). Normally empty; when it isn't, ASK the user inline — an entry is a question, silence is never approval. Apply an ADR answer only through `hunch_review_imported_adr` with its printed source and review hashes.
- `hunch now` (CLI) — recent decisions + the live roadmap; `hunch log` — the memory-move timeline (every capture/adopt/supersede/prune/repair, each revertable).

**Before designing / choosing an approach:**
- `hunch_why(target)` — why a file/symbol is shaped this way (decisions, bugs, constraints) — including what was already REJECTED.
- `hunch_current_decision(topic)` — the one live answer for a topic (history + rejected included).
- `hunch_bug_lineage(symptom_or_symbol)` — has this failed before? what was the root cause?
- `hunch_compare(candidates)` — rank candidate branches/commits by fewest invariant hits.
- `hunch_query(query)` — free-text search when nothing above fits.

**Before editing:**
- `hunch_check_constraints(scope)` and `hunch_get_dependents(symbol)` / `hunch_blast_radius(target)` — invariants in scope + who you'd break. (The pre-edit hook injects this per file automatically; call these for PLANNING breadth.)
- `hunch_findings(scope?)` — known-but-unfixed gaps in the area (past audits, measurements, incidents) so you inherit them instead of re-discovering them.

**Before committing / merging:**
- `hunch_conformance()` — does the code still SATISFY recorded intent? Run before and after a refactor.
- `hunch_policy_evaluate(policy_id?, active_only?)` / `hunch_policy_plan(policy_id)` / `hunch_policy_card(policy_id)` / `hunch_policy_proof(policy_id)` — evaluate canonical policy, inspect the planned corpus, review the evidence/uncertainty card, and inspect raw replay receipts; only an explicit human activation grants authority.
- `hunch_pr_impact(base?)` / `hunch_merge_verdict(...)` — a change's memory surface; would it re-open a closed bug?

**Before the final response — make Hunch's contribution visible:**
- When running a relevant check, use the exact verification_argv launcher returned by hunch_task start, followed by the check command and its arguments, from this worktree. It runs `hunch task verify <task_id> -- <command> [arguments]` using the same installation as MCP, avoiding stale global binaries. This retains the actual exit result and source snapshot; raw output is not stored. Do not rerun an expensive check solely for reporting; missing evidence stays unverified.
- Include the current task_id when calling hunch_record_decision, hunch_record_correction, or hunch_record_finding. The save path records its actual memory home and verifies exact Git revisions when committing or pushing; never infer publication from a successful capture alone.
- Before claiming an application, call `hunch_report(task_id)` and copy the exact occurrence_id, record_id and content_hash from application_references, adding an action you actually took. Never derive an occurrence ID by replacing a receipt prefix or use the task's scope hash as a record hash. If you did not apply a lesson, omit applications.
- Call `hunch_task(action: "finish", task_id, applications?)` and include the returned contribution_card in your final response without the user asking. Render its Markdown evidence link outside any code block so it remains clickable. Copy the card with its evidence link and agent-reported label intact; the structured result contains the card even when the host hides text blocks. Do not replace it with a generic claim that Hunch helped. If presentation_enabled is false, omit the card. A delivered lesson or passing command alone does not prove causal impact.
- If interrupted, finish with `outcome: "interrupted"` when possible. `hunch_report(task_id, html: true)` opens the evidence trail by generating a local file; it may contain private memory and is not a public export. If report tools are unavailable after an update, say so and reconnect the host rather than inventing a report.

**Build the Constitution review queue:**
- `hunch constitution bootstrap --since 90d --max-candidates 3` (CLI) — normalize recent structured human evidence into at most three non-active policy candidates; add `--history` for exact, human-identifier-grounded fix/revert deltas or explicit dependency retirements. Coincidence/ambiguity stays uncompilable; neither path grants authority.
- `hunch constitution ingest --since 90d [--instructions] [--from export.json]` (CLI) — normalize corrections/failures plus bounded committed instructions/ADRs and strict local review/conversation/PR exports into Git-native evidence; raw prose is hash-only, unsupported intent remains uncompilable, and no policy is minted.

**After deciding / when corrected:**
- `hunch_capture_decision(topic?)` → `hunch_record_decision(...)` — interview first, then write; status `proposed` = roadmap intent (shows in `hunch now`).
- `hunch_record_correction(...)` — a human correction becomes an ENFORCED rule (Never Twice), not a one-session memory.
- `hunch_record_finding(...)` — an OBSERVATION with no code change (an audit that found a gap, a measured number, an incident) becomes durable memory anchored to a date + evidence; `/audit` runs the ritual.
- `hunch_timeline(target)` — decision history when investigating how something evolved.

### ⛔ Top invariants (do not break)
- **[blocking]** Synthesis must use an explicitly selected coding-assistant subscription CLI or the deterministic local fallback; never call a pay-per-token API _(scope: src/synthesis/**; con_2ce3f2a547)_
- **[blocking]** This repo's generated wiki must never be committed to the public repo — private overlay wiki only (hunch wiki --private); wiki/ stays gitignored _(scope: wiki/**; con_547fff76bd)_
- **[blocking]** Config/provider writers must merge idempotently into existing user files and refuse to clobber an unparseable file _(scope: src/integrations/claudeConfig.ts, src/integrations/claudemd.ts, src/integrations/providers.ts, src/integrations/scaffold.ts; con_8460b6770f)_
- **[blocking]** All JSON writes to .hunch/ must be atomic (temp-file + rename) so an interrupted write can never truncate the index _(scope: src/store/**, src/core/io.ts; con_902759b3dc)_
- **[blocking]** Forward-migrate raw JSON to the current schema BEFORE Zod validation; never silently drop unmigratable records _(scope: src/core/migrate.ts, src/store/jsonStore.ts; con_947c578b2c)_
- **[blocking]** Semantic vectors are a derived layer in SQLite, never the source of truth; reconcile by content hash on reindex _(scope: src/store/**; con_a87360128b)_
- **[warning]** Replace the blue-violet palette in the homepage particle helicoid with the prior green Hunch palette; convey gene mapping through structured loci, paired bands, quiet gaps, and moving mapped regions woven into the surface, without external labels or geometry/background changes. _(scope: site/dna-hero.js; con_009f720549)_
- **[warning]** The agent hook must never block an edit on failure: any error or unrecognized input emits nothing and exits 0 _(scope: src/core/hookpolicy.ts; con_03a0b94b2e)_

_Hunch updates itself from commits and test failures. Records carry provenance + confidence; treat low-confidence items as advisory._
<!-- HUNCH:END -->
