import type { Constraint, Decision, ConformancePredicate } from "../core/types.js";
import type { HunchStore } from "../store/hunchStore.js";
import { policyId } from "./canonical.js";
import { CORRECTION_POLICY_IR_VERSION, POLICY_IR_VERSION, PolicySpecSchema, type CandidateContext, type DataClass, type PolicyAssertion, type PolicySelector, type PolicySpec } from "./schema.js";

function selector(ref: string): PolicySelector {
  if (ref.startsWith("symbol-id:") || ref.startsWith("symbol:")) return { selector: ref };
  return { selector: ref.startsWith("sym_") ? `symbol-id:${ref}` : `symbol:${ref}` };
}

function compileAssertion(predicate: ConformancePredicate, through?: string): PolicyAssertion {
  if (predicate.assert === "exists") return { kind: "exists", subject: selector(predicate.subject) };
  if (!predicate.object) throw new Error(`legacy ${predicate.assert} predicate has no object`);
  const relation = {
    // Legacy conformance deliberately treated calls/imports as one unified graph.
    // Preserve that verdict exactly in the bridge instead of pretending edge-type
    // precision already exists.
    edges: ["calls", "imports", "depends_on", "contains"] as Array<"calls" | "imports" | "depends_on" | "contains">,
    transitive: predicate.transitive,
    max_depth: predicate.transitive ? 6 : 1,
  };
  const negative = predicate.assert === "not-calls" || predicate.assert === "not-imports";
  if (through) {
    if (!negative) throw new Error("--through can only upgrade a not-calls/not-imports boundary into must-pass-through");
    return {
      kind: "must-pass-through",
      subject: selector(predicate.subject),
      relation: { ...relation, transitive: true, max_depth: 6 },
      via: selector(through),
      object: selector(predicate.object),
    };
  }
  return {
    kind: negative ? "not-reaches" : "reaches",
    subject: selector(predicate.subject),
    relation,
    object: selector(predicate.object),
  };
}

export interface CompilePolicyOptions {
  through?: string;
  private?: boolean;
  now?: string;
}

export function compileDecisionRecord(
  store: HunchStore,
  source: Decision,
  isPrivate: boolean,
  opts: Omit<CompilePolicyOptions, "private"> = {},
): { policy: PolicySpec; private: boolean; source: Decision } {
  if (source.status === "rejected" || source.status === "superseded" || source.superseded_by) {
    throw new Error(`decision ${source.id} is not in force`);
  }
  if (source.conformance?.length !== 1) {
    throw new Error(`Gate G1 compiles exactly one structured conformance predicate; ${source.id} has ${source.conformance?.length ?? 0}`);
  }
  const assertion = compileAssertion(source.conformance[0]!, opts.through);
  if (isPrivate && !store.hasPrivate) throw new Error("private compilation needs a configured Hunch private overlay");
  const now = opts.now ?? new Date().toISOString();
  const id = policyId({ source: source.id, assertion });
  const policy = PolicySpecSchema.parse({
    id,
    topic: source.topic ?? `decision.${source.id}`,
    ir_version: POLICY_IR_VERSION,
    revision: 1,
    state: "compiled",
    statement: source.title,
    rationale: source.context || source.decision,
    scope: {
      repos: [],
      paths: source.related_files.filter((f) => !f.startsWith("private:")),
      components: [...source.related_components],
    },
    assertion,
    severity: "warning",
    surfaces: ["cli", "mcp", "ci"],
    authority: null,
    evidence: [source.id, ...(source.caused_by_bug ? [source.caused_by_bug] : [])],
    proof: null,
    reversal_conditions: [`Source decision ${source.id} is superseded or explicitly retired.`],
    supersedes: null,
    superseded_by: null,
    valid_from: null,
    valid_to: null,
    data_class: isPrivate ? "private" : "public",
    limitations: [
      "TypeScript/JavaScript static graph only in Gate G1.",
      "Dynamic calls and runtime dependency injection are not covered.",
      ...(opts.through ? [] : ["Legacy bridge preserves unified calls/imports/depends_on/contains reachability semantics."]),
    ],
    legacy_refs: [source.id],
    audit: [{ action: "compiled", actor_kind: "system", actor: "hunch:deterministic-compiler", at: now, reason: "Compiled from one structured Decision.conformance predicate.", proof: null }],
    created_at: now,
    updated_at: now,
    provenance: { source: "derived", confidence: 1, evidence: [source.id], last_verified: now },
  });
  return { policy, private: isPrivate, source };
}

/** Deterministic compatibility compiler: one structured legacy conformance
 * predicate becomes one Policy IR candidate. It never interprets prose into a
 * nearest available rule. */
export function compileDecisionPolicy(
  store: HunchStore,
  decisionId: string,
  opts: CompilePolicyOptions = {},
): { policy: PolicySpec; private: boolean; source: Decision } {
  const source = store.getRec("decisions", decisionId);
  if (!source) throw new Error(`decision ${decisionId} not found`);
  // A private source always taints its compiled artifact. `--private` can
  // promote a public source into the overlay, but an omitted/false CLI flag
  // must never declassify a same-id private overlay record into the public
  // repository.
  const isPrivate = !!opts.private || !!store.getPrivateRec("decisions", decisionId);
  return compileDecisionRecord(store, source, isPrivate, { through: opts.through, now: opts.now });
}

export interface StructuralPolicyInput {
  source: Decision;
  evidenceId: string;
  commit: string;
  assertion: PolicyAssertion;
  scope: PolicySpec["scope"];
  dataClass: DataClass;
  candidate?: CandidateContext;
  now?: string;
}

/** Compile one already-enumerated structural assertion. This function does not
 * infer or rank semantics; callers must pass an exact supported candidate. */
export function compileStructuralPolicy(store: HunchStore, input: StructuralPolicyInput): { policy: PolicySpec; private: boolean } {
  const isPrivate = input.dataClass !== "public";
  if (isPrivate && !store.hasPrivate) throw new Error("private structural compilation needs a configured Hunch private overlay");
  const now = input.now ?? new Date().toISOString();
  const externalImport = input.assertion.kind === "not-reaches"
    && input.assertion.relation.edges.length === 1
    && input.assertion.relation.edges[0] === "imports"
    && input.assertion.object.selector.startsWith("external:");
  const componentRelation = input.assertion.kind !== "exists"
    && input.assertion.kind !== "executable-behavior"
    && input.assertion.relation.edges.length === 1
    && input.assertion.relation.edges[0] === "depends_on"
    && input.assertion.subject.selector.startsWith("component");
  const id = policyId({ assertion: input.assertion, scope: input.scope, data_class: input.dataClass });
  const policy = PolicySpecSchema.parse({
    id,
    topic: input.source.topic ?? `decision.${input.source.id}`,
    ir_version: POLICY_IR_VERSION,
    revision: 1,
    state: "compiled",
    statement: input.source.title,
    rationale: input.source.context || input.source.decision,
    scope: input.scope,
    assertion: input.assertion,
    severity: "warning",
    surfaces: ["cli", "mcp", "ci"],
    authority: null,
    evidence: [input.source.id, input.evidenceId, `commit:${input.commit}`],
    proof: null,
    reversal_conditions: [`Source decision ${input.source.id} is superseded or the structural interpretation is rejected.`],
    supersedes: null,
    superseded_by: null,
    valid_from: null,
    valid_to: null,
    data_class: input.dataClass,
    limitations: [
      "Inferred from one exact first-parent Git structural delta; replay coverage is established only by a later plan-bound proof.",
      externalImport
        ? "Scope is intentionally limited to the changed file and anchored to one stable symbol in that file."
        : componentRelation
          ? "Scope is intentionally limited to the exact source and target components resolved from one relative static import."
        : "Scope is intentionally limited to the changed caller or introduced-symbol file.",
      externalImport
        ? "TypeScript/JavaScript static ESM import/export specifiers only; require(), dynamic import(), package aliases, and runtime loading are not covered."
        : componentRelation
          ? "TypeScript/JavaScript static relative ESM import/export specifiers only; aliases, absolute paths, import maps, require(), dynamic import(), and runtime loading are not covered."
        : "TypeScript/JavaScript static calls only; dynamic calls and runtime dependency injection are not covered.",
    ],
    candidate: input.candidate,
    legacy_refs: [input.source.id],
    audit: [{
      action: "compiled",
      actor_kind: "system",
      actor: "hunch:structural-delta-compiler",
      at: now,
      reason: `Compiled from one unambiguous assertion enumerated by evidence ${input.evidenceId}.`,
      proof: null,
    }],
    created_at: now,
    updated_at: now,
    provenance: {
      source: "derived",
      confidence: 0.8,
      evidence: [input.source.id, input.evidenceId, `commit:${input.commit}`],
      last_verified: now,
    },
  });
  return { policy, private: isPrivate };
}

export interface CorrectionPolicyInput {
  source: Constraint;
  evidenceId: string;
  assertion: PolicyAssertion;
  scope: PolicySpec["scope"];
  dataClass: DataClass;
  candidate?: CandidateContext;
  now?: string;
}

/** Compile one already-bound correction projection. The caller must first prove
 * that the projection has exactly one supported structural interpretation. */
export function compileCorrectionPolicy(store: HunchStore, input: CorrectionPolicyInput): { policy: PolicySpec; private: boolean } {
  const isPrivate = input.dataClass !== "public";
  if (isPrivate && !store.hasPrivate) throw new Error("private correction compilation needs a configured Hunch private overlay");
  const now = input.now ?? new Date().toISOString();
  const id = policyId({ assertion: input.assertion, scope: input.scope, data_class: input.dataClass });
  const refs = [...new Set([
    input.source.id,
    input.evidenceId,
    ...(input.source.source_decision ? [input.source.source_decision] : []),
  ])].sort();
  const policy = PolicySpecSchema.parse({
    id,
    topic: `correction.${input.source.id}`,
    origin: "correction_md1a",
    ir_version: CORRECTION_POLICY_IR_VERSION,
    revision: 1,
    state: "compiled",
    statement: input.source.statement,
    rationale: input.source.rationale,
    scope: input.scope,
    assertion: input.assertion,
    severity: "warning",
    surfaces: ["cli", "mcp", "ci"],
    authority: null,
    activation_gate: {
      kind: "source_currentness",
      status: "blocked",
      reason: "MD-1a correction projections cannot activate until MD-2 proves that every source correction and decision is still current.",
    },
    evidence: refs,
    proof: null,
    reversal_conditions: [
      `Source correction ${input.source.id} is retired or its exact structural interpretation is rejected.`,
      ...(input.source.source_decision ? [`Source decision ${input.source.source_decision} is superseded or explicitly closed.`] : []),
    ],
    supersedes: null,
    superseded_by: null,
    exception_of: null,
    valid_from: null,
    valid_to: null,
    data_class: input.dataClass,
    limitations: [
      "Scope is intentionally limited to one exact file and anchored to one stable symbol in that file.",
      "TypeScript/JavaScript static ESM import declarations only; re-exports, require(), dynamic import(), package aliases, and runtime loading are not covered.",
      "The immediate legacy Constraint remains the fast guard; this MD-1a policy cannot activate until the source-currentness gate is implemented and cleared.",
    ],
    candidate: input.candidate,
    legacy_refs: [input.source.id, ...(input.source.source_decision ? [input.source.source_decision] : [])],
    audit: [{
      action: "compiled",
      actor_kind: "system",
      actor: "hunch:correction-policy-materializer",
      at: now,
      reason: `Compiled from one deterministic supported projection bound to correction ${input.source.id}.`,
      proof: null,
    }],
    created_at: now,
    updated_at: now,
    provenance: {
      source: "derived",
      confidence: 1,
      evidence: refs,
      last_verified: now,
    },
  });
  return { policy, private: isPrivate };
}
