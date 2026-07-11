import { z } from "zod";
import { ProvenanceSchema } from "../core/types.js";

export const POLICY_IR_VERSION = 1;
export const POLICY_EVALUATOR = { name: "hunch-graph-policy", version: "1.3.0" } as const;
export const MUTATION_ENGINE = { name: "hunch-static-graph-controls", version: "5" } as const;
export const EXECUTABLE_BEHAVIOR_IR_VERSION = 2;
export const BEHAVIOR_POLICY_EVALUATOR = { name: "hunch-executable-behavior", version: "1.0.0" } as const;
export const BEHAVIOR_MUTATION_ENGINE = { name: "hunch-behavior-controls", version: "1" } as const;

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

export const CandidateAlternativeSchema = z.object({
  id: z.string().regex(/^cand_[a-f0-9]{10}$/),
  basis: z.string().min(1),
  reason: z.string().min(1),
  assertion_hash: z.string().min(1),
}).strict();
export type CandidateAlternative = z.infer<typeof CandidateAlternativeSchema>;

export const PolicyScopeSchema = z.object({
  repos: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
  components: z.array(z.string()).default([]),
}).default({ repos: [], paths: [], components: [] });
export type PolicyScope = z.infer<typeof PolicyScopeSchema>;

export const CandidateContextSchema = z.object({
  alternatives: z.array(CandidateAlternativeSchema).default([]),
  uncertainty: z.array(z.string().min(1)).default([]),
  conflicts: z.array(z.string().regex(/^pol_[a-f0-9]{10}$/)).default([]),
  incumbent: z.string().regex(/^pol_[a-f0-9]{10}$/).nullable().default(null),
  scope_suggestion: PolicyScopeSchema.nullable().default(null),
  counterexamples: z.array(z.string().min(1)).default([]),
}).default({ alternatives: [], uncertainty: [], conflicts: [], incumbent: null, scope_suggestion: null, counterexamples: [] });
export type CandidateContext = z.infer<typeof CandidateContextSchema>;

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
    status: z.enum(["eligible", "compiled", "covered", "uncompilable", "conflicted"]),
    policy: z.string().nullable().default(null),
    reason: z.string().default(""),
    alternatives: z.array(CandidateAlternativeSchema).optional(),
    uncertainty: z.array(z.string().min(1)).optional(),
    conflicts: z.array(z.string().regex(/^pol_[a-f0-9]{10}$/)).optional(),
    incumbent: z.string().regex(/^pol_[a-f0-9]{10}$/).nullable().optional(),
    scope_suggestion: PolicyScopeSchema.nullable().optional(),
    counterexamples: z.array(z.string().min(1)).optional(),
  }).optional(),
  provenance: ProvenanceSchema,
}).passthrough();
export type EvidenceEvent = z.infer<typeof EvidenceEventSchema>;

export const EvidenceImportItemSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(["review", "instruction", "decision", "commit"]),
  occurred_at: z.string().datetime({ offset: true }),
  actor: z.string().min(1).max(200).optional(),
  commit: z.string().regex(/^[0-9a-fA-F]{4,64}$/, "commit must be a hexadecimal object id").optional(),
  files: z.array(z.string().min(1).max(1024)).max(64).default([]),
  symbols: z.array(z.string().min(1).max(500)).max(64).default([]),
  text: z.string().min(1).max(65_536).optional(),
  text_ref: z.string().min(1).max(1024).optional(),
  related_records: z.array(z.string().min(1).max(200)).max(64).default([]),
  data_class: DataClassSchema.default("public"),
  maintainer_confirmed: z.boolean().default(false),
}).strict().refine((item) => !!item.text || !!item.text_ref, {
  message: "imported evidence needs text or text_ref",
});
export type EvidenceImportItem = z.infer<typeof EvidenceImportItemSchema>;

export const EvidenceImportSchema = z.object({
  version: z.literal(1),
  source: z.enum(["pr_export", "review_export", "conversation_export"]),
  items: z.array(EvidenceImportItemSchema).min(1).max(100),
}).strict();
export type EvidenceImport = z.infer<typeof EvidenceImportSchema>;

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

const ExecutableBehaviorAssertionSchema = z.object({
  kind: z.literal("executable-behavior"),
  test: z.object({
    file: z.string().min(1).max(1024).refine((file) => !file.includes("\\") && !file.includes("\0") && !file.split("/").some((part) => part === "" || part === "." || part === ".."), "behavior test file must be a safe relative POSIX path"),
    name: z.string().min(1).max(500).refine((name) => !/[\0\r\n]/.test(name), "behavior test name cannot contain control line breaks"),
    source_commit: z.string().regex(/^[a-f0-9]{40}$/),
    source_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
  }).strict(),
  runner: z.enum(["node-test", "node-test-tsx"]),
  attestation: z.object({
    id: z.string().regex(/^g2behaviorattest_[a-f0-9]{10}$/),
    content_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
    candidate_id: z.string().regex(/^g2behavior_[a-f0-9]{10}$/),
    candidate_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
    replay_id: z.string().regex(/^g2behaviorreplay_[a-f0-9]{10}$/),
    replay_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
  }).strict(),
  dependency_snapshot_ids: z.array(z.string().regex(/^g2deps_[a-f0-9]{10}$/)).min(1).max(3),
  timeout_ms: z.number().int().min(1).max(120_000),
}).strict();

export const PolicyAssertionSchema = z.discriminatedUnion("kind", [
  ExistsAssertionSchema,
  ReachAssertionSchema,
  MustPassThroughAssertionSchema,
  ExecutableBehaviorAssertionSchema,
]);
export type PolicyAssertion = z.infer<typeof PolicyAssertionSchema>;

export const PolicyAuditEventSchema = z.object({
  action: z.enum(["compiled", "enriched", "linked_exception", "proved", "approved_advisory", "approved_blocking", "demoted", "retired", "rejected"]),
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
  ir_version: z.union([z.literal(POLICY_IR_VERSION), z.literal(EXECUTABLE_BEHAVIOR_IR_VERSION)]),
  revision: z.number().int().min(1),
  state: PolicyStateSchema,
  statement: z.string().min(1),
  rationale: z.string().default(""),
  scope: PolicyScopeSchema,
  assertion: PolicyAssertionSchema,
  severity: z.enum(["advisory", "warning", "blocking"]).default("warning"),
  surfaces: z.array(z.enum(["pre_edit", "pre_commit", "ci", "mcp", "cli"])).default(["cli", "mcp"]),
  authority: PolicyAuthoritySchema.nullable().default(null),
  evidence: z.array(z.string()).default([]),
  proof: z.string().nullable().default(null),
  reversal_conditions: z.array(z.string()).default([]),
  supersedes: z.string().nullable().default(null),
  superseded_by: z.string().nullable().default(null),
  exception_of: z.string().regex(/^pol_[a-f0-9]{10}$/).nullable().default(null),
  valid_from: z.string().nullable().default(null),
  valid_to: z.string().nullable().default(null),
  data_class: DataClassSchema.default("public"),
  limitations: z.array(z.string()).default([]),
  candidate: CandidateContextSchema,
  legacy_refs: z.array(z.string()).default([]),
  audit: z.array(PolicyAuditEventSchema).default([]),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  provenance: ProvenanceSchema,
}).passthrough().superRefine((policy, context) => {
  if (policy.assertion.kind === "executable-behavior" && policy.ir_version !== EXECUTABLE_BEHAVIOR_IR_VERSION) {
    context.addIssue({ code: "custom", path: ["ir_version"], message: `executable-behavior requires Policy IR v${EXECUTABLE_BEHAVIOR_IR_VERSION}` });
  }
  if (policy.assertion.kind !== "executable-behavior" && policy.ir_version !== POLICY_IR_VERSION) {
    context.addIssue({ code: "custom", path: ["ir_version"], message: `graph assertions require Policy IR v${POLICY_IR_VERSION}` });
  }
});
export type PolicySpec = z.infer<typeof PolicySpecSchema>;

export const PolicyCompositionMemberSchema = z.object({
  policy_id: z.string().regex(/^pol_[a-f0-9]{10}$/),
  policy_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
  exception_of: z.string().regex(/^pol_[a-f0-9]{10}$/),
  scope: PolicyScopeSchema,
}).strict();

export const PolicyCompositionBindingSchema = z.object({
  kind: z.literal("parent_with_exceptions"),
  root_policy_id: z.string().regex(/^pol_[a-f0-9]{10}$/),
  root_policy_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
  members: z.array(PolicyCompositionMemberSchema).min(1),
  composite_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
}).strict();
export type PolicyCompositionBinding = z.infer<typeof PolicyCompositionBindingSchema>;

export const PolicyEvaluationResultSchema = z.enum([
  "satisfied",
  "violated",
  "not_applicable",
  "unknown",
  "error",
]);
export type PolicyEvaluationResult = z.infer<typeof PolicyEvaluationResultSchema>;

export const BehaviorExecutionSchema = z.object({
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  workspace: z.object({
    kind: z.enum(["staged", "working"]),
    base_commit: z.string().regex(/^[a-f0-9]{40}$/),
    snapshot_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
    files: z.array(z.string().min(1)).max(10_000),
  }).strict().optional(),
  test: z.object({
    file: z.string().min(1),
    name: z.string().min(1),
    source_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
  }).strict(),
  runner: z.enum(["node-test", "node-test-tsx"]),
  dependency_snapshot_id: z.string().regex(/^g2deps_[a-f0-9]{10}$/).optional(),
  exit_code: z.number().int().nullable(),
  selected_event: z.enum(["passed", "failed"]).nullable(),
  error_code: z.string().min(1).optional(),
  execution_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
}).strict();
export type BehaviorExecution = z.infer<typeof BehaviorExecutionSchema>;

const HumanFixtureAttestationSchema = z.object({
  actor: z.string().regex(/^(human|github|git):[^\s]+$/i, "fixture attestation requires an explicit human actor (human:, github:, or git:)"),
  reason: z.string().min(1).max(2000),
}).strict();

export const ProofFixtureRefSchema = z.object({
  kind: z.enum(["commit", "fixture", "event", "mutation"]),
  ref: z.string().min(1),
  label: z.string().min(1),
  expected: PolicyEvaluationResultSchema,
  attestation: HumanFixtureAttestationSchema.optional(),
});
export type ProofFixtureRef = z.infer<typeof ProofFixtureRefSchema>;

const CorpusInputFixtureSchema = z.object({
  ref: z.string().min(1).max(1024),
  label: z.string().min(1).max(500),
}).strict();

const KnownGoodCorpusInputFixtureSchema = z.object({
  ref: z.string().min(1).max(1024),
  label: z.string().min(1).max(500),
  attestation: HumanFixtureAttestationSchema.optional(),
}).strict();

export const ProofCorpusInputSchema = z.object({
  known_bad: z.array(CorpusInputFixtureSchema).max(50).default([]),
  known_good: z.array(KnownGoodCorpusInputFixtureSchema).max(50).default([]),
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

const KnownGoodCorpusCommitFixtureSchema = z.object({
  kind: z.literal("commit"),
  ref: z.string().regex(/^[a-f0-9]{40}$/),
  label: z.string().min(1).max(500),
  expected: z.literal("satisfied"),
  attestation: HumanFixtureAttestationSchema.optional(),
}).strict();

export const ProofCorpusSchema = z.object({
  id: z.string().regex(/^corpus_[a-f0-9]{10}$/),
  content_hash: z.string().min(1),
  policy_id: z.string().regex(/^pol_[a-f0-9]{10}$/),
  policy_hash: z.string().min(1),
  repository: z.string().min(1),
  data_class: DataClassSchema,
  known_bad: z.array(CorpusCommitFixtureSchema.extend({ expected: z.literal("violated") })).max(50).default([]),
  known_good: z.array(KnownGoodCorpusCommitFixtureSchema).max(50).default([]),
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
  composition: PolicyCompositionBindingSchema.optional(),
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
  behavior: BehaviorExecutionSchema.optional(),
  composition: PolicyCompositionBindingSchema.extend({
    selected_policy_id: z.string().regex(/^pol_[a-f0-9]{10}$/),
    applicable_policy_ids: z.array(z.string().regex(/^pol_[a-f0-9]{10}$/)).min(1),
    member_evaluation_hashes: z.record(z.string().regex(/^pol_[a-f0-9]{10}$/), z.string().regex(/^sha1:[a-f0-9]{40}$/)),
  }).strict().optional(),
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
  behavior: BehaviorExecutionSchema.optional(),
  deterministic_hash: z.string().min(1),
}).strict();
export type ReplayReceipt = z.infer<typeof ReplayReceiptSchema>;

export const HistoryDispositionClassificationSchema = z.enum([
  "true_positive_actionable",
  "true_positive_accepted_exception",
  "false_positive_selector",
  "false_positive_semantics",
  "false_positive_stale",
  "unknown_insufficient_parser",
]);
export type HistoryDispositionClassification = z.infer<typeof HistoryDispositionClassificationSchema>;

export const HistoryDispositionSchema = z.object({
  id: z.string().regex(/^disp_[a-f0-9]{10}$/),
  content_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
  policy_id: z.string().regex(/^pol_[a-f0-9]{10}$/),
  proof_id: z.string().regex(/^proof_[a-f0-9]{10}$/),
  policy_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
  plan_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  receipt_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
  classification: HistoryDispositionClassificationSchema,
  actor: z.string().regex(/^(human|github|git):[^\s]+$/i, "history disposition requires an explicit human actor (human:, github:, or git:)"),
  reason: z.string().trim().min(1).max(2000),
  supersedes: z.string().regex(/^disp_[a-f0-9]{10}$/).nullable().default(null),
  data_class: DataClassSchema,
  created_at: z.string().datetime({ offset: true }),
}).strict();
export type HistoryDisposition = z.infer<typeof HistoryDispositionSchema>;

export const ShadowEvaluationRecordSchema = z.object({
  record_type: z.literal("evaluation"),
  id: z.string().regex(/^shadow_[a-f0-9]{10}$/),
  content_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
  policy_id: z.string().regex(/^pol_[a-f0-9]{10}$/),
  proof_id: z.string().regex(/^proof_[a-f0-9]{10}$/),
  policy_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
  plan_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
  evaluation: PolicyEvaluationSchema,
  also_detected_by: z.array(z.string().regex(/^pol_[a-f0-9]{10}$/)).default([]),
  latency_ms: z.number().nonnegative(),
  data_class: DataClassSchema,
  observed_at: z.string().datetime({ offset: true }),
}).strict();
export type ShadowEvaluationRecord = z.infer<typeof ShadowEvaluationRecordSchema>;

export const ShadowDispositionSchema = z.object({
  record_type: z.literal("disposition"),
  id: z.string().regex(/^sdisp_[a-f0-9]{10}$/),
  content_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
  shadow_id: z.string().regex(/^shadow_[a-f0-9]{10}$/),
  policy_id: z.string().regex(/^pol_[a-f0-9]{10}$/),
  proof_id: z.string().regex(/^proof_[a-f0-9]{10}$/),
  policy_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
  evaluation_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
  classification: HistoryDispositionClassificationSchema,
  actor: z.string().regex(/^(human|github|git):[^\s]+$/i, "shadow disposition requires an explicit human actor (human:, github:, or git:)"),
  reason: z.string().trim().min(1).max(2000),
  supersedes: z.string().regex(/^sdisp_[a-f0-9]{10}$/).nullable().default(null),
  data_class: DataClassSchema,
  created_at: z.string().datetime({ offset: true }),
}).strict();
export type ShadowDisposition = z.infer<typeof ShadowDispositionSchema>;

export const ShadowRecordSchema = z.discriminatedUnion("record_type", [ShadowEvaluationRecordSchema, ShadowDispositionSchema]);
export type ShadowRecord = z.infer<typeof ShadowRecordSchema>;

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
  behavior: BehaviorExecutionSchema.optional(),
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
  required_for_evaluator_sensitivity: z.boolean().default(false),
}).strict();

export const PolicyProofSchema = z.object({
  id: z.string().regex(/^proof_[a-f0-9]{10}$/),
  plan_hash: z.string(),
  policy_hash: z.string(),
  evaluator: z.object({ name: z.string(), version: z.string() }),
  mutation_engine: z.object({ name: z.string(), version: z.string() }).optional(),
  composition: PolicyCompositionBindingSchema.optional(),
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
