/**
 * Auto-maintained CLAUDE.md (DESIGN.md §7, integration layer 2: "ambient
 * context loaded every session for free"). We own ONLY the region between the
 * HUNCH markers — any user-authored content outside it is preserved verbatim.
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { writeFileAtomic } from "../core/io.js";
import { basename, join, dirname } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import { PolicyRepository } from "../constitution/repository.js";
import { renderCountsMatch, parseGroundingCounts, groundingTemplate } from "../core/groundingLag.js";

const START = "<!-- HUNCH:START — auto-generated, do not edit by hand -->";
const END = "<!-- HUNCH:END -->";

/** Version of the block's PROSE. Bump it whenever renderHunchSection's wording
 *  changes. A block without the stamp is template 1. */
export const GROUNDING_TEMPLATE = 3;
/** The pre-edit hook injects each in-scope invariant in full; the always-loaded
 *  list only has to name it (fnd_a65f71f38f, #369), so its statement is cut at a
 *  word boundary within this many chars. */
const INVARIANT_CHARS = 120;
/** Blocking invariants named in the block; the rest are counted, not listed. */
const INVARIANT_LIMIT = 6;

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
  const rendered = new Set(section.split(/\r?\n/).map(invariantId).filter(Boolean));
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const lines = current.split(/\r?\n/).filter((line) => {
    const id = invariantId(line);
    return !id || rendered.has(id);
  });
  // A heading left with no invariants under it goes too.
  const h = lines.findIndex((line) => INVARIANT_HEADINGS.some((head) => line.startsWith(head)));
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

/** Never begins "### ⛔ Top invariants": a template-2 renderer (still installed
 *  globally, run by post-commit hooks) strips a heading by that prefix when none
 *  of its invariant lines follow, which would orphan these `- con_x: …` lines. */
const INVARIANTS_HEADING = "### ⛔ Blocking invariants";
/** The headings this and older templates wrote, for preserveNewerTemplate. */
const INVARIANT_HEADINGS = [INVARIANTS_HEADING, "### ⛔ Top invariants"];
/** A Top-invariants line, as this template (`- con_x: …`) or template 2
 *  (`- **[sev]** … _(scope: …; con_x)_`) wrote it; the id is group 1 or 2. */
const INVARIANT_LINE_RE = /^- (?:(con_[A-Za-z0-9_]+): |\*\*\[[a-z]+\]\*\* .*; (con_[A-Za-z0-9_]+)\)_\r?$)/;
const invariantId = (line: string): string | undefined => {
  const m = INVARIANT_LINE_RE.exec(line);
  return m?.[1] ?? m?.[2];
};

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
  const live = store.json
    .loadAll("constraints")
    .filter((c) => c.status === "active" && !c.valid_to && c.severity === "blocking")
    .sort((a, b) => a.id.localeCompare(b.id));
  const constraints = live.slice(0, INVARIANT_LIMIT);
  const counts = {
    decisions: store.json.loadAll("decisions").length,
    bugs: store.json.loadAll("bugs").length,
    constraints: store.json.loadAll("constraints").length,
    components: store.json.loadAll("components").length,
    policies: root ? new PolicyRepository(root, store).listPolicies({ publicOnly: true }).length : 0,
    findings: store.json.loadAll("findings").filter((f) => f.triage === "open" || f.triage === "accepted-risk" || f.triage === "scheduled").length,
  };

  // Always loaded, so it only has to route: the per-moment tool
  // list lives in the hunch_context tool description, the finish rule in the MCP
  // instructions and the prompt hook, and each in-scope invariant reaches the
  // pre-edit hook in full. Here a blocking invariant only has to be named.
  const lines: string[] = [];
  lines.push(START);
  lines.push(`<!-- hunch:template ${GROUNDING_TEMPLATE} -->`);
  lines.push("## 🧠 Hunch (Engineering Memory)");
  lines.push("");
  lines.push(`This repo's Hunch graph holds ${renderCountsMatch(counts)}. Use a task-linked prompt-hook brief as this task's initial context; otherwise call \`hunch_context(target)\` first, before reading or editing. New files alone do not require another brief; check constraints before editing uncovered scope. Its tool description lists the rest.`);
  if (constraints.length) {
    lines.push("");
    lines.push(INVARIANTS_HEADING);
    for (const c of constraints) lines.push(`- ${c.id}: ${clip(c.statement, INVARIANT_CHARS)}`);
    if (live.length > constraints.length) lines.push(`- …and ${live.length - constraints.length} more: \`hunch_check_constraints(scope)\``);
  }
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
