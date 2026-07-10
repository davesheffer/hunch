import { z } from "zod";
import { ProvenanceSchema } from "../core/types.js";

export const POLICY_IR_VERSION = 1;
export const POLICY_EVALUATOR = { name: "hunch-graph-policy", version: "1.0.0" } as const;
export const MUTATION_ENGINE = { name: "hunch-static-graph-controls", version: "2" } as const;

export const DataClassSchema = z.enum(["public", "private", "secret"]);
export type DataClass = z.infer<typeof DataClassSchema>;

export const StructuralSymbolRefSchema = z.object({
  file: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["function", "method", "class", "interface", "type"]),
});
export type StructuralSymbolRef = z.infer<typeof StructuralSymbolRefSchema>;

export const StructuralCallRefSchema = z.object({
  file: z.string().min(1),
  caller: z.string().min(1),
  callee: z.string().min(1),
  member: z.boolean().default(false),
});
export type StructuralCallRef = z.infer<typeof StructuralCallRefSchema>;

export const StructuralImportRefSchema = z.object({
  file: z.string().min(1),
  specifier: z.string().min(1),
});
export type StructuralImportRef = z.infer<typeof StructuralImportRefSchema>;

export const StructuralDeltaSchema = z.object({
  id: z.string().regex(/^delta_[a-f0-9]{10}$/),
  before_commit: z.string(),
  after_commit: z.string().min(1),
  files: z.array(z.string()).default([]),
  symbols: z.object({
    added: z.array(StructuralSymbolRefSchema).default([]),
    removed: z.array(StructuralSymbolRefSchema).default([]),
    moved: z.array(z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      name: z.string().min(1),
      kind: StructuralSymbolRefSchema.shape.kind,
    })).default([]),
  }),
  calls: z.object({
    added: z.array(StructuralCallRefSchema).default([]),
    removed: z.array(StructuralCallRefSchema).default([]),
  }),
  imports: z.object({
    added: z.array(StructuralImportRefSchema).default([]),
    removed: z.array(StructuralImportRefSchema).default([]),
  }),
  content_hash: z.string().min(1),
}).strict();
export type StructuralDelta = z.infer<typeof StructuralDeltaSchema>;

export const EvidenceEventSchema = z.object({
  id: z.string().regex(/^ev_[a-f0-9]{10}$/),
  kind: z.enum(["correction", "review", "incident", "decision", "revert", "bug_fix", "test_failure", "instruction", "commit"]),
  occurred_at: z.string().datetime({ offset: true }),
  actor: z.string().optional(),
  repository: z.string().min(1),
  commit: z.string().optional(),
  files: z.array(z.string()).default([]),
  symbols: z.array(z.string()).default([]),
  text_ref: z.string().optional(),
  diff_ref: z.string().optional(),
  related_records: z.array(z.string()).default([]),
  data_class: DataClassSchema,
  content_hash: z.string(),
  structural_delta: StructuralDeltaSchema.optional(),
  compiler: z.object({
    status: z.enum(["eligible", "compiled", "covered", "uncompilable"]),
    policy: z.string().nullable().default(null),
    reason: z.string().default(""),
  }).optional(),
  provenance: ProvenanceSchema,
}).passthrough();
export type EvidenceEvent = z.infer<typeof EvidenceEventSchema>;

export const PolicyStateSchema = z.enum([
  "observed",
  "drafted",
  "compiled",
  "uncompilable",
  "validating",
  "proposed",
  "active_advisory",
  "active_blocking",
  "stale",
  "repaired",
  "superseded",
  "retired",
  "rejected",
]);
export type PolicyState = z.infer<typeof PolicyStateSchema>;

export const PolicySelectorSchema = z.object({
  selector: z.string().min(1),
});
export type PolicySelector = z.infer<typeof PolicySelectorSchema>;

export const PolicyRelationSchema = z.object({
  edges: z.array(z.enum(["calls", "imports", "depends_on", "contains"])).min(1).default(["calls", "imports"]),
  transitive: z.boolean().default(true),
  max_depth: z.number().int().min(1).max(64).default(6),
});
export type PolicyRelation = z.infer<typeof PolicyRelationSchema>;

const ExistsAssertionSchema = z.object({
  kind: z.literal("exists"),
  subject: PolicySelectorSchema,
});

const ReachAssertionSchema = z.object({
  kind: z.enum(["reaches", "not-reaches"]),
  subject: PolicySelectorSchema,
  relation: PolicyRelationSchema,
  object: PolicySelectorSchema,
});

const MustPassThroughAssertionSchema = z.object({
  kind: z.literal("must-pass-through"),
  subject: PolicySelectorSchema,
  relation: PolicyRelationSchema,
  via: PolicySelectorSchema,
  object: PolicySelectorSchema,
});

export const PolicyAssertionSchema = z.discriminatedUnion("kind", [
  ExistsAssertionSchema,
  ReachAssertionSchema,
  MustPassThroughAssertionSchema,
]);
export type PolicyAssertion = z.infer<typeof PolicyAssertionSchema>;

export const PolicyAuditEventSchema = z.object({
  action: z.enum(["compiled", "proved", "approved_advisory", "approved_blocking", "demoted", "retired", "rejected"]),
  actor_kind: z.enum(["system", "human"]),
  actor: z.string().min(1),
  at: z.string().datetime({ offset: true }),
  reason: z.string().default(""),
  proof: z.string().nullable().default(null),
});
export type PolicyAuditEvent = z.infer<typeof PolicyAuditEventSchema>;

export const PolicyAuthoritySchema = z.object({
  kind: z.literal("human"),
  actor: z.string().min(1),
  event: z.string().min(1),
  at: z.string().datetime({ offset: true }),
});
export type PolicyAuthority = z.infer<typeof PolicyAuthoritySchema>;

export const PolicySpecSchema = z.object({
  id: z.string().regex(/^pol_[a-f0-9]{10}$/),
  topic: z.string().min(1),
  ir_version: z.literal(POLICY_IR_VERSION),
  revision: z.number().int().min(1),
  state: PolicyStateSchema,
  statement: z.string().min(1),
  rationale: z.string().default(""),
  scope: z.object({
    repos: z.array(z.string()).default([]),
    paths: z.array(z.string()).default([]),
    components: z.array(z.string()).default([]),
  }).default({ repos: [], paths: [], components: [] }),
  assertion: PolicyAssertionSchema,
  severity: z.enum(["advisory", "warning", "blocking"]).default("warning"),
  surfaces: z.array(z.enum(["pre_edit", "pre_commit", "ci", "mcp", "cli"])).default(["cli", "mcp"]),
  authority: PolicyAuthoritySchema.nullable().default(null),
  evidence: z.array(z.string()).default([]),
  proof: z.string().nullable().default(null),
  reversal_conditions: z.array(z.string()).default([]),
  supersedes: z.string().nullable().default(null),
  superseded_by: z.string().nullable().default(null),
  valid_from: z.string().nullable().default(null),
  valid_to: z.string().nullable().default(null),
  data_class: DataClassSchema.default("public"),
  limitations: z.array(z.string()).default([]),
  legacy_refs: z.array(z.string()).default([]),
  audit: z.array(PolicyAuditEventSchema).default([]),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  provenance: ProvenanceSchema,
}).passthrough();
export type PolicySpec = z.infer<typeof PolicySpecSchema>;

export const PolicyEvaluationResultSchema = z.enum([
  "satisfied",
  "violated",
  "not_applicable",
  "unknown",
  "error",
]);
export type PolicyEvaluationResult = z.infer<typeof PolicyEvaluationResultSchema>;

export const ProofFixtureRefSchema = z.object({
  kind: z.enum(["commit", "fixture", "event", "mutation"]),
  ref: z.string().min(1),
  label: z.string().min(1),
  expected: PolicyEvaluationResultSchema,
});
export type ProofFixtureRef = z.infer<typeof ProofFixtureRefSchema>;

const CorpusInputFixtureSchema = z.object({
  ref: z.string().min(1).max(1024),
  label: z.string().min(1).max(500),
}).strict();

export const ProofCorpusInputSchema = z.object({
  known_bad: z.array(CorpusInputFixtureSchema).max(50).default([]),
  known_good: z.array(CorpusInputFixtureSchema).max(50).default([]),
}).strict().refine((value) => value.known_bad.length + value.known_good.length > 0, {
  message: "corpus import must declare at least one known-good or known-bad fixture",
});
export type ProofCorpusInput = z.infer<typeof ProofCorpusInputSchema>;

const CorpusCommitFixtureSchema = z.object({
  kind: z.literal("commit"),
  ref: z.string().regex(/^[a-f0-9]{40}$/),
  label: z.string().min(1).max(500),
  expected: PolicyEvaluationResultSchema,
}).strict();

export const ProofCorpusSchema = z.object({
  id: z.string().regex(/^corpus_[a-f0-9]{10}$/),
  content_hash: z.string().min(1),
  policy_id: z.string().regex(/^pol_[a-f0-9]{10}$/),
  policy_hash: z.string().min(1),
  repository: z.string().min(1),
  data_class: DataClassSchema,
  known_bad: z.array(CorpusCommitFixtureSchema.extend({ expected: z.literal("violated") })).max(50).default([]),
  known_good: z.array(CorpusCommitFixtureSchema.extend({ expected: z.literal("satisfied") })).max(50).default([]),
  created_at: z.string().datetime({ offset: true }),
}).strict();
export type ProofCorpus = z.infer<typeof ProofCorpusSchema>;

export const ProofPlanSchema = z.object({
  id: z.string().regex(/^plan_[a-f0-9]{10}$/),
  content_hash: z.string().min(1),
  policy_id: z.string().regex(/^pol_[a-f0-9]{10}$/),
  policy_candidate_hash: z.string().min(1),
  repository: z.string().min(1),
  data_class: DataClassSchema,
  source_commit: z.string().min(1),
  valid_from_commit: z.string().min(1),
  evaluator: z.object({ name: z.string().min(1), version: z.string().min(1) }),
  mutation_engine: z.object({ name: z.string().min(1), version: z.string().min(1) }).optional(),
  corpus_manifest: z.object({
    id: z.string().regex(/^corpus_[a-f0-9]{10}$/),
    content_hash: z.string().min(1),
  }).strict().optional(),
  corpus: z.object({
    current_baseline: ProofFixtureRefSchema,
    accepted_history: z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      first_parent: z.boolean().default(true),
      max_commits: z.number().int().min(0).max(500),
      exclude: z.array(z.string()).default([]),
    }),
    known_bad: z.array(ProofFixtureRefSchema).default([]),
    known_good: z.array(ProofFixtureRefSchema).default([]),
  }),
  mutations: z.array(z.object({
    operator: z.string().min(1),
    base: z.string().min(1),
    expected: PolicyEvaluationResultSchema,
    required: z.boolean().default(true),
  })).default([]),
  budgets: z.object({
    max_commits: z.number().int().min(0).max(500),
    max_mutations: z.number().int().min(0).max(100),
    max_minutes: z.number().int().min(1).max(120),
  }),
  expected: z.array(z.object({
    leg: z.enum(["current_baseline", "known_bad", "known_good", "accepted_history", "mutations"]),
    result: PolicyEvaluationResultSchema.optional(),
    classification_required: z.boolean().default(false),
  })).default([]),
  evidence_refs: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  created_at: z.string().datetime({ offset: true }),
}).strict();
export type ProofPlan = z.infer<typeof ProofPlanSchema>;

export const PolicyEvaluationSchema = z.object({
  policy_id: z.string(),
  policy_revision: z.number().int(),
  result: PolicyEvaluationResultSchema,
  evaluator: z.object({ name: z.string(), version: z.string() }),
  repository: z.object({
    base: z.string().optional(),
    head: z.string(),
    graph_hash: z.string(),
  }),
  matches: z.array(z.object({
    file: z.string(),
    line: z.number().int().optional(),
    symbol: z.string().optional(),
    relation_path: z.array(z.string()).optional(),
  })),
  explanation: z.string(),
  evidence_refs: z.array(z.string()),
  deterministic_hash: z.string(),
});
export type PolicyEvaluation = z.infer<typeof PolicyEvaluationSchema>;

export const ProofClassSchema = z.enum(["P0", "P1", "P2", "P3", "P4", "P5"]);
export type ProofClass = z.infer<typeof ProofClassSchema>;

export const EvaluationSummarySchema = z.object({
  total: z.number().int().min(0),
  satisfied: z.number().int().min(0),
  violated: z.number().int().min(0),
  not_applicable: z.number().int().min(0),
  unknown: z.number().int().min(0),
  error: z.number().int().min(0),
  receipt_hashes: z.array(z.string()).default([]),
});
export type EvaluationSummary = z.infer<typeof EvaluationSummarySchema>;

export const ReplayReceiptSchema = z.object({
  leg: z.enum(["current_baseline", "known_bad", "known_good", "accepted_history"]),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  expected: PolicyEvaluationResultSchema.optional(),
  policy_hash: z.string().min(1),
  evaluator: z.object({ name: z.string().min(1), version: z.string().min(1) }),
  result: PolicyEvaluationResultSchema,
  graph_hash: z.string().min(1).optional(),
  evaluation_hash: z.string().min(1).optional(),
  error_code: z.string().min(1).optional(),
  deterministic_hash: z.string().min(1),
}).strict();
export type ReplayReceipt = z.infer<typeof ReplayReceiptSchema>;

export const MutationReceiptSchema = z.object({
  id: z.string().regex(/^mut_[a-f0-9]{10}$/),
  kind: z.enum(["primary", "control"]),
  operator: z.string().min(1),
  required: z.boolean(),
  engine: z.object({ name: z.string().min(1), version: z.string().min(1) }),
  policy_hash: z.string().min(1),
  base_commit: z.string().min(1),
  base_graph_hash: z.string().min(1),
  mutated_graph_hash: z.string().min(1).optional(),
  expected: PolicyEvaluationResultSchema,
  result: PolicyEvaluationResultSchema,
  passed: z.boolean(),
  parseability: z.enum(["parseable", "unparseable", "not_applicable"]),
  graph_diff: z.object({
    added_symbols: z.array(z.string()).default([]),
    removed_symbols: z.array(z.string()).default([]),
    added_edges: z.array(z.string()).default([]),
    removed_edges: z.array(z.string()).default([]),
  }).strict(),
  parser_control: z.object({
    source_hash: z.string().min(1),
    observed_target_calls: z.array(z.string()).default([]),
    observed_target_imports: z.array(z.string()).default([]),
  }).strict().optional(),
  source_patch: z.object({
    files: z.array(z.string()).min(1),
    diff: z.string().min(1).max(65536),
    diff_hash: z.string().min(1),
  }).strict().optional(),
  evaluation_hash: z.string().min(1).optional(),
  error_code: z.string().min(1).optional(),
  deterministic_hash: z.string().min(1),
}).strict();
export type MutationReceipt = z.infer<typeof MutationReceiptSchema>;

const MutationControlSummarySchema = z.object({
  total: z.number().int().min(0),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  receipt_hashes: z.array(z.string()).default([]),
}).strict();

const ProjectChecksSchema = z.object({
  build: z.enum(["not_run", "passed", "failed", "error"]).default("not_run"),
  test: z.enum(["not_run", "passed", "failed", "error"]).default("not_run"),
  required_for_evaluator_sensitivity: z.literal(false).default(false),
}).strict();

export const PolicyProofSchema = z.object({
  id: z.string().regex(/^proof_[a-f0-9]{10}$/),
  plan_hash: z.string(),
  policy_hash: z.string(),
  evaluator: z.object({ name: z.string(), version: z.string() }),
  mutation_engine: z.object({ name: z.string(), version: z.string() }).optional(),
  generated_at: z.string().datetime({ offset: true }),
  current: EvaluationSummarySchema,
  known_bad: EvaluationSummarySchema,
  known_good: EvaluationSummarySchema,
  accepted_history: EvaluationSummarySchema.extend({ classified_hits: z.array(z.string()).default([]) }),
  mutations: EvaluationSummarySchema.extend({ operator_coverage: z.record(z.string(), z.number().int().min(0)).default({}) }),
  replay_receipts: z.array(ReplayReceiptSchema).default([]),
  mutation_receipts: z.array(MutationReceiptSchema).default([]),
  mutation_controls: MutationControlSummarySchema.default({ total: 0, passed: 0, failed: 0, receipt_hashes: [] }),
  project_checks: ProjectChecksSchema.default({ build: "not_run", test: "not_run", required_for_evaluator_sensitivity: false }),
  limitations: z.array(z.string()).default([]),
  proof_class: ProofClassSchema,
  artifact_hashes: z.record(z.string(), z.string()).default({}),
  data_class: DataClassSchema,
}).passthrough();
export type PolicyProof = z.infer<typeof PolicyProofSchema>;
