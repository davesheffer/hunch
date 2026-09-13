/**
 * Auto-maintained CLAUDE.md (DESIGN.md §7, integration layer 2: "ambient
 * context loaded every session for free"). We own ONLY the region between the
 * HUNCH markers — any user-authored content outside it is preserved verbatim.
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { writeFileAtomic } from "../core/io.js";
import { basename, join, dirname } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import { wikiSummary } from "../wiki/wiki.js";
import { PolicyRepository } from "../constitution/repository.js";
import { renderCountsMatch } from "../core/groundingLag.js";

const START = "<!-- HUNCH:START — auto-generated, do not edit by hand -->";
const END = "<!-- HUNCH:END -->";

/** Remove the managed HUNCH section (markers inclusive), leaving only the
 *  user-authored surroundings. Lets a caller decide whether two versions of a
 *  doc differ ONLY in generated content (the stranded-grounding heal,
 *  fnd_b269d5c422): equal outside the block ⇒ regenerating cannot lose prose. */
export function stripManagedSection(text: string): string {
  const iStart = text.indexOf(START);
  const iEnd = text.indexOf(END);
  if (iStart < 0 || iEnd <= iStart) return text;
  return text.slice(0, iStart) + text.slice(iEnd + END.length);
}

export function renderHunchSection(store: HunchStore, root?: string): string {
  const constraints = store.json
    .loadAll("constraints")
    .filter((c) => c.status === "active" && !c.valid_to)
    .sort((a, b) => sev(b.severity) - sev(a.severity))
    .slice(0, 8);
  const counts = {
    decisions: store.json.loadAll("decisions").length,
    bugs: store.json.loadAll("bugs").length,
    constraints: store.json.loadAll("constraints").length,
    components: store.json.loadAll("components").length,
    policies: root ? new PolicyRepository(root, store).listPolicies({ publicOnly: true }).length : 0,
    findings: store.json.loadAll("findings").filter((f) => f.triage === "open" || f.triage === "accepted-risk" || f.triage === "scheduled").length,
  };

  const lines: string[] = [];
  lines.push(START);
  lines.push("## 🧠 Hunch (Engineering Memory)");
  lines.push("");
  lines.push(
    "This repo has **Hunch** — a curated graph of *why* the code is the way it is " +
      "(decisions, bug history, invariants). It currently holds " +
      `${renderCountsMatch(counts)}.`,
  );
  lines.push("");
  lines.push("**Consult Hunch via the `hunch_*` MCP tools — pick by MOMENT, not from memory:**");
  lines.push("");
  lines.push("**Orient (session/task start):**");
  lines.push("- For a new user task, call `hunch_task(action: \"start\", title: <short task title>)` once and retain its `task_id`. Claude Code's prompt hook supplies a task ID natively — reuse its exact start arguments instead of creating another task (each new prompt has its own ID). Codex supplies one the same way once its `.codex/hooks.json` is trusted (`/hooks`). Hosts without prompt hooks (Windsurf, Cursor) never receive one: start the task yourself. Reuse the ID for follow-up work on the same task; never borrow another task's ID. This is task bookkeeping; `hunch_context` remains the first memory lookup. If reporting fails, continue the work and disclose the gap.");
  lines.push("- When the user asks to **update Hunch**, run `hunch update` from this repository root. It updates to the latest release and repairs all configured harness pins. Use `hunch update --global` to also update a global CLI alongside a repository dependency; reconnect active MCP sessions afterward.");
  lines.push("- `hunch_context(target, task_id)` — the minimal relevant slice for what you're about to do; a task phrase falls back to the closest graph matches. **Call FIRST** for memory. Include the current task ID on each context call so its contribution is inspectable.");
  lines.push("- `hunch_structure(target?)` — the indexed shape of the repo/dir/file/symbol — orient from the graph, not grep rounds.");
  lines.push("- `hunch_runbook(task)` — the proven steps for a recurring task, before re-deriving them.");
  lines.push("- `hunch_escalations()` — the decisions only the HUMAN can make (including one exact imported ADR at a time, topic conflicts, and policy calls). Normally empty; when it isn't, ASK the user inline — an entry is a question, silence is never approval. Apply an ADR answer only through `hunch_review_imported_adr` with its printed source and review hashes.");
  lines.push("- `hunch now` (CLI) — recent decisions + the live roadmap; `hunch log` — the memory-move timeline (every capture/adopt/supersede/prune/repair, each revertable).");
  lines.push("");
  lines.push("**Before designing / choosing an approach:**");
  lines.push("- `hunch_why(target)` — why a file/symbol is shaped this way (decisions, bugs, constraints) — including what was already REJECTED.");
  lines.push("- `hunch_current_decision(topic)` — the one live answer for a topic (history + rejected included).");
  lines.push("- `hunch_bug_lineage(symptom_or_symbol)` — has this failed before? what was the root cause?");
  lines.push("- `hunch_compare(candidates)` — rank candidate branches/commits by fewest invariant hits.");
  lines.push("- `hunch_query(query)` — free-text search when nothing above fits.");
  lines.push("");
  lines.push("**Before editing:**");
  lines.push("- `hunch_check_constraints(scope)` and `hunch_get_dependents(symbol)` / `hunch_blast_radius(target)` — invariants in scope + who you'd break. (The pre-edit hook injects this per file automatically; call these for PLANNING breadth.)");
  lines.push("- `hunch_findings(scope?)` — known-but-unfixed gaps in the area (past audits, measurements, incidents) so you inherit them instead of re-discovering them.");
  lines.push("");
  lines.push("**Before committing / merging:**");
  lines.push("- `hunch_conformance()` — does the code still SATISFY recorded intent? Run before and after a refactor.");
  lines.push("- `hunch_policy_evaluate(policy_id?, active_only?)` / `hunch_policy_plan(policy_id)` / `hunch_policy_card(policy_id)` / `hunch_policy_proof(policy_id)` — evaluate canonical policy, inspect the planned corpus, review the evidence/uncertainty card, and inspect raw replay receipts; only an explicit human activation grants authority.");
  lines.push("- `hunch_pr_impact(base?)` / `hunch_merge_verdict(...)` — a change's memory surface; would it re-open a closed bug?");
  lines.push("");
  lines.push("**Before the final response — make Hunch's contribution visible:**");
  lines.push("- When running a relevant check, use the exact verification_argv launcher returned by hunch_task start, followed by the check command and its arguments, from this worktree. It runs `hunch task verify <task_id> -- <command> [arguments]` using the same installation as MCP, avoiding stale global binaries. This retains the actual exit result and source snapshot; raw output is not stored. Do not rerun an expensive check solely for reporting; missing evidence stays unverified.");
  lines.push("- Include the current task_id when calling hunch_record_decision, hunch_record_correction, or hunch_record_finding. The save path records its actual memory home and verifies exact Git revisions when committing or pushing; never infer publication from a successful capture alone.");
  lines.push("- Before claiming an application, call `hunch_report(task_id)` and copy the exact occurrence_id, record_id and content_hash from application_references, adding an action you actually took. Never derive an occurrence ID by replacing a receipt prefix or use the task's scope hash as a record hash. If you did not apply a lesson, omit applications.");
  lines.push("- Call `hunch_task(action: \"finish\", task_id, applications?)` and include the returned contribution_card in your final response without the user asking. Render its Markdown evidence link outside any code block so it remains clickable. Copy the card with its evidence link and agent-reported label intact; the structured result contains the card even when the host hides text blocks. Do not replace it with a generic claim that Hunch helped. If presentation_enabled is false, omit the card. A delivered lesson or passing command alone does not prove causal impact.");
  lines.push("- If interrupted, finish with `outcome: \"interrupted\"` when possible. `hunch_report(task_id, html: true)` opens the evidence trail by generating a local file; it may contain private memory and is not a public export. If report tools are unavailable after an update, say so and reconnect the host rather than inventing a report.");
  lines.push("");
  lines.push("**Build the Constitution review queue:**");
  lines.push("- `hunch constitution bootstrap --since 90d --max-candidates 3` (CLI) — normalize recent structured human evidence into at most three non-active policy candidates; add `--history` for exact, human-identifier-grounded fix/revert deltas or explicit dependency retirements. Coincidence/ambiguity stays uncompilable; neither path grants authority.");
  lines.push("- `hunch constitution ingest --since 90d [--instructions] [--from export.json]` (CLI) — normalize corrections/failures plus bounded committed instructions/ADRs and strict local review/conversation/PR exports into Git-native evidence; raw prose is hash-only, unsupported intent remains uncompilable, and no policy is minted.");
  lines.push("");
  lines.push("**After deciding / when corrected:**");
  lines.push("- `hunch_capture_decision(topic?)` → `hunch_record_decision(...)` — interview first, then write; status `proposed` = roadmap intent (shows in `hunch now`).");
  lines.push("- `hunch_record_correction(...)` — a human correction becomes an ENFORCED rule (Never Twice), not a one-session memory.");
  lines.push("- `hunch_record_finding(...)` — an OBSERVATION with no code change (an audit that found a gap, a measured number, an incident) becomes durable memory anchored to a date + evidence; `/audit` runs the ritual.");
  lines.push("- `hunch_timeline(target)` — decision history when investigating how something evolved.");
  const wiki = root ? wikiSummary(root) : null;
  if (wiki) {
    lines.push("");
    lines.push(
      `📖 Component wiki: \`${wiki.dir}/\` (${wiki.pages} page(s)) — a GENERATED view of this graph; the graph stays the source of truth. Stale pages surface in \`hunch drift\`; regenerate with \`hunch wiki --heal\`.`,
    );
  }
  if (constraints.length) {
    lines.push("");
    lines.push("### ⛔ Top invariants (do not break)");
    for (const c of constraints) {
      lines.push(`- **[${c.severity}]** ${c.statement} _(scope: ${c.scope.join(", ") || "repo"}; ${c.id})_`);
    }
  }
  lines.push("");
  lines.push("_Hunch updates itself from commits and test failures. Records carry provenance + confidence; treat low-confidence items as advisory._");
  lines.push(END);
  return lines.join("\n");
}

/** Insert/replace the marker-delimited HUNCH section in a markdown doc, preserving
 *  all user-authored content outside the markers. Shared by CLAUDE.md, AGENTS.md,
 *  and .github/copilot-instructions.md so every assistant gets the same grounding. */
export function upsertSection(file: string, section: string, fallbackTitle: string): string {
  let content = existsSync(file) ? readFileSync(file, "utf8") : "";
  const iStart = content.indexOf(START);
  const iEnd = content.indexOf(END);
  if (iStart >= 0 && iEnd > iStart) {
    content = content.slice(0, iStart) + section + content.slice(iEnd + END.length);
  } else if (iStart >= 0 || iEnd >= 0) {
    // partial/corrupt markers: strip stray marker lines, then append ONE clean section.
    const body = content.split("\n").filter((l) => !l.includes(START) && !l.includes(END)).join("\n").trimEnd();
    content = body ? `${body}\n\n${section}\n` : `${section}\n`;
  } else if (content.trim()) {
    content = `${content.trimEnd()}\n\n${section}\n`;
  } else {
    content = `${fallbackTitle}\n\n${section}\n`;
  }
  mkdirSync(dirname(file), { recursive: true }); // e.g. .github/ for copilot-instructions
  // Atomic: this file carries the USER'S prose around the managed block — a torn
  // write must not be able to truncate it (issue #43).
  writeFileAtomic(file, content);
  return file;
}

/** Insert/replace the HUNCH section in CLAUDE.md, preserving everything else. */
export function updateClaudeMd(root: string, store: HunchStore): string {
  return upsertSection(join(root, "CLAUDE.md"), renderHunchSection(store, root), `# ${basename(root)}`);
}

function sev(s: string): number {
  return ({ blocking: 3, warning: 2, advisory: 1 } as Record<string, number>)[s] ?? 0;
}
