/**
 * Auto-maintained CLAUDE.md (DESIGN.md §7, integration layer 2: "ambient
 * context loaded every session for free"). We own ONLY the region between the
 * BRAIN markers — any user-authored content outside it is preserved verbatim.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { BrainStore } from "../store/brainStore.js";

const START = "<!-- BRAIN:START — auto-generated, do not edit by hand -->";
const END = "<!-- BRAIN:END -->";

export function renderBrainSection(store: BrainStore): string {
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
  lines.push("## 🧠 Project Brain (Engineering Memory)");
  lines.push("");
  lines.push(
    "This repo has a **Project Brain** — a curated graph of *why* the code is the way it is " +
      "(decisions, bug history, invariants). It currently holds " +
      `**${counts.decisions} decisions, ${counts.bugs} bugs, ${counts.constraints} constraints, ${counts.components} components**.`,
  );
  lines.push("");
  lines.push("**Before reasoning about or editing this codebase, consult the Brain via the `brain` MCP tools:**");
  lines.push("- `brain_why(target)` — why a file/symbol is shaped this way (decisions, bugs, constraints).");
  lines.push("- `brain_check_constraints(scope)` — invariants you must not break. **Always run before editing.**");
  lines.push("- `brain_get_dependents(symbol)` — blast radius before a change.");
  lines.push("- `brain_bug_lineage(symptom)` — has this bug happened before? what was the root cause?");
  lines.push("- `brain_query(question)` — free-text search across the whole Brain.");
  lines.push("- `brain_record_decision(...)` — write back a decision after a non-trivial choice.");
  if (constraints.length) {
    lines.push("");
    lines.push("### ⛔ Top invariants (do not break)");
    for (const c of constraints) {
      lines.push(`- **[${c.severity}]** ${c.statement} _(scope: ${c.scope.join(", ") || "repo"}; ${c.id})_`);
    }
  }
  lines.push("");
  lines.push("_The Brain updates itself from commits and test failures. Records carry provenance + confidence; treat low-confidence items as advisory._");
  lines.push(END);
  return lines.join("\n");
}

/** Insert/replace the BRAIN section in CLAUDE.md, preserving everything else. */
export function updateClaudeMd(root: string, store: BrainStore): string {
  const file = join(root, "CLAUDE.md");
  const section = renderBrainSection(store);
  let content = existsSync(file) ? readFileSync(file, "utf8") : "";

  const iStart = content.indexOf(START);
  const iEnd = content.indexOf(END);
  if (iStart >= 0 && iEnd > iStart) {
    // clean both-marker case: replace in place, preserving surrounding content
    content = content.slice(0, iStart) + section + content.slice(iEnd + END.length);
  } else if (iStart >= 0 || iEnd >= 0) {
    // partial/corrupt markers (only one survived, or out of order): strip every
    // stray marker line, then append ONE clean section — never duplicate.
    const body = content.split("\n").filter((l) => !l.includes(START) && !l.includes(END)).join("\n").trimEnd();
    content = body ? `${body}\n\n${section}\n` : `${section}\n`;
  } else if (content.trim()) {
    content = `${content.trimEnd()}\n\n${section}\n`;
  } else {
    content = `# ${root.split("/").pop()}\n\n${section}\n`;
  }
  writeFileSync(file, content);
  return file;
}

function sev(s: string): number {
  return ({ blocking: 3, warning: 2, advisory: 1 } as Record<string, number>)[s] ?? 0;
}
