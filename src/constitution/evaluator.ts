import type { Component, Edge, Symbol } from "../core/types.js";
import { basename } from "node:path";
import { externalImportNodeId, externalPackage } from "../core/externalImports.js";
import { pathMatchesGlob } from "../core/glob.js";
import type { HunchStore } from "../store/hunchStore.js";
import { headSha } from "../extractors/git.js";
import { canonicalHash, proofEvaluationHash } from "./canonical.js";
import { evaluateExecutableBehaviorPolicy, type BehaviorEvaluationOptions } from "./behaviorEvaluator.js";
import { policyCompositionBinding } from "./composition.js";
import {
  POLICY_EVALUATOR,
  PolicyEvaluationSchema,
  type PolicyAssertion,
  type PolicyEvaluation,
  type PolicyRelation,
  type PolicySelector,
  type PolicySpec,
} from "./schema.js";

export interface GraphSnapshot {
  root: string;
  head: string;
  symbols: Symbol[];
  edges: Edge[];
  components: Component[];
  graph_hash: string;
}

interface Binding {
  resolution: "exact" | "ambiguous" | "missing" | "unsupported";
  ids: string[];
  explanation: string;
}

function snapshotHash(symbols: Symbol[], edges: Edge[], components: Component[]): string {
  return canonicalHash({
    symbols: symbols.map((s) => ({ id: s.id, file: s.file, name: s.name, kind: s.kind })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.map((e) => ({ id: e.id, from: e.from, to: e.to, type: e.type })).sort((a, b) => a.id.localeCompare(b.id)),
    components: components.map((c) => ({ id: c.id, name: c.name, kind: c.kind, paths: [...c.paths].sort(), status: c.status })).sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export function graphSnapshotFromRecords(root: string, head: string, symbols: Symbol[], edges: Edge[], components: Component[] = []): GraphSnapshot {
  return { root, head, symbols, edges, components, graph_hash: snapshotHash(symbols, edges, components) };
}

export function graphSnapshot(store: HunchStore, root: string, opts: { publicOnly?: boolean; head?: string } = {}): GraphSnapshot {
  const symbols = opts.publicOnly ? store.json.loadAll("symbols") : store.recs("symbols");
  const edges = opts.publicOnly ? store.json.loadAll("edges") : store.recs("edges");
  const components = opts.publicOnly ? store.json.loadAll("components") : store.recs("components");
  return graphSnapshotFromRecords(root, opts.head ?? (headSha(root) || "working-tree"), symbols, edges, components);
}

function resolveSelector(snapshot: GraphSnapshot, selector: PolicySelector): Binding {
  const raw = selector.selector;
  if (raw.startsWith("external:")) {
    const dependency = externalPackage(raw.slice("external:".length));
    const id = externalImportNodeId(raw.slice("external:".length));
    return dependency && id
      ? { resolution: "exact", ids: [id], explanation: `${raw} resolved to canonical external package ${dependency}` }
      : { resolution: "unsupported", ids: [], explanation: `${raw} is not a supported external package selector` };
  }
  if (raw.startsWith("symbol-id:")) {
    const id = raw.slice("symbol-id:".length);
    const found = snapshot.symbols.some((s) => s.id === id);
    return found
      ? { resolution: "exact", ids: [id], explanation: `${raw} resolved exactly` }
      : { resolution: "missing", ids: [], explanation: `${raw} does not exist in the graph` };
  }
  if (raw.startsWith("symbol:")) {
    const target = raw.slice("symbol:".length);
    const split = target.lastIndexOf(":");
    const matches = split > 0
      ? snapshot.symbols.filter((s) => s.name === target.slice(split + 1) && (s.file === target.slice(0, split) || s.file.endsWith(`/${target.slice(0, split)}`)))
      : snapshot.symbols.filter((s) => s.name === target);
    if (matches.length === 1) return { resolution: "exact", ids: [matches[0]!.id], explanation: `${raw} resolved exactly` };
    if (matches.length > 1) return { resolution: "ambiguous", ids: matches.map((s) => s.id).sort(), explanation: `${raw} resolves to ${matches.length} symbols` };
    return { resolution: "missing", ids: [], explanation: `${raw} does not exist in the graph` };
  }
  if (raw.startsWith("component-id:")) {
    const id = raw.slice("component-id:".length);
    const found = snapshot.components.some((component) => component.id === id);
    return found
      ? { resolution: "exact", ids: [id], explanation: `${raw} resolved exactly` }
      : { resolution: "missing", ids: [], explanation: `${raw} does not exist in the component graph` };
  }
  if (raw.startsWith("component:")) {
    const name = raw.slice("component:".length);
    const matches = snapshot.components.filter((component) => component.name === name);
    if (matches.length === 1) return { resolution: "exact", ids: [matches[0]!.id], explanation: `${raw} resolved exactly` };
    if (matches.length > 1) return { resolution: "ambiguous", ids: matches.map((component) => component.id).sort(), explanation: `${raw} resolves to ${matches.length} components` };
    return { resolution: "missing", ids: [], explanation: `${raw} does not exist in the component graph` };
  }
  return { resolution: "unsupported", ids: [], explanation: `selector form "${raw}" is not supported by evaluator ${POLICY_EVALUATOR.version}` };
}

function adjacency(snapshot: GraphSnapshot, relation: PolicyRelation): Map<string, string[]> {
  const allowed = new Set(relation.edges);
  const out = new Map<string, Set<string>>();
  for (const edge of snapshot.edges) {
    if (!allowed.has(edge.type as "calls" | "imports" | "depends_on")) continue;
    const neighbors = out.get(edge.from) ?? new Set<string>();
    neighbors.add(edge.to);
    out.set(edge.from, neighbors);
  }
  return new Map([...out].map(([id, ids]) => [id, [...ids].sort()]));
}

function findPath(
  snapshot: GraphSnapshot,
  start: string,
  target: string,
  relation: PolicyRelation,
  blocked?: string,
): string[] | null {
  if (blocked === start || blocked === target) return null;
  if (start === target) return [start];
  const graph = adjacency(snapshot, relation);
  const maxDepth = relation.transitive ? relation.max_depth : 1;
  const queue: Array<{ id: string; path: string[] }> = [{ id: start, path: [start] }];
  const seen = new Set([start]);
  while (queue.length) {
    const current = queue.shift()!;
    const depth = current.path.length - 1;
    if (depth >= maxDepth) continue;
    for (const next of graph.get(current.id) ?? []) {
      if (next === blocked || seen.has(next)) continue;
      const path = [...current.path, next];
      if (next === target) return path;
      seen.add(next);
      queue.push({ id: next, path });
    }
  }
  return null;
}

function matchFor(snapshot: GraphSnapshot, id: string, relationPath?: string[]): PolicyEvaluation["matches"][number] {
  const sym = snapshot.symbols.find((s) => s.id === id);
  if (sym) return { file: sym.file, symbol: sym.name, ...(relationPath ? { relation_path: relationPath } : {}) };
  const component = snapshot.components.find((candidate) => candidate.id === id);
  if (component) return { file: component.paths[0] ?? "", symbol: component.name, ...(relationPath ? { relation_path: relationPath } : {}) };
  const edge = snapshot.edges.find((candidate) => candidate.from === id || candidate.to === id);
  const evidence = edge?.provenance.evidence.find((item) => item.includes(":imports:"));
  const file = evidence?.slice(0, evidence.indexOf(":imports:")) ?? "";
  return { file, symbol: id, ...(relationPath ? { relation_path: relationPath } : {}) };
}

function unfinished(policy: PolicySpec, snapshot: GraphSnapshot, result: "unknown" | "error", explanation: string): PolicyEvaluation {
  return finish(policy, snapshot, result, [], explanation);
}

function finish(
  policy: PolicySpec,
  snapshot: GraphSnapshot,
  result: PolicyEvaluation["result"],
  matches: PolicyEvaluation["matches"],
  explanation: string,
): PolicyEvaluation {
  const body = {
    policy_id: policy.id,
    policy_revision: policy.revision,
    result,
    evaluator: { ...POLICY_EVALUATOR },
    repository: { head: snapshot.head, graph_hash: snapshot.graph_hash },
    matches,
    explanation,
    evidence_refs: [...policy.evidence],
  };
  return PolicyEvaluationSchema.parse({ ...body, deterministic_hash: canonicalHash(body) });
}

function requiredBinding(policy: PolicySpec, snapshot: GraphSnapshot, selector: PolicySelector, role: string): Binding | PolicyEvaluation {
  const binding = resolveSelector(snapshot, selector);
  if (binding.resolution === "exact") return binding;
  return unfinished(policy, snapshot, "unknown", `${role} binding is ${binding.resolution}: ${binding.explanation}`);
}

export function evaluatePolicyOnSnapshot(policy: PolicySpec, snapshot: GraphSnapshot): PolicyEvaluation {
  try {
    if (policy.scope.repos.length) {
      const repo = basename(snapshot.root);
      const applicable = policy.scope.repos.some((r) => r === snapshot.root || r === repo || r.endsWith(`/${repo}`));
      if (!applicable) return finish(policy, snapshot, "not_applicable", [], `repository ${repo} is outside the policy scope`);
    }
    const assertion: PolicyAssertion = policy.assertion;
    if (assertion.kind === "executable-behavior") {
      return unfinished(policy, snapshot, "error", "executable-behavior requires an isolated repository checkout, not a graph snapshot");
    }
    const subject = resolveSelector(snapshot, assertion.subject);
    if (assertion.kind === "exists") {
      if (subject.resolution === "exact") {
        return finish(policy, snapshot, "satisfied", [matchFor(snapshot, subject.ids[0]!)], `${assertion.subject.selector} exists exactly once`);
      }
      if (subject.resolution === "missing") {
        return finish(policy, snapshot, "violated", [], `${assertion.subject.selector} does not exist in the graph`);
      }
      return unfinished(policy, snapshot, "unknown", `subject binding is ${subject.resolution}: ${subject.explanation}`);
    }

    const subjectExact = requiredBinding(policy, snapshot, assertion.subject, "subject");
    if ("result" in subjectExact) return subjectExact;
    const objectExact = requiredBinding(policy, snapshot, assertion.object, "object");
    if ("result" in objectExact) return objectExact;
    const subjectId = subjectExact.ids[0]!;
    const objectId = objectExact.ids[0]!;

    if (assertion.kind === "must-pass-through") {
      const viaExact = requiredBinding(policy, snapshot, assertion.via, "via");
      if ("result" in viaExact) return viaExact;
      const viaId = viaExact.ids[0]!;
      if (viaId === subjectId || viaId === objectId) {
        return unfinished(policy, snapshot, "error", "must-pass-through requires three distinct bindings");
      }
      const anyPath = findPath(snapshot, subjectId, objectId, assertion.relation);
      if (!anyPath) {
        return finish(policy, snapshot, "satisfied", [matchFor(snapshot, subjectId)], `${assertion.subject.selector} does not reach ${assertion.object.selector}; no bypass exists`);
      }
      const bypass = findPath(snapshot, subjectId, objectId, assertion.relation, viaId);
      if (bypass) {
        return finish(
          policy,
          snapshot,
          "violated",
          [matchFor(snapshot, subjectId, bypass)],
          `${assertion.subject.selector} reaches ${assertion.object.selector} without passing through ${assertion.via.selector}`,
        );
      }
      return finish(
        policy,
        snapshot,
        "satisfied",
        [matchFor(snapshot, subjectId, anyPath)],
        `every discovered path from ${assertion.subject.selector} to ${assertion.object.selector} passes through ${assertion.via.selector}`,
      );
    }

    const path = findPath(snapshot, subjectId, objectId, assertion.relation);
    const reaches = !!path;
    const satisfied = assertion.kind === "reaches" ? reaches : !reaches;
    const result = satisfied ? "satisfied" : "violated";
    const explanation = assertion.kind === "reaches"
      ? reaches
        ? `${assertion.subject.selector} reaches ${assertion.object.selector}`
        : `${assertion.subject.selector} does not reach ${assertion.object.selector}`
      : reaches
        ? `${assertion.subject.selector} reaches forbidden target ${assertion.object.selector}`
        : `${assertion.subject.selector} does not reach ${assertion.object.selector}`;
    return finish(policy, snapshot, result, [matchFor(snapshot, subjectId, path ?? undefined)], explanation);
  } catch (e) {
    return unfinished(policy, snapshot, "error", `deterministic evaluator failed: ${(e as Error).message}`);
  }
}

type ScopeApplicability = { kind: "applicable" | "not_applicable" | "unknown"; explanation: string };

function scopeApplicability(policy: PolicySpec, snapshot: GraphSnapshot): ScopeApplicability {
  if (policy.scope.repos.length) {
    const repo = basename(snapshot.root);
    const applies = policy.scope.repos.some((candidate) => candidate === snapshot.root || candidate === repo || candidate.endsWith(`/${repo}`));
    if (!applies) return { kind: "not_applicable", explanation: `repository ${repo} is outside ${policy.id} scope` };
  }
  if (policy.assertion.kind === "executable-behavior") return { kind: "applicable", explanation: "executable behavior repository scope applies" };
  const subject = resolveSelector(snapshot, policy.assertion.subject);
  if (subject.resolution !== "exact") {
    return { kind: "unknown", explanation: `cannot choose scoped policy ${policy.id}: subject binding is ${subject.resolution}` };
  }
  const id = subject.ids[0]!;
  const symbol = snapshot.symbols.find((candidate) => candidate.id === id);
  const component = snapshot.components.find((candidate) => candidate.id === id);
  if (policy.scope.paths.length) {
    if (symbol) {
      if (!policy.scope.paths.some((glob) => pathMatchesGlob(symbol.file, glob))) {
        return { kind: "not_applicable", explanation: `${symbol.file} is outside ${policy.id} path scope` };
      }
    } else if (component) {
      const concrete = component.paths.filter((path) => !/[*?]/.test(path));
      if (!concrete.length) {
        return { kind: "unknown", explanation: `component ${component.id} has no concrete path binding for ${policy.id} scope precedence` };
      }
      if (!concrete.some((path) => policy.scope.paths.some((glob) => pathMatchesGlob(path, glob)))) {
        return { kind: "not_applicable", explanation: `component ${component.id} is outside ${policy.id} path scope` };
      }
    } else {
      return { kind: "unknown", explanation: `subject ${id} has no concrete file binding for ${policy.id} path scope` };
    }
  }
  if (policy.scope.components.length) {
    const subjectComponents = component
      ? [component.id]
      : symbol
        ? snapshot.components.filter((candidate) => candidate.paths.some((glob) => pathMatchesGlob(symbol.file, glob))).map((candidate) => candidate.id)
        : [];
    if (!subjectComponents.length) {
      return { kind: "unknown", explanation: `subject ${id} has no exact component binding for ${policy.id} scope precedence` };
    }
    if (!subjectComponents.some((candidate) => policy.scope.components.includes(candidate))) {
      return { kind: "not_applicable", explanation: `subject ${id} is outside ${policy.id} component scope` };
    }
  }
  return { kind: "applicable", explanation: `${policy.id} scope applies to the exact subject binding` };
}

interface CompositionSelection {
  binding: NonNullable<ReturnType<typeof policyCompositionBinding>>;
  evaluations: Map<string, PolicyEvaluation>;
  applicable: PolicySpec[];
  selected: PolicySpec;
}

class CompositionOutcome extends Error {
  constructor(readonly result: "not_applicable" | "unknown", message: string) {
    super(message);
  }
}

function compositionSelection(root: PolicySpec, members: PolicySpec[], snapshot: GraphSnapshot): CompositionSelection {
  const binding = policyCompositionBinding(root, members);
  if (!binding) throw new Error(`policy ${root.id} has no exception members to compose`);
  const policies = [root, ...members];
  const byId = new Map(policies.map((policy) => [policy.id, policy]));
  const evaluations = new Map(policies.map((policy) => [policy.id, evaluatePolicyOnSnapshot(policy, snapshot)]));
  const rootScope = scopeApplicability(root, snapshot);
  if (rootScope.kind !== "applicable") throw new CompositionOutcome(rootScope.kind, rootScope.explanation);
  const depth = (policy: PolicySpec): number => {
    let current = policy;
    let value = 0;
    const visited = new Set<string>();
    while (current.exception_of) {
      if (visited.has(current.id)) throw new Error(`exception composition contains a cycle at ${current.id}`);
      visited.add(current.id);
      const parent = byId.get(current.exception_of);
      if (!parent) throw new Error(`exception policy ${current.id} has missing composition parent ${current.exception_of}`);
      current = parent;
      value++;
    }
    if (current.id !== root.id) throw new Error(`exception policy ${policy.id} is not rooted at ${root.id}`);
    return value;
  };
  const applicable = [root];
  const applicableIds = new Set([root.id]);
  for (const member of [...members].sort((left, right) => depth(left) - depth(right) || left.id.localeCompare(right.id))) {
    if (!member.exception_of || !applicableIds.has(member.exception_of)) continue;
    const scope = scopeApplicability(member, snapshot);
    if (scope.kind === "unknown") throw new CompositionOutcome("unknown", scope.explanation);
    if (scope.kind === "applicable") {
      applicable.push(member);
      applicableIds.add(member.id);
    }
  }
  const maxDepth = Math.max(...applicable.map(depth));
  const deepest = applicable.filter((policy) => depth(policy) === maxDepth).sort((a, b) => a.id.localeCompare(b.id));
  const results = new Set(deepest.map((policy) => evaluations.get(policy.id)!.result));
  if (results.size !== 1) throw new Error(`equally specific exception policies disagree: ${deepest.map((policy) => policy.id).join(", ")}`);
  return { binding, evaluations, applicable, selected: deepest[0]! };
}

export function selectedPolicyForComposition(root: PolicySpec, members: PolicySpec[], snapshot: GraphSnapshot): PolicySpec {
  return compositionSelection(root, members, snapshot).selected;
}

/** Evaluate explicit scope precedence as one receipt. The deepest applicable
 * linked exception wins; severity and adapter order never participate. */
export function evaluateCompositePolicyOnSnapshot(root: PolicySpec, members: PolicySpec[], snapshot: GraphSnapshot): PolicyEvaluation {
  try {
    const selection = compositionSelection(root, members, snapshot);
    const selectedEvaluation = selection.evaluations.get(selection.selected.id)!;
    const memberHashes = Object.fromEntries(
      [root, ...members]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((policy) => [policy.id, proofEvaluationHash(selection.evaluations.get(policy.id)!)]),
    );
    const composition = {
      ...selection.binding,
      selected_policy_id: selection.selected.id,
      applicable_policy_ids: selection.applicable.map((policy) => policy.id),
      member_evaluation_hashes: memberHashes,
    };
    const body = {
      policy_id: root.id,
      policy_revision: root.revision,
      result: selectedEvaluation.result,
      evaluator: { ...POLICY_EVALUATOR },
      repository: { head: snapshot.head, graph_hash: snapshot.graph_hash },
      matches: selectedEvaluation.matches,
      explanation: `composite scope selected ${selection.selected.id}: ${selectedEvaluation.explanation}`,
      evidence_refs: [...new Set([root, ...members].flatMap((policy) => policy.evidence))].sort(),
      composition,
    };
    return PolicyEvaluationSchema.parse({ ...body, deterministic_hash: canonicalHash(body) });
  } catch (error) {
    const result = error instanceof CompositionOutcome ? error.result : "error";
    return finish(root, snapshot, result, [], `parent/exception composition failed: ${(error as Error).message}`);
  }
}

export function evaluatePolicy(
  store: HunchStore,
  root: string,
  policy: PolicySpec,
  opts: { publicOnly?: boolean; composition?: PolicySpec[]; behavior?: BehaviorEvaluationOptions } = {},
): PolicyEvaluation {
  if (policy.assertion.kind === "executable-behavior") {
    if (opts.composition?.length) throw new Error("executable-behavior policies cannot participate in parent/exception composition");
    return evaluateExecutableBehaviorPolicy(root, policy, opts.behavior);
  }
  const snapshot = graphSnapshot(store, root, opts);
  return opts.composition?.length
    ? evaluateCompositePolicyOnSnapshot(policy, opts.composition, snapshot)
    : evaluatePolicyOnSnapshot(policy, snapshot);
}

export function policyIsActive(policy: PolicySpec): boolean {
  return policy.state === "active_advisory" || policy.state === "active_blocking";
}

export function policyBlocks(policy: PolicySpec, evaluation: PolicyEvaluation): boolean {
  return policy.state === "active_blocking"
    && !policy.exception_of
    && policy.severity === "blocking"
    && policy.authority?.kind === "human"
    && evaluation.result === "violated";
}

export function mutationOperatorForPolicy(policy: PolicySpec): string {
  if (policy.assertion.kind === "executable-behavior") return "known-bad-regression";
  if (policy.assertion.kind === "exists") return "delete-required-symbol";
  if (policy.assertion.kind === "reaches") return "remove-required-path";
  if (policy.assertion.kind === "must-pass-through") return "add-bypass-edge";
  if (policy.assertion.relation.edges.length === 1
    && policy.assertion.relation.edges[0] === "imports"
    && policy.assertion.object.selector.startsWith("external:")) return "add-forbidden-import";
  return "add-forbidden-edge";
}

export function mutateSnapshotForPolicy(
  policy: PolicySpec,
  snapshot: GraphSnapshot,
): { snapshot: GraphSnapshot; operator: string } | null {
  const assertion = policy.assertion;
  if (assertion.kind === "executable-behavior") return null;
  const subject = resolveSelector(snapshot, assertion.subject);
  if (subject.resolution !== "exact") return null;
  const subjectId = subject.ids[0]!;
  let symbols = [...snapshot.symbols];
  let edges = [...snapshot.edges];
  let operator = "";

  if (assertion.kind === "exists") {
    symbols = symbols.filter((s) => s.id !== subjectId);
    edges = edges.filter((e) => e.from !== subjectId && e.to !== subjectId);
    operator = mutationOperatorForPolicy(policy);
  } else {
    const object = resolveSelector(snapshot, assertion.object);
    if (object.resolution !== "exact") return null;
    const objectId = object.ids[0]!;
    if (assertion.kind === "reaches") {
      const allowed = new Set(assertion.relation.edges);
      edges = edges.filter((e) => e.from !== subjectId || !allowed.has(e.type as "calls" | "imports" | "depends_on"));
      operator = mutationOperatorForPolicy(policy);
    } else {
      edges.push({
        id: `edge_policy_mutation_${policy.id}`,
        from: subjectId,
        to: objectId,
        type: assertion.relation.edges[0]!,
        reason: "deterministic proof mutation",
        strength: 1,
        provenance: { source: "derived", confidence: 1, evidence: [policy.id] },
      });
      operator = mutationOperatorForPolicy(policy);
    }
  }

  return {
    operator,
    snapshot: {
      ...snapshot,
      symbols,
      edges,
      graph_hash: snapshotHash(symbols, edges, snapshot.components),
      components: snapshot.components,
    },
  };
}
