/**
 * Core entity schema for the Project Hunch (DESIGN.md §3).
 *
 * Zod is the single source of truth: TypeScript types are inferred from the
 * schemas, and the same schemas validate JSON on the write path and shape MCP
 * tool inputs. Every record carries `provenance` so nothing is a blind assertion.
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { findingId, resourceId, resourceRelationshipId } from "./ids.js";
import { ProvenanceSchema, SENSITIVE_METADATA_KEY, isCredentialFreeText, type Provenance } from "./provenance.js";
import {
  ActionReceiptSchema, CommitmentSchema, DerivedStateSchema, ExternalEntitySchema, StateRelationshipSchema,
  type ActionReceipt, type Commitment, type DerivedState, type ExternalEntity, type StateRelationship,
} from "./stateRecords.js";

// Provenance and the credential-free text check live in the leaf module ./provenance.js so
// record schemas registered below can import them without a cycle; re-exported unchanged.
export { ProvenanceSchema, isCredentialFreeText };
export type { Provenance };

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

export const RESOURCE_SCHEMA_VERSION = "hunch.resource/1" as const;
export const RESOURCE_RELATIONSHIP_SCHEMA_VERSION = "hunch.resource-relationship/1" as const;

/** Resource kinds are deliberately extensible: the initial vocabulary is
 * documented, while repositories may add a stable snake_case kind without a
 * schema release. */
export const ResourceKindSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const ResourceCurrentnessSchema = z.object({
  status: z.enum(["current", "unverified", "stale"]),
  verified_at: z.string().max(64).optional().describe("ISO timestamp at which the declaration was checked"),
  source_revision: z.string().min(1).max(512).optional().describe("immutable source/Git revision backing the declaration"),
  source_content_hash: z.string().min(1).max(512).optional().describe("content hash when revision alone is insufficient"),
}).strict().superRefine((currentness, ctx) => {
  if (currentness.verified_at !== undefined && !Number.isFinite(Date.parse(currentness.verified_at))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["verified_at"], message: "resource currentness timestamp must be ISO-compatible" });
  }
  if (currentness.status !== "unverified"
    && (!currentness.verified_at || (!currentness.source_revision && !currentness.source_content_hash))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "current or stale resource evidence requires a verification timestamp and source revision or content hash",
    });
  }
});
export type ResourceCurrentness = z.infer<typeof ResourceCurrentnessSchema>;

const MetadataValueSchema = z.union([
  z.string().max(1024),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(1024), z.number().finite(), z.boolean(), z.null()])).max(32),
]);

function isCanonicalResourceIdentity(value: string): boolean {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return false;
  const kind = value.slice(0, separator);
  const naturalKey = value.slice(separator + 1);
  return ResourceKindSchema.safeParse(kind).success && value === resourceId(kind, naturalKey);
}

export const ResourceMetadataSchema = z.record(z.string().min(1).max(64), MetadataValueSchema)
  .superRefine((metadata, ctx) => {
    if (Object.keys(metadata).length > 64) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "resource metadata is limited to 64 fields" });
    }
    for (const [key, raw] of Object.entries(metadata)) {
      if (SENSITIVE_METADATA_KEY.test(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "credential-bearing metadata keys are forbidden" });
        continue;
      }
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) {
        if (typeof value === "string" && !isCredentialFreeText(value)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "credential material is forbidden in resource metadata" });
          break;
        }
      }
    }
  });
export type ResourceMetadata = z.infer<typeof ResourceMetadataSchema>;

/** Durable Engineering Landscape node. Runtime health/readiness intentionally has
 * no field here: those expiring observations belong to ORC. */
export const ResourceSchema = z.object({
  schema: z.literal(RESOURCE_SCHEMA_VERSION),
  id: z.string().min(3).max(2048).describe("stable kind-qualified resource identity"),
  kind: ResourceKindSchema,
  name: z.string().min(1).max(256),
  scope: z.array(z.string().min(1).max(512)).max(16).default([]),
  locator: z.string().min(1).max(2048).nullable().default(null),
  lifecycle: z.enum(["planned", "active", "deprecated", "retired"]).default("active"),
  criticality: z.enum(["low", "medium", "high", "critical"]).optional(),
  contract_version: z.string().max(256).optional(),
  provenance: ProvenanceSchema,
  currentness: ResourceCurrentnessSchema,
  metadata: ResourceMetadataSchema.default({}),
  created_at: z.string(),
  updated_at: z.string(),
}).strict().superRefine((resource, ctx) => {
  const prefix = `${resource.kind}:`;
  const naturalKey = resource.id.startsWith(prefix) ? resource.id.slice(prefix.length) : "";
  if (!naturalKey.trim() || resource.id !== resourceId(resource.kind, naturalKey)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "resource id must be a canonical kind-qualified identity" });
  }
  const credentialFreeFields: Array<[string | number, string]> = [
    ["id", resource.id],
    ["name", resource.name],
    ...resource.scope.map((scope, index) => [`scope.${index}`, scope] as [string, string]),
    ...(resource.locator === null ? [] : [["locator", resource.locator] as [string, string]]),
    ...(resource.contract_version === undefined ? [] : [["contract_version", resource.contract_version] as [string, string]]),
    ["provenance.source", resource.provenance.source],
    ...resource.provenance.evidence.map((evidence, index) => [`provenance.evidence.${index}`, evidence] as [string, string]),
    ...(resource.currentness.source_revision === undefined
      ? []
      : [["currentness.source_revision", resource.currentness.source_revision] as [string, string]]),
    ...(resource.currentness.source_content_hash === undefined
      ? []
      : [["currentness.source_content_hash", resource.currentness.source_content_hash] as [string, string]]),
  ];
  for (const [field, value] of credentialFreeFields) {
    if (!isCredentialFreeText(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: String(field).split("."), message: "credential material is forbidden in resource records" });
    }
  }
  if (new Set(resource.scope).size !== resource.scope.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scope"], message: "resource scope entries must be unique" });
  }
  if (resource.provenance.source.length > 256 || resource.provenance.evidence.length > 64
    || resource.provenance.evidence.some((evidence) => evidence.length > 2048)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance"], message: "resource provenance must remain bounded" });
  }
  if (resource.created_at.length > 64 || !Number.isFinite(Date.parse(resource.created_at))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["created_at"], message: "resource created_at must be ISO-compatible" });
  }
  if (resource.updated_at.length > 64 || !Number.isFinite(Date.parse(resource.updated_at))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["updated_at"], message: "resource updated_at must be ISO-compatible" });
  }
});
export type Resource = z.infer<typeof ResourceSchema>;

export const EdgeType = z.enum([
  "depends_on",
  "calls",
  "imports",
  "contains",
  "implements",
  "supersedes",
  "related_to",
  "references",
  "provides",
  "belongs_to",
  "implemented_by",
  "invokes",
  "exposes",
  "publishes",
  "consumes",
  "reads_from",
  "writes_to",
  "builds",
  "tests",
  "deploys",
  "deployed_on",
  "owned_by",
  "monitored_by",
  "governed_by",
  "source_of_truth_for",
  "compatible_with",
  "replaces",
]);

export const ResourceRelationshipType = z.enum([
  "provides", "belongs_to", "implemented_by", "contains", "depends_on", "invokes",
  "exposes", "publishes", "consumes", "reads_from", "writes_to", "builds", "tests",
  "deploys", "deployed_on", "owned_by", "monitored_by", "governed_by",
  "source_of_truth_for", "compatible_with", "replaces", "implements",
]);

/** Typed relationship between components or symbols. */
export const EdgeSchema = z.object({
  schema: z.enum(["hunch.edge/1", RESOURCE_RELATIONSHIP_SCHEMA_VERSION]).default("hunch.edge/1"),
  id: z.string().describe("edge_*"),
  from: z.string(),
  to: z.string(),
  type: EdgeType,
  reason: z.string().default(""),
  strength: z.number().min(0).max(1).default(0.5),
  provenance: ProvenanceSchema,
  currentness: ResourceCurrentnessSchema.optional(),
  environment: z.string().max(256).nullable().default(null),
  criticality: z.enum(["low", "medium", "high", "critical"]).optional(),
  contract_version: z.string().max(256).optional(),
  metadata: ResourceMetadataSchema.default({}),
}).strict().superRefine((edge, ctx) => {
  if (edge.schema !== RESOURCE_RELATIONSHIP_SCHEMA_VERSION) return;
  const credentialFreeFields: Array<[string, string]> = [
    ["from", edge.from], ["to", edge.to], ["reason", edge.reason],
    ["provenance.source", edge.provenance.source],
    ...edge.provenance.evidence.map((evidence, index) => [`provenance.evidence.${index}`, evidence] as [string, string]),
    ...(edge.environment === null ? [] : [["environment", edge.environment] as [string, string]]),
    ...(edge.contract_version === undefined ? [] : [["contract_version", edge.contract_version] as [string, string]]),
    ...(edge.currentness?.source_revision === undefined
      ? []
      : [["currentness.source_revision", edge.currentness.source_revision] as [string, string]]),
    ...(edge.currentness?.source_content_hash === undefined
      ? []
      : [["currentness.source_content_hash", edge.currentness.source_content_hash] as [string, string]]),
  ];
  for (const [field, value] of credentialFreeFields) {
    if (!isCredentialFreeText(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: field.split("."), message: "credential material is forbidden in graph relationships" });
    }
  }
  if (!ResourceRelationshipType.options.includes(edge.type as z.infer<typeof ResourceRelationshipType>)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["type"], message: "unsupported resource relationship type" });
  }
  if (!isCanonicalResourceIdentity(edge.from) || !isCanonicalResourceIdentity(edge.to)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "resource relationships require kind-qualified endpoints" });
  }
  if (edge.id !== resourceRelationshipId(edge.from, edge.to, edge.type)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "resource relationship id must be deterministic from endpoints and type" });
  }
  if (!edge.currentness) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["currentness"], message: "resource relationships require currentness evidence" });
  }
  if (edge.from.length > 2048 || edge.to.length > 2048 || edge.reason.length > 2048
    || edge.provenance.source.length > 256 || edge.provenance.evidence.length > 64
    || edge.provenance.evidence.some((evidence) => evidence.length > 2048)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance"], message: "resource relationship fields must remain bounded" });
  }
});
export type Edge = z.infer<typeof EdgeSchema>;

export const SymbolKind = z.enum(["function", "method", "class", "interface", "trait", "enum", "type", "variable", "file"]);

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

// A premise: the WHY under the decision, as a checkable record. Decisions decay
// when their REASONS die, not (only) when code changes — a premise makes one
// recorded reason watchable. Exactly one check per premise (or none: claim-only
// premises document the reason but can never fire). Checks are deterministic and
// explicit — path presence or a dated human attestation — never semantic guesses.
// A failing premise NEVER changes authority; it only raises an inline escalation
// (the human renews, supersedes, or retires — same ethos as topic anchors).
export const PremiseSchema = z.object({
  claim: z.string().min(1).describe("the human-readable reason this decision rests on"),
  path_absent: z.string().optional().describe("premise holds while this repo-relative path does NOT exist. Requires `under`. PREFER path_exists where you can: a negative probe cannot tell 'verified absent' from 'wrong path', so it fails OPEN, while path_exists fails closed."),
  under: z.string().optional().describe("required with path_absent: an EXISTING repo-relative ancestor of it. When this anchor disappears (a directory deleted or moved), the premise reads unevaluable instead of silently 'still absent'."),
  path_exists: z.string().optional().describe("premise holds while this repo-relative path exists"),
  review_by: z.string().optional().describe("dated attestation: premise holds until this ISO date, then needs re-attesting"),
  attested: z.string().optional().describe("ISO date a human last attested the claim (informational)"),
}).refine((p) => [p.path_absent, p.path_exists, p.review_by].filter((x) => x !== undefined).length <= 1, {
  message: "a premise carries at most one check (path_absent | path_exists | review_by)",
}).refine((p) => p.path_absent === undefined || (typeof p.under === "string" && p.under.trim().length > 0), {
  message: "path_absent requires `under`: an existing ancestor path. Without an anchor, a deleted or renamed subtree reads as 'still absent' forever. Prefer path_exists where you can — it fails closed.",
  path: ["under"],
}).refine((p) => {
  if (p.path_absent === undefined || typeof p.under !== "string") return true;
  const norm = (s: string): string => s.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const target = norm(p.path_absent);
  const anchor = norm(p.under);
  // Must be a real ANCESTOR, not an arbitrary existing path: `under` is what makes
  // "absent" meaningful ("nothing named gateway UNDER src"). An unrelated anchor
  // would prove the premise still evaluable while telling you nothing about it.
  return anchor !== "" && target !== anchor && target.startsWith(`${anchor}/`);
}, {
  message: "`under` must be a proper ancestor of `path_absent` (e.g. path_absent 'src/gateway' with under 'src')",
  path: ["under"],
});
export type Premise = z.infer<typeof PremiseSchema>;

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
  // Optional like `topic`/`conformance`: absent = today's behavior exactly (no
  // migration, no new burden). Intended to be RARE — blocking constraints and
  // contested decisions, not every record (attestation fatigue kills reminder
  // systems). A decision with premises is "conditioned on [these]", never
  // "verified valid" — the system watches recorded reasons only.
  premises: z.array(PremiseSchema).optional().describe("the checkable reasons this decision rests on; a dead premise escalates, never auto-relaxes"),
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

/** An OBSERVATION — audited knowledge with no diff (the anchor is a date + evidence,
 *  not a commit). Fills the gap between Bug (broke and got fixed) and Decision (chose
 *  and changed code): "we looked, we found, we haven't acted yet". Examples: an audit
 *  that surfaced unscoped tenant queries, a measured perf number, a vendor limit, an
 *  incident with no code fix. ADVISORY retrieval context (pre-edit grounding + MCP);
 *  never enters any block path. Lifecycle is `triage`, not valid-time: a finding is
 *  resolved/stale-marked, never superseded. */
export const FindingSchema = z.object({
  id: z.string().describe("fnd_*"),
  title: z.string(),
  observation: z.string().default("").describe("what was observed, in plain words"),
  evidence: z.array(z.string()).default([]).describe("the query/command run + representative output — a finding without evidence is an opinion"),
  method: z.string().nullable().default(null).describe("rb_* runbook that re-runs the audit (makes the finding re-verifiable)"),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  triage: z.enum(["open", "accepted-risk", "scheduled", "resolved", "stale"]).default("open"),
  affected_files: z.array(z.string()).default([]).describe("concrete paths or globs the observation concerns"),
  affected_symbols: z.array(z.string()).default([]).describe("symbols/objects concerned (e.g. dbo.GetOrders)"),
  violates_constraint: z.string().nullable().default(null).describe("con_* this finding is a known violation of"),
  spawned_decision: z.string().nullable().default(null).describe("dec_* recorded in response to this finding"),
  observed_at: z.string().describe("ISO instant the observation was made — the anchor (findings have no commit)"),
  resolved_commit: z.string().nullable().default(null).describe("the commit that fixed it (set when triage becomes resolved)"),
  provenance: ProvenanceSchema,
});
export type Finding = z.infer<typeof FindingSchema>;

export const LANDSCAPE_DRIFT_CANDIDATE_SCHEMA_VERSION = "hunch.landscape-drift-candidate/1" as const;
const LANDSCAPE_DRIFT_HASH = /^sha256:[a-f0-9]{64}$/;
const LANDSCAPE_DRIFT_RECEIPT_ID = /^[a-z][a-z0-9_:-]{2,127}$/;

/**
 * An external observer's content-addressed mismatch claim. It is intake evidence
 * for an advisory Finding only: it cannot update a Resource, relationship,
 * currentness, decision, constraint, or execution policy.
 */
export const LandscapeDriftCandidateSchema = z.object({
  schema: z.literal(LANDSCAPE_DRIFT_CANDIDATE_SCHEMA_VERSION),
  candidateId: z.string().regex(/^ldf_[a-f0-9]{24}$/),
  classification: z.literal("repository_identity_mismatch"),
  resourceId: z.string().min(3).max(512),
  declaredRepositoryId: z.string().min(3).max(512),
  observedRepositoryId: z.string().min(3).max(512),
  observation: z.object({
    providerId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    observedAt: z.string().min(1).max(64),
    providerReceiptId: z.string().regex(LANDSCAPE_DRIFT_RECEIPT_ID),
    providerReceiptHash: z.string().regex(LANDSCAPE_DRIFT_HASH),
    resolutionReceiptId: z.string().regex(LANDSCAPE_DRIFT_RECEIPT_ID),
    resolutionReceiptHash: z.string().regex(LANDSCAPE_DRIFT_HASH),
    resolutionSetHash: z.string().regex(LANDSCAPE_DRIFT_HASH),
  }).strict(),
  authority: z.literal("finding_candidate"),
  contentHash: z.string().regex(LANDSCAPE_DRIFT_HASH),
}).strict().superRefine((candidate, ctx) => {
  if (!Number.isFinite(Date.parse(candidate.observation.observedAt))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["observation", "observedAt"], message: "landscape drift observation timestamp is invalid" });
  }
  for (const [field, value] of [
    ["resourceId", candidate.resourceId],
    ["declaredRepositoryId", candidate.declaredRepositoryId],
    ["observedRepositoryId", candidate.observedRepositoryId],
  ] as const) {
    if (!isCredentialFreeText(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "landscape drift candidate contains credential material" });
    }
  }
  if (candidate.declaredRepositoryId === candidate.observedRepositoryId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "landscape drift candidate must describe a real identity mismatch" });
  }
  const unsigned = landscapeDriftCandidateUnsigned(candidate);
  const contentHash = landscapeDriftCandidateHash(unsigned);
  if (candidate.contentHash !== contentHash || candidate.candidateId !== `ldf_${contentHash.slice(7, 31)}`) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "landscape drift candidate seal is invalid" });
  }
});
export type LandscapeDriftCandidate = z.infer<typeof LandscapeDriftCandidateSchema>;

export type CreateLandscapeDriftCandidateInput = Omit<LandscapeDriftCandidate,
  "schema" | "candidateId" | "classification" | "authority" | "contentHash">;

function landscapeDriftCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(landscapeDriftCanonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${landscapeDriftCanonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function landscapeDriftCandidateHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(landscapeDriftCanonical(value)).digest("hex")}`;
}

function landscapeDriftCandidateUnsigned(candidate: Pick<LandscapeDriftCandidate,
  "schema" | "classification" | "resourceId" | "declaredRepositoryId" | "observedRepositoryId"
  | "observation" | "authority">): Omit<LandscapeDriftCandidate, "candidateId" | "contentHash"> {
  return {
    schema: candidate.schema,
    classification: candidate.classification,
    resourceId: candidate.resourceId,
    declaredRepositoryId: candidate.declaredRepositoryId,
    observedRepositoryId: candidate.observedRepositoryId,
    observation: { ...candidate.observation },
    authority: candidate.authority,
  };
}

export function createLandscapeDriftCandidate(input: CreateLandscapeDriftCandidateInput): LandscapeDriftCandidate {
  const unsigned = landscapeDriftCandidateUnsigned({
    schema: LANDSCAPE_DRIFT_CANDIDATE_SCHEMA_VERSION,
    classification: "repository_identity_mismatch",
    resourceId: input.resourceId,
    declaredRepositoryId: input.declaredRepositoryId,
    observedRepositoryId: input.observedRepositoryId,
    observation: { ...input.observation },
    authority: "finding_candidate",
  });
  const contentHash = landscapeDriftCandidateHash(unsigned);
  return LandscapeDriftCandidateSchema.parse({
    ...unsigned,
    candidateId: `ldf_${contentHash.slice(7, 31)}`,
    contentHash,
  });
}

export function assertLandscapeDriftCandidate(value: unknown): asserts value is LandscapeDriftCandidate {
  LandscapeDriftCandidateSchema.parse(value);
}

/** Convert one valid external observation into advisory Hunch memory, never graph authority. */
export function landscapeDriftCandidateFinding(value: unknown): Finding {
  const candidate = LandscapeDriftCandidateSchema.parse(value);
  const title = `External repository identity drift: ${candidate.resourceId}`;
  const evidence = [
    `candidate:${candidate.candidateId}`,
    `candidate-content:${candidate.contentHash}`,
    `provider-receipt:${candidate.observation.providerReceiptId}@${candidate.observation.providerReceiptHash}`,
    `resolution-receipt:${candidate.observation.resolutionReceiptId}@${candidate.observation.resolutionReceiptHash}`,
    `resolution-set:${candidate.observation.resolutionSetHash}`,
  ];
  return FindingSchema.parse({
    id: findingId(title),
    title,
    observation: `Declared repository ${candidate.declaredRepositoryId} was observed as ${candidate.observedRepositoryId}; review the external reference before changing the landscape.`,
    evidence,
    method: null,
    severity: "medium",
    triage: "open",
    affected_files: [],
    affected_symbols: [candidate.resourceId],
    violates_constraint: null,
    spawned_decision: null,
    observed_at: candidate.observation.observedAt,
    resolved_commit: null,
    provenance: {
      source: "orc_observed+candidate",
      confidence: 0.8,
      evidence,
      last_verified: candidate.observation.observedAt,
    },
  });
}

/** The entity collections, keyed by their on-disk directory name. */
// nuryel.state/1 facets are ADDITIVE record kinds: a store without their directories
// loads exactly as before, and an older build ignores directories it does not know.
export const ENTITY_KINDS = [
  "components", "resources", "edges", "symbols", "decisions", "bugs", "constraints", "runbooks", "findings",
  "receipts", "commitments", "derived", "entities", "relationships",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const SCHEMAS = {
  components: ComponentSchema,
  resources: ResourceSchema,
  edges: EdgeSchema,
  symbols: SymbolSchema,
  decisions: DecisionSchema,
  bugs: BugSchema,
  constraints: ConstraintSchema,
  runbooks: RunbookSchema,
  findings: FindingSchema,
  receipts: ActionReceiptSchema,
  commitments: CommitmentSchema,
  derived: DerivedStateSchema,
  entities: ExternalEntitySchema,
  relationships: StateRelationshipSchema,
} as const;

export type EntityFor = {
  components: Component;
  resources: Resource;
  edges: Edge;
  symbols: Symbol;
  decisions: Decision;
  bugs: Bug;
  constraints: Constraint;
  runbooks: Runbook;
  findings: Finding;
  receipts: ActionReceipt;
  commitments: Commitment;
  derived: DerivedState;
  entities: ExternalEntity;
  relationships: StateRelationship;
};

/** Default provenance helper for deterministic (extracted) records. */
export function extracted(confidence: number, evidence: string[] = []): Provenance {
  return { source: "extracted", confidence, evidence };
}
export function inferred(confidence: number, evidence: string[] = []): Provenance {
  return { source: "inferred", confidence, evidence };
}
