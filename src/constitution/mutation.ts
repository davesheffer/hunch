import { shortHash } from "../core/ids.js";
import { externalPackage } from "../core/externalImports.js";
import type { Component, Symbol } from "../core/types.js";
import { parseSource } from "../extractors/parse.js";
import { canonicalHash, canonicalJson, policySemanticHash, proofEvaluationHash } from "./canonical.js";
import {
  evaluatePolicyOnSnapshot,
  graphSnapshotFromRecords,
  mutateSnapshotForPolicy,
  mutationOperatorForPolicy,
  type GraphSnapshot,
} from "./evaluator.js";
import {
  MutationReceiptSchema,
  MUTATION_ENGINE,
  type MutationReceipt,
  type PolicyEvaluation,
  type PolicyEvaluationResult,
  type PolicySelector,
  type PolicySpec,
  type ProofPlan,
} from "./schema.js";
import { runSourceMutation } from "./sourceMutation.js";

type PlannedMutation = ProofPlan["mutations"][number];

export interface MutationHarnessResult {
  receipts: MutationReceipt[];
  primary_evaluations: PolicyEvaluation[];
}

interface MutationHarnessContext {
  policy_hash: string;
  mutation_policy: PolicySpec;
  evaluate: (snapshot: GraphSnapshot) => PolicyEvaluation;
}

function policySelectors(policy: PolicySpec): PolicySelector[] {
  const assertion = policy.assertion;
  return [
    assertion.subject,
    ...(assertion.kind === "exists" ? [] : [assertion.object]),
    ...(assertion.kind === "must-pass-through" ? [assertion.via] : []),
  ];
}

function symbolForSelector(snapshot: GraphSnapshot, selector: PolicySelector): Symbol | null {
  const raw = selector.selector;
  if (raw.startsWith("symbol-id:")) {
    return snapshot.symbols.find((symbol) => symbol.id === raw.slice("symbol-id:".length)) ?? null;
  }
  if (!raw.startsWith("symbol:")) return null;
  const target = raw.slice("symbol:".length);
  const split = target.lastIndexOf(":");
  const matches = split > 0
    ? snapshot.symbols.filter((symbol) => symbol.name === target.slice(split + 1) && (symbol.file === target.slice(0, split) || symbol.file.endsWith(`/${target.slice(0, split)}`)))
    : snapshot.symbols.filter((symbol) => symbol.name === target);
  return matches.length === 1 ? matches[0]! : null;
}

function nameForSelector(snapshot: GraphSnapshot, selector: PolicySelector): string | null {
  const symbol = symbolForSelector(snapshot, selector);
  if (symbol) return symbol.name;
  const component = componentForSelector(snapshot, selector);
  if (component) return component.name;
  return selector.selector.startsWith("external:")
    ? externalPackage(selector.selector.slice("external:".length))
    : null;
}

function componentForSelector(snapshot: GraphSnapshot, selector: PolicySelector): Component | null {
  const raw = selector.selector;
  if (raw.startsWith("component-id:")) return snapshot.components.find((component) => component.id === raw.slice("component-id:".length)) ?? null;
  if (!raw.startsWith("component:")) return null;
  const name = raw.slice("component:".length);
  const matches = snapshot.components.filter((component) => component.name === name);
  return matches.length === 1 ? matches[0]! : null;
}

function graphDiff(base: GraphSnapshot, mutated: GraphSnapshot): MutationReceipt["graph_diff"] {
  const baseSymbols = new Set(base.symbols.map((symbol) => symbol.id));
  const mutatedSymbols = new Set(mutated.symbols.map((symbol) => symbol.id));
  const baseEdges = new Set(base.edges.map((edge) => edge.id));
  const mutatedEdges = new Set(mutated.edges.map((edge) => edge.id));
  return {
    added_symbols: [...mutatedSymbols].filter((id) => !baseSymbols.has(id)).sort(),
    removed_symbols: [...baseSymbols].filter((id) => !mutatedSymbols.has(id)).sort(),
    added_edges: [...mutatedEdges].filter((id) => !baseEdges.has(id)).sort(),
    removed_edges: [...baseEdges].filter((id) => !mutatedEdges.has(id)).sort(),
  };
}

function receipt(
  policy: PolicySpec,
  base: GraphSnapshot,
  input: Omit<MutationReceipt, "id" | "engine" | "policy_hash" | "base_commit" | "base_graph_hash" | "deterministic_hash">,
  policyHash = policySemanticHash(policy),
): MutationReceipt {
  const seed = {
    engine: MUTATION_ENGINE,
    policy_hash: policyHash,
    base_commit: base.head,
    base_graph_hash: base.graph_hash,
    kind: input.kind,
    operator: input.operator,
  };
  const body = {
    id: `mut_${shortHash(canonicalJson(seed))}`,
    engine: { ...MUTATION_ENGINE },
    policy_hash: seed.policy_hash,
    base_commit: seed.base_commit,
    base_graph_hash: seed.base_graph_hash,
    ...input,
  };
  return MutationReceiptSchema.parse({ ...body, deterministic_hash: canonicalHash(body) });
}

function errorReceipt(
  policy: PolicySpec,
  base: GraphSnapshot,
  planned: PlannedMutation,
  kind: "primary" | "control",
  code: string,
  parseability: MutationReceipt["parseability"] = "not_applicable",
  policyHash = policySemanticHash(policy),
): MutationReceipt {
  return receipt(policy, base, {
    kind,
    operator: planned.operator,
    required: planned.required,
    expected: planned.expected,
    result: "error",
    passed: false,
    parseability,
    graph_diff: { added_symbols: [], removed_symbols: [], added_edges: [], removed_edges: [] },
    error_code: code,
  }, policyHash);
}

function primaryMutation(
  root: string,
  policy: PolicySpec,
  base: GraphSnapshot,
  planned: PlannedMutation,
  context: MutationHarnessContext,
): { receipt: MutationReceipt; evaluation?: PolicyEvaluation } {
  const expectedOperator = mutationOperatorForPolicy(context.mutation_policy);
  if (planned.operator !== expectedOperator) {
    throw new Error(`proof plan mutation ${planned.operator} does not match evaluator operator ${expectedOperator}`);
  }
  if (/^[a-f0-9]{40}$/.test(base.head)) {
    const source = runSourceMutation(root, context.mutation_policy, base);
    if (!source.snapshot || !source.evaluation || !source.source_patch) {
      const code = source.error_code ?? "source-mutation-failed";
      return {
        receipt: errorReceipt(
          policy,
          base,
          planned,
          "primary",
          code,
          code === "mutation-source-unparseable" ? "unparseable" : "not_applicable",
          context.policy_hash,
        ),
      };
    }
    const evaluation = context.evaluate(source.snapshot);
    return {
      evaluation,
      receipt: receipt(policy, base, {
        kind: "primary",
        operator: planned.operator,
        required: planned.required,
        mutated_graph_hash: source.snapshot.graph_hash,
        expected: planned.expected,
        result: evaluation.result,
        passed: evaluation.result === planned.expected,
        parseability: "parseable",
        graph_diff: graphDiff(base, source.snapshot),
        source_patch: source.source_patch,
        evaluation_hash: proofEvaluationHash(evaluation),
      }, context.policy_hash),
    };
  }
  const mutation = mutateSnapshotForPolicy(context.mutation_policy, base);
  if (!mutation) return { receipt: errorReceipt(policy, base, planned, "primary", "mutation-unavailable", "not_applicable", context.policy_hash) };
  const evaluation = context.evaluate(mutation.snapshot);
  return {
    evaluation,
    receipt: receipt(policy, base, {
      kind: "primary",
      operator: planned.operator,
      required: planned.required,
      mutated_graph_hash: mutation.snapshot.graph_hash,
      expected: planned.expected,
      result: evaluation.result,
      passed: evaluation.result === planned.expected,
      parseability: "not_applicable",
      graph_diff: graphDiff(base, mutation.snapshot),
      evaluation_hash: proofEvaluationHash(evaluation),
    }, context.policy_hash),
  };
}

function commentStringControl(
  policy: PolicySpec,
  base: GraphSnapshot,
  planned: PlannedMutation,
  context: MutationHarnessContext,
): MutationReceipt {
  const baseline = context.evaluate(base);
  const targets = [...new Set(policySelectors(policy)
    .map((selector) => nameForSelector(base, selector))
    .filter((name): name is string => !!name))].sort();
  if (!targets.length) return errorReceipt(policy, base, planned, "control", "control-selector-unresolved", "not_applicable", context.policy_hash);
  const marker = targets.map((name) => `${name}()`).join(" ");
  const source = [
    "export function hunchMutationCommentStringControl(){",
    `  const marker = ${JSON.stringify(marker)};`,
    `  // ${marker}`,
    "  return marker;",
    "}",
    "",
  ].join("\n");
  const parsed = parseSource("hunch-mutation-comment-string-control.ts", source);
  const observedCalls = parsed?.calls.map((call) => call.callee).filter((name) => targets.includes(name)).sort() ?? [];
  const observedImports = parsed?.imports.filter((specifier) => targets.includes(specifier)).sort() ?? [];
  const parserPassed = !!parsed?.parseable && observedCalls.length === 0 && observedImports.length === 0;
  const result: PolicyEvaluationResult = parserPassed ? baseline.result : "error";
  return receipt(policy, base, {
    kind: "control",
    operator: planned.operator,
    required: planned.required,
    mutated_graph_hash: base.graph_hash,
    expected: planned.expected,
    result,
    passed: parserPassed && result === planned.expected,
    parseability: parsed?.parseable ? "parseable" : "unparseable",
    graph_diff: { added_symbols: [], removed_symbols: [], added_edges: [], removed_edges: [] },
    parser_control: {
      source_hash: canonicalHash(source),
      observed_target_calls: observedCalls,
      observed_target_imports: observedImports,
    },
    ...(parserPassed ? { evaluation_hash: proofEvaluationHash(baseline) } : { error_code: "comment-string-parser-control-failed" }),
  }, context.policy_hash);
}

function sameNameControl(
  policy: PolicySpec,
  base: GraphSnapshot,
  planned: PlannedMutation,
  context: MutationHarnessContext,
): MutationReceipt {
  const selected = policySelectors(policy).map((selector) => symbolForSelector(base, selector)).filter((symbol): symbol is Symbol => !!symbol);
  if (!selected.length) {
    const selectedComponents = policySelectors(policy).map((selector) => componentForSelector(base, selector)).filter((component): component is Component => !!component);
    if (!selectedComponents.length) return errorReceipt(policy, base, planned, "control", "control-selector-unresolved", "not_applicable", context.policy_hash);
    const clones = [...new Map(selectedComponents.map((component) => [component.id, component])).values()].map((component, index): Component => ({
      ...component,
      id: `${component.id}_mutation_control_${index + 1}`,
      paths: [`__hunch_controls__/same-name-component-${index + 1}/**`],
    }));
    const controlled = graphSnapshotFromRecords(base.root, base.head, base.symbols, base.edges, [...base.components, ...clones]);
    const evaluation = context.evaluate(controlled);
    return receipt(policy, base, {
      kind: "control",
      operator: planned.operator,
      required: planned.required,
      mutated_graph_hash: controlled.graph_hash,
      expected: planned.expected,
      result: evaluation.result,
      passed: evaluation.result === planned.expected,
      parseability: "not_applicable",
      graph_diff: graphDiff(base, controlled),
      evaluation_hash: proofEvaluationHash(evaluation),
    }, context.policy_hash);
  }
  const unique = [...new Map(selected.map((symbol) => [symbol.id, symbol])).values()];
  const clones = unique.map((symbol, index): Symbol => ({
    ...symbol,
    id: `${symbol.id}_mutation_control_${index + 1}`,
    file: `__hunch_controls__/same-name-${index + 1}.ts`,
    calls: [],
    called_by: [],
    metrics: { ...symbol.metrics, fan_in: 0, fan_out: 0, churn_90d: 0, bug_count: 0 },
    last_changed: "",
  }));
  const controlled = graphSnapshotFromRecords(base.root, base.head, [...base.symbols, ...clones], base.edges, base.components);
  const evaluation = context.evaluate(controlled);
  return receipt(policy, base, {
    kind: "control",
    operator: planned.operator,
    required: planned.required,
    mutated_graph_hash: controlled.graph_hash,
    expected: planned.expected,
    result: evaluation.result,
    passed: evaluation.result === planned.expected,
    parseability: "not_applicable",
    graph_diff: graphDiff(base, controlled),
    evaluation_hash: proofEvaluationHash(evaluation),
  }, context.policy_hash);
}

/** Execute only canonical evaluator/parser mutations. Project scripts, builds,
 * tests, models, and providers are deliberately outside this evidence path. */
export function runMutationHarness(
  root: string,
  policy: PolicySpec,
  base: GraphSnapshot,
  planned: PlannedMutation[],
  opts: { policyHash?: string; mutationPolicy?: PolicySpec; evaluate?: (snapshot: GraphSnapshot) => PolicyEvaluation } = {},
): MutationHarnessResult {
  const context: MutationHarnessContext = {
    policy_hash: opts.policyHash ?? policySemanticHash(policy),
    mutation_policy: opts.mutationPolicy ?? policy,
    evaluate: opts.evaluate ?? ((snapshot) => evaluatePolicyOnSnapshot(policy, snapshot)),
  };
  const receipts: MutationReceipt[] = [];
  const primaryEvaluations: PolicyEvaluation[] = [];
  for (const mutation of planned) {
    if (mutation.operator === "comment-string-control") receipts.push(commentStringControl(policy, base, mutation, context));
    else if (mutation.operator === "same-name-ambiguity-control") receipts.push(sameNameControl(policy, base, mutation, context));
    else {
      const primary = primaryMutation(root, policy, base, mutation, context);
      receipts.push(primary.receipt);
      if (primary.evaluation) primaryEvaluations.push(primary.evaluation);
    }
  }
  return { receipts, primary_evaluations: primaryEvaluations };
}
