/**
 * Auto-maintained CLAUDE.md (DESIGN.md §7, integration layer 2: "ambient
 * context loaded every session for free"). We own ONLY the region between the
 * HUNCH markers — any user-authored content outside it is preserved verbatim.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import { wikiSummary } from "../wiki/wiki.js";

const START = "<!-- HUNCH:START — auto-generated, do not edit by hand -->";
const END = "<!-- HUNCH:END -->";

export function renderHunchSection(store: HunchStore, root?: string): string {
  const constraints = store.json
    .loadAll("constraints")
    .sort((a, b) => sev(b.severity) - sev(a.severity))
    .slice(0, 8);
  const counts = {
    decisions: store.json.loadAll("decisions").length,
    bugs: store.json.loadAll("bugs").length,
    constraints: store.json.loadAll("constraints").length,
    components: store.json.loadAll("components").length,
  };

  const lines: string[] = [];
  lines.push(START);
  lines.push("## 🧠 Hunch (Engineering Memory)");
  lines.push("");
  lines.push(
    "This repo has **Hunch** — a curated graph of *why* the code is the way it is " +
      "(decisions, bug history, invariants). It currently holds " +
      `**${counts.decisions} decisions, ${counts.bugs} bugs, ${counts.constraints} constraints, ${counts.components} components**.`,
  );
  lines.push("");
  lines.push("**Before reasoning about or editing this codebase, consult Hunch via the `hunch_*` MCP tools:**");
  lines.push("- `hunch_why(target)` — why a file/symbol is shaped this way (decisions, bugs, constraints).");
  lines.push("- `hunch_check_constraints(scope)` — invariants you must not break. **Always run before editing.**");
  lines.push("- `hunch_get_dependents(symbol)` — blast radius before a change.");
  lines.push("- `hunch_bug_lineage(symptom_or_symbol)` — has this bug happened before? what was the root cause?");
  lines.push("- `hunch_query(query)` — free-text search across all of Hunch.");
  lines.push("- `hunch_runbook(task)` — the proven steps for a recurring task (e.g. \"add an MCP tool\", \"cut a release\").");
  lines.push("- `hunch_compare(candidates)` — rank N candidate branches/commits by architectural fit (fewest invariant hits).");
  lines.push("- `hunch_conformance()` — does the code still SATISFY recorded intent? (e.g. `pay` still reaches `verifySession`). Run before a refactor.");
  lines.push("- `hunch_record_decision(...)` — write back a decision after a non-trivial choice.");
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
  writeFileSync(file, content);
  return file;
}

/** Insert/replace the HUNCH section in CLAUDE.md, preserving everything else. */
export function updateClaudeMd(root: string, store: HunchStore): string {
  return upsertSection(join(root, "CLAUDE.md"), renderHunchSection(store, root), `# ${root.split("/").pop()}`);
}

function sev(s: string): number {
  return ({ blocking: 3, warning: 2, advisory: 1 } as Record<string, number>)[s] ?? 0;
}
