/**
 * Core entity schema for the Project Hunch (DESIGN.md §3).
 *
 * Zod is the single source of truth: TypeScript types are inferred from the
 * schemas, and the same schemas validate JSON on the write path and shape MCP
 * tool inputs. Every record carries `provenance` so nothing is a blind assertion.
 */
import { z } from "zod";

/** Where a fact came from and how much to trust it. Confidence tiers (DESIGN §4):
 *  inferred < extracted < llm_draft < llm_draft+human_confirmed/derived. */
export const ProvenanceSchema = z.object({
  source: z.string().describe("e.g. extracted | inferred | llm_draft | human_confirmed | test_failure+llm | derived"),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).default([]).describe("file paths, commit ids, test ids backing the claim"),
  last_verified: z.string().optional().describe("ISO timestamp of last re-validation"),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const ComponentKind = z.enum(["service", "module", "layer", "external"]);

/** Architecture node — a service / module / layer / external dependency. */
export const ComponentSchema = z.object({
  id: z.string().describe("cmp_*"),
  kind: ComponentKind,
  name: z.string(),
  responsibility: z.string().default(""),
  paths: z.array(z.string()).default([]).describe("glob(s) the component owns"),
  status: z.enum(["active", "deprecated", "archived"]).default("active"),
  owners: z.array(z.string()).default([]),
  fragility: z.number().min(0).max(1).default(0),
  provenance: ProvenanceSchema,
  created_at: z.string(),
  updated_at: z.string(),
});
export type Component = z.infer<typeof ComponentSchema>;

export const EdgeType = z.enum([
  "depends_on",
  "calls",
  "imports",
  "contains",
  "implements",
  "supersedes",
  "related_to",
]);

/** Typed relationship between components or symbols. */
export const EdgeSchema = z.object({
  id: z.string().describe("edge_*"),
  from: z.string(),
  to: z.string(),
  type: EdgeType,
  reason: z.string().default(""),
  strength: z.number().min(0).max(1).default(0.5),
  provenance: ProvenanceSchema,
});
export type Edge = z.infer<typeof EdgeSchema>;

export const SymbolKind = z.enum(["function", "method", "class", "interface", "type", "variable", "file"]);

export const SymbolMetricsSchema = z.object({
  loc: z.number().default(0),
  churn_90d: z.number().default(0).describe("times changed in last 90 days"),
  bug_count: z.number().default(0),
  fan_in: z.number().default(0).describe("number of callers"),
  fan_out: z.number().default(0).describe("number of callees"),
});
export type SymbolMetrics = z.infer<typeof SymbolMetricsSchema>;

/** File/function-level node for the dependency map. */
export const SymbolSchema = z.object({
  id: z.string().describe("sym_*"),
  file: z.string(),
  name: z.string(),
  kind: SymbolKind,
  signature_hash: z.string().default(""),
  calls: z.array(z.string()).default([]).describe("symbol ids this calls"),
  called_by: z.array(z.string()).default([]).describe("symbol ids that call this"),
  metrics: SymbolMetricsSchema.default({ loc: 0, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 }),
  last_changed: z.string().default("").describe("commit:<sha> or ISO date"),
});
export type Symbol = z.infer<typeof SymbolSchema>;

/** The structural delta a decision's commit DELETED — the evidence the Regression
 *  Guard matches a later diff against ("you're re-adding what dec_X removed"). */
export const RetiredSignalSchema = z.object({
  symbols: z.array(z.string()).default([]).describe("symbol names this decision removed"),
  deps: z.array(z.string()).default([]).describe("external deps this decision dropped"),
});
export type RetiredSignal = z.infer<typeof RetiredSignalSchema>;

/** A machine-checkable signal for a REJECTED alternative (the Veto Guard). Unlike
 *  `retired` (code that once existed and was removed), a rejected alternative never
 *  existed in code, so its prose is turned into a testable set/regex. Carries its
 *  OWN provenance, separate from the decision's: an LLM may DRAFT a tripwire
 *  (advisory only); only a `human_confirmed` tripwire may BLOCK a commit — for every
 *  tier. One predictable rule (dec_a466655539). */
export const RejectedTripwireSchema = z.object({
  alternative: z.string().describe("the rejected approach's human text — printed verbatim in the receipt"),
  scope: z.array(z.string()).default([]).describe("glob(s) it applies to, e.g. vscode-extension/**"),
  forbids: z
    .object({
      deps: z.array(z.string()).default([]).describe("external imports that signal the rejected approach"),
      symbols: z.array(z.string()).default([]).describe("identifier names that signal it"),
      patterns: z.array(z.string()).default([]).describe("scoped line regexes (last resort)"),
    })
    .default({ deps: [], symbols: [], patterns: [] }),
  embed_ref: z.string().optional().describe("optional handle into embeddings for the advisory semantic tier"),
  provenance: ProvenanceSchema,
});
export type RejectedTripwire = z.infer<typeof RejectedTripwireSchema>;

/** ADR-style decision record, auto-drafted and human-confirmable. */
/** Intent-conformance predicate (the "inversion": prove the code still SATISFIES a
 *  decision's intent, not just that a diff didn't touch a guarded file). Each predicate
 *  compiles a decision's intent into a DETERMINISTIC check over the symbol/dependency
 *  graph Hunch already builds — no model. "pay must verify the session" becomes
 *  { assert: "calls", subject: "pay", object: "verifySession" }; if pay stops calling
 *  verifySession the intent is VIOLATED even with no diff in scope. */
export const ConformancePredicateSchema = z.object({
  assert: z.enum(["calls", "not-calls", "imports", "not-imports", "exists"]),
  subject: z.string().describe("symbol name / id / file:name the intent is about"),
  object: z.string().optional().describe("required (calls/imports) or forbidden (not-*) target"),
  transitive: z.boolean().default(false).describe("allow an indirect path over the dependency graph"),
});
export type ConformancePredicate = z.infer<typeof ConformancePredicateSchema>;

export const DecisionSchema = z.object({
  id: z.string().describe("dec_*"),
  title: z.string(),
  // Decision-grounding anchor: the join key that relates a doc section, a decision,
  // and a code region for drift detection. Exactly one topic per decision; null =
  // un-anchored (still valid, just invisible to doc≠graph detection until tagged —
  // honest and bounded). Optional-with-default, so every legacy record validates with
  // no migration (Zod fills null on read); grounding freshness reuses the existing
  // valid-time / last_verified signals rather than a separate clock.
  topic: z.string().nullable().default(null).describe("decision-grounding anchor; one topic per decision, null = un-anchored"),
  status: z.enum(["proposed", "accepted", "rejected", "superseded"]).default("proposed"),
  context: z.string().default(""),
  decision: z.string().default(""),
  consequences: z.array(z.string()).default([]),
  alternatives_rejected: z.array(z.string()).default([]),
  rejected_tripwires: z.array(RejectedTripwireSchema).default([]).describe("machine-checkable signals for alternatives_rejected (Veto Guard)"),
  related_components: z.array(z.string()).default([]),
  related_files: z.array(z.string()).default([]),
  supersedes: z.string().nullable().default(null),
  superseded_by: z.string().nullable().default(null).describe("the decision that closed this one's window"),
  caused_by_bug: z.string().nullable().default(null),
  commit: z.string().nullable().default(null),
  // Bi-temporal VALID-TIME window, git-anchored. `valid_from` is when the decision
  // took effect (its commit date); `valid_to` is when a superseding decision closed
  // it (null = still in force). Enables "what did we believe as of commit X?".
  // Optional so legacy/hand-built records still validate (the migration backfills
  // from `date`, and the capture paths always set it); undefined = always-started.
  valid_from: z.string().optional().describe("ISO instant the decision took effect (commit date)"),
  valid_to: z.string().nullable().default(null).describe("ISO instant it was superseded (null = in force)"),
  retired: RetiredSignalSchema.default({ symbols: [], deps: [] }),
  conformance: z.array(ConformancePredicateSchema).optional().describe("deterministic intent-conformance checks over the graph"),
  provenance: ProvenanceSchema,
  date: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const BugLineageSchema = z.object({
  introduced_commit: z.string().nullable().default(null),
  detected: z.string().nullable().default(null).describe("test id or report"),
  fixed_commit: z.string().nullable().default(null),
  recurrence_of: z.string().nullable().default(null).describe("bug id this recurs"),
  spawned_decision: z.string().nullable().default(null),
  spawned_constraint: z.string().nullable().default(null),
});
export type BugLineage = z.infer<typeof BugLineageSchema>;

/** A bug with root cause and lineage (introduced → fixed → recurred). */
export const BugSchema = z.object({
  id: z.string().describe("bug_*"),
  title: z.string(),
  symptom: z.string().default(""),
  root_cause: z.string().default(""),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  status: z.enum(["open", "investigating", "fixed", "regressed"]).default("open"),
  affected_files: z.array(z.string()).default([]),
  affected_symbols: z.array(z.string()).default([]),
  lineage: BugLineageSchema.default({
    introduced_commit: null, detected: null, fixed_commit: null,
    recurrence_of: null, spawned_decision: null, spawned_constraint: null,
  }),
  provenance: ProvenanceSchema,
});
export type Bug = z.infer<typeof BugSchema>;

/** An invariant the system must respect. */
export const ConstraintSchema = z.object({
  id: z.string().describe("con_*"),
  type: z.enum(["security", "performance", "correctness", "architecture", "compliance"]).default("correctness"),
  statement: z.string(),
  scope: z.array(z.string()).default([]).describe("glob(s) it applies to"),
  severity: z.enum(["advisory", "warning", "blocking"]).default("warning"),
  enforcement: z.enum(["advisory_v1", "ci", "manual"]).default("advisory_v1"),
  // Optional CONTENT matcher (regex): the gate blocks when an ADDED line matches it,
  // instead of on bare scope-touch. A content-verifiable invariant is decided per
  // commit, so it is immune to file-change "staleness" and keeps its teeth across the
  // file's whole life — and stays quiet on edits that don't break it (dec_e0a36efbf5).
  // Legacy textual tier; prefer `forbids` below, which is parsed-import precise.
  match: z.string().nullable().default(null),
  // Precise content matcher (same ladder as a veto tripwire): a violation is a forbidden
  // dep IMPORTED, symbol added, or pattern matched in scoped code. The dep tier is parsed
  // from the import set, so comments/strings naming the module can't false-positive. Like
  // `match`, a forbids-matched invariant is staleness-immune.
  forbids: z
    .object({
      deps: z.array(z.string()).default([]),
      symbols: z.array(z.string()).default([]),
      patterns: z.array(z.string()).default([]),
    })
    .nullable()
    .default(null),
  rationale: z.string().default(""),
  source_decision: z.string().nullable().default(null),
  violations: z.array(z.string()).default([]),
  // Bi-temporal VALID-TIME: a constraint can be RETIRED without deletion, so
  // "what invariants were in force as of commit X?" stays answerable. `valid_to`
  // null = still active. A retired constraint is excluded from enforcement at HEAD.
  status: z.enum(["active", "retired"]).default("active"),
  valid_from: z.string().optional().describe("ISO instant the invariant took effect"),
  valid_to: z.string().nullable().default(null).describe("ISO instant it was retired (null = active)"),
  provenance: ProvenanceSchema,
});
export type Constraint = z.infer<typeof ConstraintSchema>;

/** A reusable "how" for a recurring task — trajectory/runbook memory (roadmap #5).
 *  ADVISORY retrieval context only; never enters any block path. Distilled from a
 *  commit range, surfaced through the same FTS+graph retrieval as every record. */
export const RunbookSchema = z.object({
  id: z.string().describe("rb_*"),
  task: z.string().describe("the recurring task this answers"),
  trigger: z.array(z.string()).default([]).describe("phrases/intents that should surface it"),
  steps: z.array(z.string()).default([]).describe("ordered procedure"),
  files: z.array(z.string()).default([]).describe("canonical files the task touches (drift-checkable)"),
  gotchas: z.array(z.string()).default([]),
  outcome: z.string().default("").describe("what 'done' looks like"),
  source_range: z.string().nullable().default(null).describe("the commit range it was distilled from"),
  valid_from: z.string().optional(),
  valid_to: z.string().nullable().default(null),
  provenance: ProvenanceSchema,
  date: z.string(),
});
export type Runbook = z.infer<typeof RunbookSchema>;

/** The entity collections, keyed by their on-disk directory name. */
export const ENTITY_KINDS = ["components", "edges", "symbols", "decisions", "bugs", "constraints", "runbooks"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const SCHEMAS = {
  components: ComponentSchema,
  edges: EdgeSchema,
  symbols: SymbolSchema,
  decisions: DecisionSchema,
  bugs: BugSchema,
  constraints: ConstraintSchema,
  runbooks: RunbookSchema,
} as const;

export type EntityFor = {
  components: Component;
  edges: Edge;
  symbols: Symbol;
  decisions: Decision;
  bugs: Bug;
  constraints: Constraint;
  runbooks: Runbook;
};

/** Default provenance helper for deterministic (extracted) records. */
export function extracted(confidence: number, evidence: string[] = []): Provenance {
  return { source: "extracted", confidence, evidence };
}
export function inferred(confidence: number, evidence: string[] = []): Provenance {
  return { source: "inferred", confidence, evidence };
}
