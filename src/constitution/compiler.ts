import type { Decision, ConformancePredicate } from "../core/types.js";
import type { HunchStore } from "../store/hunchStore.js";
import { policyId } from "./canonical.js";
import { POLICY_IR_VERSION, PolicySpecSchema, type DataClass, type PolicyAssertion, type PolicySelector, type PolicySpec } from "./schema.js";

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
  now?: string;
}

/** Compile one already-enumerated structural assertion. This function does not
 * infer or rank semantics; callers must pass an exact supported candidate. */
export function compileStructuralPolicy(store: HunchStore, input: StructuralPolicyInput): { policy: PolicySpec; private: boolean } {
  const isPrivate = input.dataClass !== "public";
  if (isPrivate && !store.hasPrivate) throw new Error("private structural compilation needs a configured Hunch private overlay");
  const now = input.now ?? new Date().toISOString();
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
      "Scope is intentionally limited to the changed caller or introduced-symbol file.",
      "TypeScript/JavaScript static calls only; dynamic calls and runtime dependency injection are not covered.",
    ],
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
