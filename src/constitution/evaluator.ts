import type { Edge, Symbol } from "../core/types.js";
import { basename } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import { headSha } from "../extractors/git.js";
import { canonicalHash } from "./canonical.js";
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
  graph_hash: string;
}

interface Binding {
  resolution: "exact" | "ambiguous" | "missing" | "unsupported";
  ids: string[];
  explanation: string;
}

function snapshotHash(symbols: Symbol[], edges: Edge[]): string {
  return canonicalHash({
    symbols: symbols.map((s) => ({ id: s.id, file: s.file, name: s.name, kind: s.kind })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.map((e) => ({ id: e.id, from: e.from, to: e.to, type: e.type })).sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export function graphSnapshot(store: HunchStore, root: string, opts: { publicOnly?: boolean } = {}): GraphSnapshot {
  const symbols = opts.publicOnly ? store.json.loadAll("symbols") : store.recs("symbols");
  const edges = opts.publicOnly ? store.json.loadAll("edges") : store.recs("edges");
  return {
    root,
    head: headSha(root) || "working-tree",
    symbols,
    edges,
    graph_hash: snapshotHash(symbols, edges),
  };
}

function resolveSelector(snapshot: GraphSnapshot, selector: PolicySelector): Binding {
  const raw = selector.selector;
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
  return { file: sym?.file ?? "", symbol: sym?.name ?? id, ...(relationPath ? { relation_path: relationPath } : {}) };
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

export function evaluatePolicy(store: HunchStore, root: string, policy: PolicySpec, opts: { publicOnly?: boolean } = {}): PolicyEvaluation {
  return evaluatePolicyOnSnapshot(policy, graphSnapshot(store, root, opts));
}

export function policyIsActive(policy: PolicySpec): boolean {
  return policy.state === "active_advisory" || policy.state === "active_blocking";
}

export function policyBlocks(policy: PolicySpec, evaluation: PolicyEvaluation): boolean {
  return policy.state === "active_blocking"
    && policy.severity === "blocking"
    && policy.authority?.kind === "human"
    && evaluation.result === "violated";
}

export function mutateSnapshotForPolicy(
  policy: PolicySpec,
  snapshot: GraphSnapshot,
): { snapshot: GraphSnapshot; operator: string } | null {
  const assertion = policy.assertion;
  const subject = resolveSelector(snapshot, assertion.subject);
  if (subject.resolution !== "exact") return null;
  const subjectId = subject.ids[0]!;
  let symbols = [...snapshot.symbols];
  let edges = [...snapshot.edges];
  let operator = "";

  if (assertion.kind === "exists") {
    symbols = symbols.filter((s) => s.id !== subjectId);
    edges = edges.filter((e) => e.from !== subjectId && e.to !== subjectId);
    operator = "delete-required-symbol";
  } else {
    const object = resolveSelector(snapshot, assertion.object);
    if (object.resolution !== "exact") return null;
    const objectId = object.ids[0]!;
    if (assertion.kind === "reaches") {
      const allowed = new Set(assertion.relation.edges);
      edges = edges.filter((e) => e.from !== subjectId || !allowed.has(e.type as "calls" | "imports" | "depends_on"));
      operator = "remove-required-path";
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
      operator = assertion.kind === "must-pass-through" ? "add-bypass-edge" : "add-forbidden-edge";
    }
  }

  return {
    operator,
    snapshot: {
      ...snapshot,
      symbols,
      edges,
      graph_hash: snapshotHash(symbols, edges),
    },
  };
}
