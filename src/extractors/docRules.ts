/**
 * Doc-derived rules: an author marks an invariant right where it is written in
 * prose (CONTRIBUTING.md, AGENTS.md, a policy doc) and Hunch lifts it into a
 * Constraint, deterministically — the markdown sibling of `hunch-rule:` comments.
 *
 *   <!-- hunch:rule scope=src/ui/** severity=blocking id=ui-no-billing -->
 *   UI code must never import the billing client directly.
 *
 * The paragraph after the marker is the statement. The doc is the rule's SOURCE,
 * not its authority: once imported, the graph owns the rule and the doc path +
 * hash ride along as provenance only. So a moved doc never breaks the rule (with
 * an explicit `id=` the constraint id is path-independent), a changed paragraph
 * is surfaced for review instead of silently rewriting the graph, and a removed
 * marker is surfaced as orphaned instead of silently retiring the rule.
 */
import { createHash } from "node:crypto";
import type { Constraint } from "../core/types.js";
import { constraintId } from "../core/ids.js";
import { markdownExampleRanges } from "../core/docanchors.js";
import { normalizeEol } from "../core/eol.js";

const MARKER = /<!--\s*hunch:rule\b([^>]*?)-->/g;
const ATTR = /([a-z]+)=("[^"]*"|\S+)/g;
const SEVERITIES = ["advisory", "warning", "blocking"] as const;
const TYPES = ["security", "performance", "correctness", "architecture", "compliance"] as const;
const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/** Provenance source token marking a constraint as doc-derived (free-form source string). */
export const DOC_RULE_SOURCE = "human_confirmed+imported:doc-rule";
const HASH_PREFIX = "doc-rule-hash:";
const DOC_PREFIX = "doc-rule-source:";
const KEY_PREFIX = "doc-rule-key:";

export interface DocRule {
  /** repo-relative POSIX path of the doc */
  file: string;
  /** 1-based line of the marker */
  line: number;
  /** explicit `id=` key, or null when the id derives from path + statement */
  key: string | null;
  statement: string;
  scope: string[];
  severity: Constraint["severity"];
  type: Constraint["type"];
}

export interface DocRuleIssue {
  file: string;
  line: number;
  detail: string;
}

/** Parse every hunch:rule marker in one markdown document. Markers inside code
 *  blocks or inline code spans are examples and are skipped. A malformed marker
 *  is reported, never guessed at. */
export function parseDocRules(raw: string, file: string): { rules: DocRule[]; issues: DocRuleIssue[] } {
  const text = normalizeEol(raw).replace(/^﻿/, "");
  const { ranges: skip, unclosed } = markdownExampleRanges(text);
  const rules: DocRule[] = [];
  const issues: DocRuleIssue[] = [];
  MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  let hidden = 0;
  while ((m = MARKER.exec(text))) {
    const at = m.index;
    if (unclosed && at > unclosed.start) hidden++;
    if (skip.some(([s, e]) => at >= s && at <= e)) continue;
    const line = text.slice(0, at).split("\n").length;
    const issue = (detail: string) => issues.push({ file, line, detail });
    const attrs = new Map<string, string>();
    ATTR.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = ATTR.exec(m[1]!))) attrs.set(a[1]!.toLowerCase(), a[2]!.replace(/^"|"$/g, ""));
    const unknown = [...attrs.keys()].filter((k) => !["scope", "severity", "type", "id"].includes(k));
    if (unknown.length) { issue(`unknown attribute(s): ${unknown.join(", ")}`); continue; }
    const scope = (attrs.get("scope") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    // No implicit repo-wide default: a doc rule names what it governs.
    if (!scope.length) { issue("missing scope=<glob>[,<glob>]"); continue; }
    const severity = attrs.get("severity") ?? "warning";
    if (!(SEVERITIES as readonly string[]).includes(severity)) { issue(`severity must be one of ${SEVERITIES.join("|")}`); continue; }
    const type = attrs.get("type") ?? "correctness";
    if (!(TYPES as readonly string[]).includes(type)) { issue(`type must be one of ${TYPES.join("|")}`); continue; }
    const key = attrs.get("id") ?? null;
    if (key !== null && !KEY.test(key)) { issue("id must be 1-64 chars of [A-Za-z0-9._-]"); continue; }
    const statement = paragraphAfter(text, at + m[0].length);
    if (!statement) { issue("no paragraph follows the marker"); continue; }
    if (statement.startsWith("<")) { issue("statement looks like raw HTML"); continue; }
    rules.push({ file, line, key, statement, scope, severity: severity as DocRule["severity"], type: type as DocRule["type"] });
  }
  if (unclosed && hidden) issues.push({ file, line: unclosed.line, detail: `unclosed code fence hides ${hidden} hunch:rule marker(s) below it` });
  return { rules, issues };
}

/** The doc with every marked rule (marker + its paragraph) blanked out, so an LLM
 *  proposal pass only reads prose no marker already covers. Line count is kept. */
export function withoutMarkedRules(raw: string, file: string): string {
  const text = normalizeEol(raw).replace(/^﻿/, "");
  const lines = text.split("\n");
  for (const rule of parseDocRules(text, file).rules) {
    let i = rule.line - 1;
    const inline = !!markerRemainder(lines[i]!.slice(lines[i]!.indexOf("-->", lines[i]!.indexOf("hunch:rule")) + 3));
    lines[i] = "";
    i++;
    // Same paragraph boundary as paragraphAfter: blank lines are skipped only when
    // the statement did not start on the marker's own line.
    if (!inline) while (i < lines.length && !unquote(lines[i]!)) i++;
    for (; i < lines.length; i++) {
      const l = unquote(lines[i]!);
      if (!l || /^#{1,6}\s/.test(l) || /^<!--\s*hunch:/.test(l)) break;
      lines[i] = "";
    }
  }
  return lines.join("\n");
}

/** A line without its leading blockquote `>` run (`> `, `>> `). */
const unquote = (line: string): string => line.trim().replace(/^(?:>\s*)+/, "");

/** What is left of the marker's own line, up to the next hunch marker. */
const markerRemainder = (rest: string): string => rest.replace(/<!--\s*hunch:[\s\S]*$/, "").trim();

/** The paragraph a marker governs: any text left on the marker's own line (up to
 *  the next hunch marker), then following lines up to a blank line, heading, or
 *  another hunch marker. Blockquote `>` prefixes and a leading list bullet are
 *  dropped; whitespace collapses to single spaces. */
function paragraphAfter(text: string, from: number): string {
  const lines = text.slice(from).split("\n");
  const out: string[] = [];
  const first = markerRemainder(lines[0]!);
  if (first) out.push(first);
  let i = 1;
  if (!out.length) while (i < lines.length && !unquote(lines[i]!)) i++;
  for (; i < lines.length; i++) {
    const l = unquote(lines[i]!);
    if (!l || /^#{1,6}\s/.test(l) || /^<!--\s*hunch:/.test(l)) break;
    out.push(l);
  }
  return out.join(" ").replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim();
}

/** Path-independent with an explicit key (survives moves and rewording);
 *  otherwise path + statement. */
export function docRuleId(rule: DocRule): string {
  return constraintId(rule.key ? `doc-rule:${rule.key}` : `doc-rule:${rule.file}:${rule.statement}`);
}

/** Hash of the rule's MEANING (not its location), so a move is not a change. */
export function docRuleHash(rule: DocRule): string {
  const canonical = JSON.stringify({ statement: rule.statement, scope: rule.scope, severity: rule.severity, type: rule.type });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function isDocRuleConstraint(c: Constraint): boolean {
  return c.provenance.source.split("+").includes("imported:doc-rule");
}

/** The doc hash recorded when the constraint was imported (or last accepted). */
export function recordedDocRuleHash(c: Constraint): string | null {
  return c.provenance.evidence.find((e) => e.startsWith(HASH_PREFIX))?.slice(HASH_PREFIX.length) ?? null;
}

export function recordedDocRuleSource(c: Constraint): string | null {
  return c.provenance.evidence.find((e) => e.startsWith(DOC_PREFIX))?.slice(DOC_PREFIX.length) ?? null;
}

/** The explicit `id=` key recorded at import; null for an implicit (path + statement) id. */
export function recordedDocRuleKey(c: Constraint): string | null {
  return c.provenance.evidence.find((e) => e.startsWith(KEY_PREFIX))?.slice(KEY_PREFIX.length) ?? null;
}

export function docRuleToConstraint(rule: DocRule, prev: Constraint | undefined, now: string): Constraint {
  return {
    id: docRuleId(rule), type: rule.type, statement: rule.statement, scope: rule.scope,
    severity: rule.severity, enforcement: "advisory_v1", match: null, forbids: null,
    rationale: `Derived from a hunch:rule marker in ${rule.file}:${rule.line}. The graph owns this rule; the doc is its source.`,
    source_decision: null, violations: prev?.violations ?? [], status: "active",
    valid_from: prev?.valid_from ?? now, valid_to: null,
    provenance: {
      source: DOC_RULE_SOURCE, confidence: 0.9,
      evidence: [`${rule.file}:${rule.line}`, `${DOC_PREFIX}${rule.file}`, `${HASH_PREFIX}${docRuleHash(rule)}`, ...(rule.key ? [`${KEY_PREFIX}${rule.key}`] : [])],
    },
  };
}

export interface DocRulePlan {
  /** marker with no constraint yet → write */
  create: Array<{ rule: DocRule; next: Constraint }>;
  /** key-less new rule while a key-less rule vanished from the same doc: probably an
   *  edited paragraph, not a new rule → written only with --accept-changes */
  held: Array<{ rule: DocRule; next: Constraint }>;
  /** same meaning, doc moved/line shifted → provenance-only refresh */
  moved: Array<{ rule: DocRule; next: Constraint; from: string | null }>;
  /** paragraph/attrs edited since import → needs explicit acceptance */
  changed: Array<{ rule: DocRule; next: Constraint; prev: Constraint }>;
  /** marker removed from (or its doc gone from) a covered path → surface, never auto-retire */
  orphaned: Constraint[];
  /** id clashes with a constraint that did not come from a doc, or lives in the other home */
  conflicts: Array<{ rule: DocRule; existing: Constraint | null; reason: string }>;
  unchanged: DocRule[];
  issues: DocRuleIssue[];
}

/** Compare parsed markers against the constraints already in the target home.
 *  Pure: decides, never writes. `covers` bounds orphan detection to the scanned
 *  path, so scanning one file never orphans rules sourced from another; a doc that
 *  was deleted or renamed is still covered by its old path. `otherHomeIds` are ids
 *  held by the other memory home (a write there would create a public/private twin). */
export function planDocRules(
  parsed: { rules: DocRule[]; issues: DocRuleIssue[] },
  existing: readonly Constraint[],
  covers: (sourceDoc: string) => boolean,
  otherHomeIds: ReadonlySet<string>,
  now: string,
): DocRulePlan {
  const plan: DocRulePlan = { create: [], held: [], moved: [], changed: [], orphaned: [], conflicts: [], unchanged: [], issues: [...parsed.issues] };
  const byId = new Map(existing.map((c) => [c.id, c]));
  const seen = new Map<string, DocRule>();
  for (const rule of parsed.rules) {
    const id = docRuleId(rule);
    const dup = seen.get(id);
    if (dup) {
      plan.issues.push({ file: rule.file, line: rule.line, detail: `duplicate rule — same id as ${dup.file}:${dup.line}${rule.key ? ` (id=${rule.key})` : ""}` });
      continue;
    }
    seen.set(id, rule);
    const prev = byId.get(id);
    if (!prev && otherHomeIds.has(id)) {
      plan.conflicts.push({ rule, existing: null, reason: `id ${id} already exists in the other memory home; pick a different id=` });
      continue;
    }
    // A non-doc constraint of ANY status owns its id; only a doc rule can "stay retired".
    if (prev && !isDocRuleConstraint(prev)) {
      plan.conflicts.push({ rule, existing: prev, reason: `id collides with non-doc constraint ${prev.id}; pick a different id=` });
      continue;
    }
    if (!prev) { plan.create.push({ rule, next: docRuleToConstraint(rule, undefined, now) }); continue; }
    // A retired doc rule whose marker is still present stays retired: the graph
    // decided; re-running derive must not resurrect it.
    if (prev.status === "retired") { plan.unchanged.push(rule); continue; }
    const fresh = docRuleToConstraint(rule, prev, now);
    if (recordedDocRuleHash(prev) !== docRuleHash(rule)) {
      // Only the doc-owned fields move; enforcement, match, forbids, source_decision,
      // violations and valid_from are graph-side and survive an accepted edit.
      const { statement, scope, severity, type, rationale, provenance } = fresh;
      plan.changed.push({ rule, prev, next: { ...prev, statement, scope, severity, type, rationale, provenance, status: "active", valid_to: null } });
    } else if (!prev.provenance.evidence.includes(`${rule.file}:${rule.line}`)) {
      // Location-only refresh: keep every graph-side edit (severity raised by a
      // reviewer, violations) — only the provenance pointer moves.
      const evidence = fresh.provenance.evidence.filter((e) => !e.startsWith(HASH_PREFIX)).concat(
        prev.provenance.evidence.filter((e) => e.startsWith(HASH_PREFIX)),
      );
      plan.moved.push({ rule, next: { ...prev, provenance: { ...prev.provenance, evidence } }, from: recordedDocRuleSource(prev) });
    } else {
      plan.unchanged.push(rule);
    }
  }
  for (const c of existing) {
    if (c.status !== "active" || !isDocRuleConstraint(c) || seen.has(c.id)) continue;
    const src = recordedDocRuleSource(c);
    if (src && covers(src)) plan.orphaned.push(c);
  }
  // An implicit id derives from path + statement, so an edited key-less paragraph
  // reads as "new rule + vanished rule". Hold such creations for explicit acceptance.
  const editedDocs = new Set(plan.orphaned.filter((c) => !recordedDocRuleKey(c)).map((c) => recordedDocRuleSource(c)!));
  if (editedDocs.size) {
    const held = plan.create.filter((x) => !x.rule.key && editedDocs.has(x.rule.file));
    plan.create = plan.create.filter((x) => !held.includes(x));
    plan.held = held;
  }
  return plan;
}

/** True when the doc and graph disagree in a way a human must settle. A move
 *  (line shift, renamed doc) is provenance-only and never dirties a CI check. */
export function docRulePlanIsDirty(plan: DocRulePlan): boolean {
  return !!(plan.create.length || plan.held.length || plan.changed.length || plan.orphaned.length || plan.conflicts.length || plan.issues.length);
}
