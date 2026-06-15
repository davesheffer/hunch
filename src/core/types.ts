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

/** ADR-style decision record, auto-drafted and human-confirmable. */
export const DecisionSchema = z.object({
  id: z.string().describe("dec_*"),
  title: z.string(),
  status: z.enum(["proposed", "accepted", "rejected", "superseded"]).default("proposed"),
  context: z.string().default(""),
  decision: z.string().default(""),
  consequences: z.array(z.string()).default([]),
  alternatives_rejected: z.array(z.string()).default([]),
  related_components: z.array(z.string()).default([]),
  related_files: z.array(z.string()).default([]),
  supersedes: z.string().nullable().default(null),
  caused_by_bug: z.string().nullable().default(null),
  commit: z.string().nullable().default(null),
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
  rationale: z.string().default(""),
  source_decision: z.string().nullable().default(null),
  violations: z.array(z.string()).default([]),
  provenance: ProvenanceSchema,
});
export type Constraint = z.infer<typeof ConstraintSchema>;

/** The six entity collections, keyed by their on-disk directory name. */
export const ENTITY_KINDS = ["components", "edges", "symbols", "decisions", "bugs", "constraints"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const SCHEMAS = {
  components: ComponentSchema,
  edges: EdgeSchema,
  symbols: SymbolSchema,
  decisions: DecisionSchema,
  bugs: BugSchema,
  constraints: ConstraintSchema,
} as const;

export type EntityFor = {
  components: Component;
  edges: Edge;
  symbols: Symbol;
  decisions: Decision;
  bugs: Bug;
  constraints: Constraint;
};

/** Default provenance helper for deterministic (extracted) records. */
export function extracted(confidence: number, evidence: string[] = []): Provenance {
  return { source: "extracted", confidence, evidence };
}
export function inferred(confidence: number, evidence: string[] = []): Provenance {
  return { source: "inferred", confidence, evidence };
}
