---
trigger: always_on
description: Hunch engineering memory — consult the hunch_* MCP tools before editing
---

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
