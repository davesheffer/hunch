import { pathMatchesGlob } from "../core/glob.js";
import { canonicalHash, canonicalJson, policySemanticHash } from "./canonical.js";
import { PolicyCompositionBindingSchema, type PolicyCompositionBinding, type PolicySpec } from "./schema.js";

function sameValues(left: string[], right: string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function oppositeExceptionAssertions(child: PolicySpec, parent: PolicySpec): boolean {
  const left = child.assertion;
  const right = parent.assertion;
  if (!((left.kind === "reaches" && right.kind === "not-reaches") || (left.kind === "not-reaches" && right.kind === "reaches"))) return false;
  return left.subject.selector === right.subject.selector
    && left.object.selector === right.object.selector
    && canonicalJson(left.relation) === canonicalJson(right.relation);
}

export function exceptionScopeIsNarrower(child: PolicySpec, parent: PolicySpec): boolean {
  const reposInside = !parent.scope.repos.length || child.scope.repos.every((repo) => parent.scope.repos.includes(repo));
  const componentsInside = !parent.scope.components.length || child.scope.components.every((component) => parent.scope.components.includes(component));
  const pathsInside = !parent.scope.paths.length || child.scope.paths.every((path) => parent.scope.paths.some((glob) => path === glob || pathMatchesGlob(path, glob)));
  const strict = !sameValues(child.scope.repos, parent.scope.repos)
    || !sameValues(child.scope.paths, parent.scope.paths)
    || !sameValues(child.scope.components, parent.scope.components);
  return reposInside && componentsInside && pathsInside && strict;
}

export function validateExceptionRelationship(child: PolicySpec, parent: PolicySpec): void {
  if (child.id === parent.id) throw new Error("a policy cannot be its own exception parent");
  if (child.exception_of !== parent.id) throw new Error(`exception policy ${child.id} does not link parent ${parent.id}`);
  if (child.data_class !== parent.data_class) throw new Error("exception and parent must have the same data class");
  if (!oppositeExceptionAssertions(child, parent)) throw new Error("exception must be the exact opposite reaches/not-reaches assertion over the same bindings and relation");
  if (!exceptionScopeIsNarrower(child, parent)) throw new Error("exception scope must be strictly narrower than and contained by its parent scope");
}

/** Return every explicit descendant of a broad root. Parent links define the
 * precedence tree; stable policy-id ordering keeps the binding canonical. */
export function compositionDescendants(root: PolicySpec, policies: PolicySpec[]): PolicySpec[] {
  if (root.exception_of) return [];
  const byParent = new Map<string, PolicySpec[]>();
  for (const policy of policies) {
    if (!policy.exception_of) continue;
    const children = byParent.get(policy.exception_of) ?? [];
    children.push(policy);
    byParent.set(policy.exception_of, children);
  }
  const out: PolicySpec[] = [];
  const visited = new Set([root.id]);
  const queue = [...(byParent.get(root.id) ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  while (queue.length) {
    const policy = queue.shift()!;
    if (visited.has(policy.id)) throw new Error(`exception composition contains a cycle at ${policy.id}`);
    visited.add(policy.id);
    out.push(policy);
    queue.push(...[...(byParent.get(policy.id) ?? [])].sort((a, b) => a.id.localeCompare(b.id)));
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function policyCompositionBinding(root: PolicySpec, members: PolicySpec[]): PolicyCompositionBinding | undefined {
  if (!members.length) return undefined;
  const byId = new Map([root, ...members].map((policy) => [policy.id, policy]));
  if (byId.size !== members.length + 1) throw new Error("exception composition contains duplicate policy ids");
  for (const member of members) {
    const parent = member.exception_of ? byId.get(member.exception_of) : undefined;
    if (!parent) throw new Error(`exception policy ${member.id} has missing composition parent ${member.exception_of ?? "null"}`);
    validateExceptionRelationship(member, parent);
  }
  const body = {
    kind: "parent_with_exceptions" as const,
    root_policy_id: root.id,
    root_policy_hash: policySemanticHash(root),
    members: [...members]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((policy) => ({
        policy_id: policy.id,
        policy_hash: policySemanticHash(policy),
        exception_of: policy.exception_of!,
        scope: policy.scope,
      })),
  };
  return PolicyCompositionBindingSchema.parse({ ...body, composite_hash: canonicalHash(body) });
}

export function policyProofHash(root: PolicySpec, members: PolicySpec[] = []): string {
  return policyCompositionBinding(root, members)?.composite_hash ?? policySemanticHash(root);
}

export function assertCompositionBinding(
  root: PolicySpec,
  members: PolicySpec[],
  binding: PolicyCompositionBinding | undefined,
): void {
  const expected = policyCompositionBinding(root, members);
  if (canonicalJson(expected) !== canonicalJson(binding)) {
    throw new Error(`proof artifacts do not match the current parent/exception composition for policy ${root.id}`);
  }
}
