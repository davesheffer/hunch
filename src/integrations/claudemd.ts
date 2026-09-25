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
import { renderCountsMatch, parseGroundingCounts, groundingTemplate } from "../core/groundingLag.js";

const START = "<!-- HUNCH:START — auto-generated, do not edit by hand -->";
const END = "<!-- HUNCH:END -->";

/** Version of the block's PROSE. Bump it whenever renderHunchSection's wording
 *  changes. A block without the stamp is template 1. */
export const GROUNDING_TEMPLATE = 2;
/** The pre-edit hook injects each in-scope invariant in full; the always-loaded
 *  list only has to name it (fnd_a65f71f38f, #369). Blocking statements are never
 *  clipped; others are cut at a word boundary within this many chars. */
const INVARIANT_CHARS = 200;

export { groundingTemplate };

/** Never downgrade a block's prose (fnd_f6875f475b). The post-commit capture runs
 *  the PINNED hunch, which can be older than the renderer that wrote the committed
 *  block (a branch that develops the renderer, or a repo whose pin lags its docs).
 *  When the existing block carries a newer template than `section`, keep its prose
 *  and move only the record counts, so the counts stay true without reverting text
 *  this version did not author. The preserved block keeps its wiki line and those
 *  Top-invariants lines whose constraint this version still renders.
 *  Returns the section to write. */
export function preserveNewerTemplate(existing: string, section: string): string {
  const iStart = existing.indexOf(START);
  const iEnd = existing.indexOf(END);
  if (iStart < 0 || iEnd <= iStart) return section;
  const current = existing.slice(iStart, iEnd + END.length);
  if (groundingTemplate(current) <= groundingTemplate(section)) return section;
  // Never republish an invariant this version no longer renders: a constraint that
  // was retired, deleted, or moved to the private overlay drops out of the kept list.
  const rendered = new Set(section.split(/\r?\n/).map((line) => INVARIANT_LINE_RE.exec(line)?.[1]).filter(Boolean));
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const lines = current.split(/\r?\n/).filter((line) => {
    const id = INVARIANT_LINE_RE.exec(line)?.[1];
    return !id || rendered.has(id);
  });
  // A heading left with no invariants under it goes too.
  const h = lines.findIndex((line) => line.startsWith(INVARIANTS_HEADING));
  if (h >= 0 && !lines.slice(h + 1).some((line) => INVARIANT_LINE_RE.test(line))) {
    lines.splice(lines[h - 1] === "" ? h - 1 : h, lines[h - 1] === "" ? 2 : 1);
  }
  const kept = lines.join(eol);
  const have = parseGroundingCounts(kept);
  const next = parseGroundingCounts(section);
  // Unreadable counts leave the counts sentence as written rather than downgrading
  // the block (two versions would flip-flop); `hunch grounding` reports countsReadable: false.
  return have && next ? kept.replace(have.match, next.match) : kept;
}

const INVARIANTS_HEADING = "### ⛔ Top invariants";
/** A Top-invariants line; group 1 is its constraint id. */
const INVARIANT_LINE_RE = /^- \*\*\[[a-z]+\]\*\* .*; (con_[A-Za-z0-9_]+)\)_\r?$/;

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

  // Name the policy tools only where the MCP server registers them by default
  // (src/mcp/toolset.ts: on once the repo holds a policy). Only committed evidence counts:
  // env and the gitignored .hunch/config.json would make the committed block differ by
  // machine. No root (a bare render) keeps the full list.
  const policyTools = !root || counts.policies > 0;

  const lines: string[] = [];
  lines.push(START);
  lines.push(`<!-- hunch:template ${GROUNDING_TEMPLATE} -->`);
  lines.push("## 🧠 Hunch (Engineering Memory)");
  lines.push("");
  lines.push(
    "This repo has **Hunch**, a graph of *why* the code is the way it is. It holds " +
      `${renderCountsMatch(counts)}. Use the \`hunch_*\` MCP tools by moment:`,
  );
  lines.push("");
  lines.push("- **Start:** reuse the task ID and `task verify` command the prompt hook printed; with none, call `hunch_task(action: \"start\", title)` once. Then `hunch_context(target, task_id)` first. Orient with `hunch_structure`, `hunch_workspaces`, `hunch_runbook(task)`. Ask the user about each `hunch_escalations()` entry; silence is never approval.");
  lines.push("- **Design:** `hunch_why(target)` (includes what was rejected), `hunch_current_decision(topic)`, `hunch_bug_lineage(symptom_or_symbol)`, `hunch_compare(candidates)`, `hunch_query(query)`.");
  lines.push("- **Edit:** `hunch_check_constraints(scope)`, `hunch_get_dependents(symbol)` / `hunch_blast_radius(target)`, `hunch_findings(scope?)`.");
  lines.push(
    "- **Merge:** `hunch_conformance()`, `hunch_pr_impact(base?)`, `hunch_merge_verdict`." +
      (policyTools ? " Policy review: `hunch_policy_evaluate`, `hunch_policy_plan(policy_id)`, `hunch_policy_card(policy_id)`, `hunch_policy_proof`; only a human activates a policy." : ""),
  );
  lines.push("- **Record:** `hunch_capture_decision` → `hunch_record_decision`; `hunch_record_correction` turns a human correction into an enforced rule; `hunch_record_finding` keeps an observation with evidence. Pass the task_id.");
  lines.push("- **Finish:** run checks through the `task verify` launcher. If the task used Hunch, you started it, or no host stop hook closes it, call `hunch_task(action: \"finish\", task_id)` and show its card verbatim. Its `applications` schema carries the claim rules.");
  lines.push("- To update Hunch, run `hunch update` from the repo root.");
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
      lines.push(`- **[${c.severity}]** ${c.severity === "blocking" ? c.statement : clip(c.statement, INVARIANT_CHARS)} _(scope: ${c.scope.join(", ") || "repo"}; ${c.id})_`);
    }
  }
  lines.push("");
  lines.push("_Records carry provenance and confidence; treat low-confidence items as advisory._");
  lines.push(END);
  return lines.join("\n");
}

/** Insert/replace the marker-delimited HUNCH section in a markdown doc, preserving
 *  all user-authored content outside the markers. Shared by CLAUDE.md, AGENTS.md,
 *  and .github/copilot-instructions.md so every assistant gets the same grounding. */
export function upsertSection(file: string, section: string, fallbackTitle: string, opts?: { force?: boolean }): string {
  let content = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!opts?.force) section = preserveNewerTemplate(content, section);
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
export function updateClaudeMd(root: string, store: HunchStore, opts?: { force?: boolean }): string {
  return upsertSection(join(root, "CLAUDE.md"), renderHunchSection(store, root), `# ${basename(root)}`, opts);
}

/** Cut at the last whitespace at or before `max - 1` chars, so a word is never split. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const cut = head.search(/\s\S*$/);
  return `${(cut > 0 ? text.slice(0, cut) : text.slice(0, max - 1)).trimEnd()}…`;
}

function sev(s: string): number {
  return ({ blocking: 3, warning: 2, advisory: 1 } as Record<string, number>)[s] ?? 0;
}
