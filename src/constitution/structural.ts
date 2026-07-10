import { basename } from "node:path";
import { externalImportNodeId, externalPackage } from "../core/externalImports.js";
import { pathMatchesGlob } from "../core/glob.js";
import { shortHash } from "../core/ids.js";
import { resolveRelativeImport } from "../core/relativeImports.js";
import type { Component, Decision, Edge, Symbol } from "../core/types.js";
import { commitMeta, type CommitMeta } from "../extractors/git.js";
import type { HunchStore } from "../store/hunchStore.js";
import { canonicalHash } from "./canonical.js";
import { clampCandidateLimit, durationCutoff, type BootstrapOptions, type BootstrapReport } from "./bootstrap.js";
import { compileStructuralPolicy } from "./compiler.js";
import { extractStructuralDelta } from "./delta.js";
import type { PolicyRepository } from "./repository.js";
import {
  EvidenceEventSchema,
  PolicySpecSchema,
  type DataClass,
  type CandidateContext,
  type CandidateAlternative,
  type EvidenceEvent,
  type PolicyAssertion,
  type PolicySpec,
  type StructuralCallRef,
  type StructuralDelta,
  type StructuralSymbolRef,
} from "./schema.js";

export interface StructuralCandidate {
  id: string;
  assertion: PolicyAssertion;
  scope: PolicySpec["scope"];
  basis: "added-call" | "removed-call" | "added-symbol" | "removed-import" | "added-relative-import" | "removed-relative-import";
  reason: string;
}

export interface StructuralInspection {
  decision: string;
  commit: string;
  kind: "revert" | "bug_fix" | "decision";
  delta: StructuralDelta;
  candidates: StructuralCandidate[];
  unsupported: string[];
  private: boolean;
}

interface Enumerated {
  candidates: StructuralCandidate[];
  unsupported: string[];
}

const exactSelector = (symbol: Symbol): { selector: string } => ({ selector: `symbol:${symbol.file}:${symbol.name}` });

function scopeFor(store: HunchStore, file: string, publicOnly: boolean): PolicySpec["scope"] {
  const components = (publicOnly ? store.json.loadAll("components") : store.recs("components"))
    .filter((c) => c.paths.some((glob) => pathMatchesGlob(file, glob)))
    .map((c) => c.id)
    .sort();
  return { repos: [], paths: [file], components };
}

function candidateId(assertion: PolicyAssertion, scope: PolicySpec["scope"]): string {
  return `cand_${shortHash(canonicalHash({ assertion, scope }))}`;
}

function alternativeFor(candidate: StructuralCandidate): CandidateAlternative {
  return {
    id: candidate.id,
    basis: candidate.basis,
    reason: candidate.reason,
    assertion_hash: canonicalHash(candidate.assertion),
  };
}

function candidateContext(
  enumerated: Enumerated,
  selected?: StructuralCandidate,
  conflicts: string[] = [],
  incumbent: string | null = null,
  scopeSuggestion: PolicySpec["scope"] | null = null,
  counterexamples: string[] = [],
): CandidateContext {
  const alternatives = enumerated.candidates.map(alternativeFor).sort((left, right) => {
    if (selected && left.id === selected.id) return -1;
    if (selected && right.id === selected.id) return 1;
    return left.id.localeCompare(right.id);
  });
  return {
    alternatives,
    uncertainty: [...new Set(enumerated.unsupported)].sort(),
    conflicts: [...new Set(conflicts)].sort(),
    incumbent,
    scope_suggestion: scopeSuggestion,
    counterexamples: [...new Set(counterexamples)].sort(),
  };
}

function structuralKey(policy: Pick<PolicySpec, "assertion" | "scope" | "data_class">): string {
  return canonicalHash({ assertion: policy.assertion, scope: policy.scope, data_class: policy.data_class });
}

function scopesOverlap(left: PolicySpec["scope"], right: PolicySpec["scope"]): boolean {
  const repoOverlap = !left.repos.length || !right.repos.length || left.repos.some((repo) => right.repos.includes(repo));
  const pathOverlap = !left.paths.length || !right.paths.length || left.paths.some((path) => right.paths.includes(path));
  const componentOverlap = !left.components.length || !right.components.length || left.components.some((component) => right.components.includes(component));
  return repoOverlap && pathOverlap && componentOverlap;
}

function directConflict(candidate: PolicySpec, incumbent: PolicySpec): boolean {
  const left = candidate.assertion;
  const right = incumbent.assertion;
  if (!((left.kind === "reaches" && right.kind === "not-reaches") || (left.kind === "not-reaches" && right.kind === "reaches"))) return false;
  return left.subject.selector === right.subject.selector
    && left.object.selector === right.object.selector
    && canonicalHash(left.relation) === canonicalHash(right.relation)
    && scopesOverlap(candidate.scope, incumbent.scope);
}

function counterexampleSignals(store: HunchStore, candidate: StructuralCandidate, publicOnly: boolean): string[] {
  const assertion = candidate.assertion;
  if (assertion.kind === "exists" || assertion.relation.transitive) return [];
  const parseSymbol = (raw: string): { file: string; name: string } | null => {
    if (!raw.startsWith("symbol:")) return null;
    const target = raw.slice("symbol:".length);
    const split = target.lastIndexOf(":");
    return split > 0 ? { file: target.slice(0, split), name: target.slice(split + 1) } : null;
  };
  const subject = parseSymbol(assertion.subject.selector);
  const object = parseSymbol(assertion.object.selector);
  if (!subject || !object) return [];
  const symbols = publicOnly ? store.json.loadAll("symbols") : store.recs("symbols");
  const edges = publicOnly ? store.json.loadAll("edges") : store.recs("edges");
  const objectMatches = symbols.filter((symbol) => symbol.file === object.file && symbol.name === object.name);
  if (objectMatches.length !== 1) return [];
  const objectId = objectMatches[0]!.id;
  const allowed = new Set(assertion.relation.edges);
  return symbols
    .filter((symbol) => symbol.name === subject.name && symbol.file !== subject.file && !candidate.scope.paths.includes(symbol.file))
    .flatMap((symbol) => {
      const reaches = edges.some((edge) => edge.from === symbol.id && edge.to === objectId && allowed.has(edge.type as "calls" | "imports" | "depends_on" | "contains"));
      const contradictsBroadening = assertion.kind === "reaches" ? !reaches : reaches;
      if (!contradictsBroadening) return [];
      return [`${symbol.file}:${symbol.name} is a counterexample outside the narrow scope: it ${reaches ? "does" : "does not"} satisfy ${assertion.kind} ${assertion.object.selector}`];
    })
    .sort()
    .slice(0, 10);
}

function commonPathGlob(paths: string[]): string | null {
  const unique = [...new Set(paths)].sort();
  if (unique.length < 3) return null;
  const directories = unique.map((path) => path.split("/").slice(0, -1));
  const common: string[] = [];
  for (let index = 0; ; index++) {
    const segment = directories[0]?.[index];
    if (!segment || directories.some((parts) => parts[index] !== segment)) break;
    common.push(segment);
  }
  return common.length ? `${common.join("/")}/**` : null;
}

/** Repetition may suggest a broader review scope but never mutates the compiled
 * scope. Three independently grounded component-policy sources are required. */
function repeatedScopeSuggestion(candidate: PolicySpec, policies: PolicySpec[]): PolicySpec["scope"] | null {
  if (candidate.assertion.kind === "exists" || !candidate.assertion.subject.selector.startsWith("component")) return null;
  const assertionHash = canonicalHash(candidate.assertion);
  const related = [...policies, candidate].filter((policy) => policy.data_class === candidate.data_class && canonicalHash(policy.assertion) === assertionHash);
  const sources = new Set(related.flatMap((policy) => policy.legacy_refs.filter((ref) => ref.startsWith("dec_"))));
  const paths = related.flatMap((policy) => policy.scope.paths);
  const path = commonPathGlob(paths);
  if (sources.size < 3 || !path) return null;
  const repoShapes = new Set(related.map((policy) => canonicalHash([...policy.scope.repos].sort())));
  if (repoShapes.size !== 1) return null;
  return {
    repos: [...candidate.scope.repos].sort(),
    paths: [path],
    components: [...new Set(related.flatMap((policy) => policy.scope.components))].sort(),
  };
}

function enrichIncumbent(
  repository: PolicyRepository,
  incumbent: PolicySpec,
  incoming: PolicySpec,
  context: CandidateContext,
  now: string,
  isPrivate: boolean,
): PolicySpec {
  const evidence = [...new Set([...incumbent.evidence, ...incoming.evidence])].sort();
  const legacyRefs = [...new Set([...incumbent.legacy_refs, ...incoming.legacy_refs])].sort();
  const alternatives = [...new Map([...incumbent.candidate.alternatives, ...context.alternatives].map((alternative) => [alternative.id, alternative])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const candidate: CandidateContext = {
    alternatives,
    uncertainty: [...new Set([...incumbent.candidate.uncertainty, ...context.uncertainty])].sort(),
    conflicts: [...new Set([...incumbent.candidate.conflicts, ...context.conflicts])].sort(),
    incumbent: incumbent.id,
    scope_suggestion: context.scope_suggestion ?? incumbent.candidate.scope_suggestion,
    counterexamples: [...new Set([...incumbent.candidate.counterexamples, ...context.counterexamples])].sort(),
  };
  if (canonicalHash({ evidence, legacyRefs, candidate }) === canonicalHash({ evidence: incumbent.evidence, legacyRefs: incumbent.legacy_refs, candidate: incumbent.candidate })) return incumbent;
  const enriched = PolicySpecSchema.parse({
    ...incumbent,
    revision: incumbent.revision + 1,
    evidence,
    legacy_refs: legacyRefs,
    candidate,
    updated_at: now,
    audit: [...incumbent.audit, {
      action: "enriched",
      actor_kind: "system",
      actor: "hunch:structural-delta-compiler",
      at: now,
      reason: `Linked equivalent evidence without changing assertion, scope, proof, lifecycle, or authority.`,
      proof: incumbent.proof,
    }],
  });
  return repository.putPolicy(enriched, { private: isPrivate });
}

function judgmentNames(source: Decision | undefined, identifier: string): boolean {
  if (!source) return true;
  const text = [
    source.title,
    source.context,
    source.decision,
    ...source.consequences,
    ...source.alternatives_rejected,
  ].join("\n");
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`, "i").test(text);
}

/** Enumerate every supported assertion that the current graph can bind exactly.
 * Ambiguous or missing bindings are reported; they are never guessed through. */
export function enumerateStructuralCandidates(
  store: HunchStore,
  delta: StructuralDelta,
  opts: { publicOnly?: boolean; judgment?: Decision; retiredDependenciesOnly?: boolean } = {},
): Enumerated {
  const symbols = opts.publicOnly ? store.json.loadAll("symbols") : store.recs("symbols");
  const edges = opts.publicOnly ? store.json.loadAll("edges") : store.recs("edges");
  const components = opts.publicOnly ? store.json.loadAll("components") : store.recs("components");
  const callsFrom = new Map<string, Set<string>>();
  for (const edge of edges.filter((e: Edge) => e.type === "calls")) {
    const targets = callsFrom.get(edge.from) ?? new Set<string>();
    targets.add(edge.to);
    callsFrom.set(edge.from, targets);
  }
  const candidates: StructuralCandidate[] = [];
  const unsupported: string[] = [];
  const files = new Set(symbols.map((symbol) => symbol.file));

  const componentForFile = (file: string, role: string): Component | null => {
    const matches = components.filter((component) => component.paths.some((glob) => pathMatchesGlob(file, glob)));
    if (matches.length !== 1) {
      unsupported.push(`${role} file ${file} maps to ${matches.length ? `${matches.length} components` : "no component"}`);
      return null;
    }
    return matches[0]!;
  };

  const subjectFor = (file: string, name: string): Symbol | null => {
    const matches = symbols.filter((s) => s.file === file && s.name === name);
    if (matches.length !== 1) {
      unsupported.push(`${file}:${name} subject is ${matches.length ? "ambiguous" : "missing"} in the current graph`);
      return null;
    }
    return matches[0]!;
  };

  const anchorForFile = (file: string): Symbol | null => {
    const added = new Set(delta.symbols.added.map((symbol) => `${symbol.file}\0${symbol.kind}\0${symbol.name}`));
    const matches = symbols
      .filter((symbol) => symbol.file === file && !added.has(`${symbol.file}\0${symbol.kind}\0${symbol.name}`))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!matches.length) unsupported.push(`${file} has no symbol present before and after the delta to anchor a file-scoped import policy`);
    return matches[0] ?? null;
  };

  const addCallCandidate = (call: StructuralCallRef, basis: "added-call" | "removed-call"): void => {
    if (!judgmentNames(opts.judgment, call.caller) && !judgmentNames(opts.judgment, call.callee)) {
      unsupported.push(`${call.file}:${call.caller} -> ${call.callee} is structural coincidence not explicitly named by the human judgment`);
      return;
    }
    const subject = subjectFor(call.file, call.caller);
    if (!subject) return;
    const namedTargets = symbols.filter((s) => s.name === call.callee && s.id !== subject.id);
    const currentTargets = callsFrom.get(subject.id) ?? new Set<string>();
    if (basis === "removed-call" && namedTargets.length !== 1) {
      unsupported.push(`${call.file}:${call.caller} -> ${call.callee} removed-call target is ${namedTargets.length ? "ambiguous" : "missing"}`);
      return;
    }
    // A present current edge can disambiguate an added call. A removed edge has
    // no current edge to identify its historical target, so duplicate names
    // must remain ambiguous instead of selecting whichever target is unlinked.
    const matches = basis === "added-call"
      ? namedTargets.filter((s) => currentTargets.has(s.id))
      : !currentTargets.has(namedTargets[0]!.id)
        ? namedTargets
        : [];
    if (matches.length !== 1) {
      unsupported.push(`${call.file}:${call.caller} -> ${call.callee} ${basis} target is ${matches.length ? "ambiguous" : "not exactly bindable"}`);
      return;
    }
    const assertion: PolicyAssertion = {
      kind: basis === "added-call" ? "reaches" : "not-reaches",
      subject: exactSelector(subject),
      relation: { edges: ["calls"], transitive: false, max_depth: 1 },
      object: exactSelector(matches[0]!),
    };
    const scope = scopeFor(store, call.file, !!opts.publicOnly);
    candidates.push({
      id: candidateId(assertion, scope),
      assertion,
      scope,
      basis,
      reason: basis === "added-call"
        ? `fix/revert added exact current call ${call.caller} -> ${call.callee}`
        : `fix/revert removed exact call ${call.caller} -> ${call.callee}`,
    });
  };

  for (const call of delta.calls.added) addCallCandidate(call, "added-call");
  for (const call of delta.calls.removed) addCallCandidate(call, "removed-call");

  for (const added of delta.symbols.added) {
    if (!judgmentNames(opts.judgment, added.name)) {
      unsupported.push(`added symbol ${added.file}:${added.name} is not explicitly named by the human judgment`);
      continue;
    }
    const subject = subjectFor(added.file, added.name);
    if (!subject) continue;
    const assertion: PolicyAssertion = { kind: "exists", subject: exactSelector(subject) };
    const scope = scopeFor(store, added.file, !!opts.publicOnly);
    candidates.push({
      id: candidateId(assertion, scope), assertion, scope, basis: "added-symbol",
      reason: `fix/revert introduced exact current symbol ${added.file}:${added.name}`,
    });
  }

  for (const removed of delta.symbols.removed) unsupported.push(`removed symbol ${removed.file}:${removed.name} has no enforceable current binding`);
  for (const moved of delta.symbols.moved) unsupported.push(`moved symbol ${moved.from}:${moved.name} -> ${moved.to} needs repair semantics, not a new policy`);
  const addRelativeImportCandidate = (
    ref: StructuralDelta["imports"]["added"][number],
    basis: "added-relative-import" | "removed-relative-import",
  ): void => {
    const resolved = resolveRelativeImport(ref.file, ref.specifier, files);
    if (resolved.matches.length !== 1 || !resolved.path) {
      unsupported.push(`relative import ${ref.file}:${ref.specifier} target is ${resolved.matches.length ? "ambiguous" : "missing"} in the current graph`);
      return;
    }
    const from = componentForFile(ref.file, "source");
    const to = componentForFile(resolved.path, "target");
    if (!from || !to) return;
    if (from.id === to.id) {
      unsupported.push(`relative import ${ref.file}:${ref.specifier} stays inside component ${from.name}; the component evaluator cannot represent an internal file edge`);
      return;
    }
    const relationNamed = judgmentNames(opts.judgment, ref.specifier)
      || (judgmentNames(opts.judgment, from.name) && judgmentNames(opts.judgment, to.name));
    if (!relationNamed) {
      unsupported.push(`relative import ${from.name} -> ${to.name} is structural coincidence not explicitly named by the human judgment`);
      return;
    }
    const currentEdge = edges.some((edge) => edge.type === "depends_on" && edge.from === from.id && edge.to === to.id);
    if (basis === "added-relative-import" && !currentEdge) {
      unsupported.push(`added relative import ${from.name} -> ${to.name} has no exact current component edge`);
      return;
    }
    if (basis === "removed-relative-import" && currentEdge) {
      unsupported.push(`removed relative import ${from.name} -> ${to.name} leaves the component dependency present through another import`);
      return;
    }
    const assertion: PolicyAssertion = {
      kind: basis === "added-relative-import" ? "reaches" : "not-reaches",
      subject: { selector: `component-id:${from.id}` },
      relation: { edges: ["depends_on"], transitive: false, max_depth: 1 },
      object: { selector: `component-id:${to.id}` },
    };
    const scope = { repos: [], paths: [ref.file], components: [from.id, to.id].sort() };
    candidates.push({
      id: candidateId(assertion, scope),
      assertion,
      scope,
      basis,
      reason: basis === "added-relative-import"
        ? `fix/revert added exact relative component dependency ${from.name} -> ${to.name}`
        : `fix/revert removed exact relative component dependency ${from.name} -> ${to.name}`,
    });
  };

  for (const added of delta.imports.added) {
    if (externalPackage(added.specifier)) unsupported.push(`added external import ${added.file}:${added.specifier} awaits an import assertion evaluator for positive package requirements`);
    else addRelativeImportCandidate(added, "added-relative-import");
  }
  for (const removed of delta.imports.removed) {
    const dependency = externalPackage(removed.specifier);
    const external = externalImportNodeId(removed.specifier);
    if (!dependency || !external) {
      addRelativeImportCandidate(removed, "removed-relative-import");
      continue;
    }
    if (!judgmentNames(opts.judgment, dependency) && !judgmentNames(opts.judgment, removed.specifier)) {
      unsupported.push(`removed external import ${removed.file}:${dependency} is not explicitly named by the human judgment`);
      continue;
    }
    if (opts.judgment?.retired.deps.length
      && !opts.judgment.retired.deps.some((specifier) => externalPackage(specifier) === dependency)) {
      unsupported.push(`removed external import ${removed.file}:${dependency} is not listed in the human judgment's retired dependencies`);
      continue;
    }
    const subject = anchorForFile(removed.file);
    if (!subject) continue;
    if (edges.some((edge) => edge.type === "imports" && edge.from === subject.id && edge.to === external)) {
      unsupported.push(`removed external import ${removed.file}:${dependency} remains present through another package subpath`);
      continue;
    }
    const assertion: PolicyAssertion = {
      kind: "not-reaches",
      subject: exactSelector(subject),
      relation: { edges: ["imports"], transitive: false, max_depth: 1 },
      object: { selector: `external:${dependency}` },
    };
    const scope = scopeFor(store, removed.file, !!opts.publicOnly);
    candidates.push({
      id: candidateId(assertion, scope), assertion, scope, basis: "removed-import",
      reason: `fix/revert removed human-named external package ${dependency} from ${removed.file}`,
    });
  }

  const eligibleCandidates = opts.retiredDependenciesOnly
    ? candidates.filter((candidate) => candidate.basis === "removed-import")
    : candidates;
  if (opts.retiredDependenciesOnly && eligibleCandidates.length !== candidates.length) {
    unsupported.push(`${candidates.length - eligibleCandidates.length} call/symbol candidate(s) excluded because the human judgment's structured signal is dependency retirement`);
  }
  const unique = new Map(eligibleCandidates.map((c) => [canonicalHash({ assertion: c.assertion, scope: c.scope }), c]));
  return {
    candidates: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)),
    unsupported: [...new Set(unsupported)].sort(),
  };
}

function sourceInHome(
  store: HunchStore,
  decisionId: string,
  opts: { publicOnly?: boolean; privateOnly?: boolean },
): { source: Decision; private: boolean } {
  if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
  if (opts.privateOnly) {
    if (!store.hasPrivate) throw new Error("private structural inspection needs a configured Hunch private overlay");
    const source = store.getPrivateRec("decisions", decisionId);
    if (!source) throw new Error(`private decision ${decisionId} not found`);
    return { source, private: true };
  }
  if (opts.publicOnly) {
    const source = store.json.get("decisions", decisionId);
    if (!source) throw new Error(`public decision ${decisionId} not found`);
    return { source, private: false };
  }
  const source = store.getRec("decisions", decisionId);
  if (!source) throw new Error(`decision ${decisionId} not found`);
  return { source, private: !!store.getPrivateRec("decisions", decisionId) };
}

function historyKind(source: Decision, meta: CommitMeta): "revert" | "bug_fix" | "decision" | null {
  const text = `${meta.subject}\n${meta.body}`;
  if (/^revert\b/i.test(meta.subject.trim())) return "revert";
  if (source.caused_by_bug || /\b(fix(?:e[ds]|ing)?|bug(?:fix)?|hotfix|regression|restore[ds]?)\b/i.test(text)) return "bug_fix";
  if (source.retired.deps.length > 0) return "decision";
  return null;
}

export function inspectStructuralDecision(
  store: HunchStore,
  root: string,
  decisionId: string,
  opts: { publicOnly?: boolean; privateOnly?: boolean } = {},
): StructuralInspection {
  const { source, private: isPrivate } = sourceInHome(store, decisionId, opts);
  if (!source.commit) throw new Error(`decision ${decisionId} has no commit anchor`);
  const meta = commitMeta(source.commit, root);
  if (!meta) throw new Error(`decision ${decisionId} commit ${source.commit} does not resolve in this repository`);
  const kind = historyKind(source, meta);
  if (!kind) throw new Error(`decision ${decisionId} is not linked to a fixing or revert commit`);
  const delta = extractStructuralDelta(root, meta.sha);
  const enumerated = enumerateStructuralCandidates(store, delta, {
    publicOnly: opts.publicOnly,
    judgment: source,
    retiredDependenciesOnly: kind === "decision",
  });
  return { decision: source.id, commit: meta.sha, kind, delta, ...enumerated, private: isPrivate };
}

function eventFor(
  root: string,
  source: Decision,
  meta: CommitMeta,
  kind: "revert" | "bug_fix" | "decision",
  isPrivate: boolean,
  delta?: StructuralDelta,
): EvidenceEvent {
  const contentHash = canonicalHash({ decision: source.id, commit: meta.sha, kind });
  const symbols = delta
    ? [...new Set([
        ...delta.calls.added.flatMap((c) => [c.caller, c.callee]),
        ...delta.calls.removed.flatMap((c) => [c.caller, c.callee]),
        ...delta.symbols.added.map((s: StructuralSymbolRef) => s.name),
      ])].sort()
    : [];
  return EvidenceEventSchema.parse({
    id: `ev_${shortHash(`history:${contentHash}`)}`,
    kind,
    occurred_at: meta.date,
    actor: meta.author,
    repository: basename(root),
    commit: meta.sha,
    files: meta.files,
    symbols,
    text_ref: source.id,
    diff_ref: delta ? `git:${delta.before_commit}..${delta.after_commit}` : `git:${meta.sha}`,
    related_records: [source.id],
    data_class: isPrivate ? "private" : "public",
    content_hash: contentHash,
    ...(delta ? { structural_delta: delta } : {}),
    compiler: { status: "eligible", policy: null, reason: "Human-confirmed fix/revert or explicit dependency-retirement decision with an exact first-parent structural delta." },
    provenance: {
      source: "derived",
      confidence: 1,
      evidence: [source.id, `commit:${meta.sha}`],
      last_verified: source.provenance.last_verified,
    },
  });
}

function canReclassify(event: EvidenceEvent | undefined): boolean {
  const status = event?.compiler?.status;
  return !event || status === "eligible" || status === "uncompilable" || status === "conflicted";
}

/** Phase-2B opt-in bootstrap: only human-confirmed fix/revert or explicit
 * dependency-retirement decisions, exact
 * first-parent deltas, and exactly one bindable candidate may compile. */
export function bootstrapStructuralPolicies(
  store: HunchStore,
  root: string,
  repository: PolicyRepository,
  opts: BootstrapOptions = {},
): BootstrapReport {
  if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
  if (opts.privateOnly && !store.hasPrivate) throw new Error("private history bootstrap needs a configured Hunch private overlay");
  const now = opts.now ?? new Date().toISOString();
  const minDate = durationCutoff(opts.since ?? "90d", now);
  const decisions = opts.privateOnly
    ? store.recsInHome("decisions", "private")
    : opts.publicOnly
      ? store.json.loadAll("decisions")
      : store.recs("decisions");
  const eligible = decisions.flatMap((source) => {
    const at = Date.parse(source.valid_from ?? source.date);
    if (source.status !== "accepted" || source.superseded_by || source.valid_to || source.conformance?.length
      || !source.commit || !source.provenance.source.includes("human_confirmed") || !Number.isFinite(at) || at < minDate) return [];
    const meta = commitMeta(source.commit, root);
    if (!meta) return [];
    const kind = historyKind(source, meta);
    return kind ? [{ source, meta, kind }] : [];
  }).sort((a, b) => (b.source.valid_from ?? b.source.date).localeCompare(a.source.valid_from ?? a.source.date) || a.source.id.localeCompare(b.source.id));

  const homeView = { publicOnly: opts.publicOnly, privateOnly: opts.privateOnly };
  const maxCandidates = clampCandidateLimit(opts.maxCandidates);
  const open = repository.listPolicies(homeView).filter((p) => p.state === "compiled" || p.state === "validating" || p.state === "proposed").length;
  const available = Math.max(0, maxCandidates - Math.min(maxCandidates, open));
  const report: BootstrapReport = { scanned: decisions.length, eligible: eligible.length, compiled: [], covered: 0, deferred: 0, uncompilable: 0, conflicted: 0 };

  for (const { source, meta, kind } of eligible) {
    const isPrivate = opts.privateOnly ? true : opts.publicOnly ? false : !!store.getPrivateRec("decisions", source.id);
    let baseEvent = eventFor(root, source, meta, kind, isPrivate);
    const prior = repository.getEvidence(baseEvent.id, homeView);
    try {
      const delta = extractStructuralDelta(root, meta.sha);
      const enumerated = enumerateStructuralCandidates(store, delta, {
        publicOnly: opts.publicOnly,
        judgment: source,
        retiredDependenciesOnly: kind === "decision",
      });
      baseEvent = eventFor(root, source, meta, kind, isPrivate, delta);
      if (enumerated.candidates.length !== 1) {
        report.uncompilable++;
        const reason = enumerated.candidates.length > 1
          ? `Ambiguous structural delta enumerated ${enumerated.candidates.length} exact supported candidates; Hunch refused to choose semantics.`
          : `No exact supported structural assertion. ${enumerated.unsupported.slice(0, 4).join("; ") || "The delta contains no supported call/symbol/import fact."}`;
        if (canReclassify(prior) && (prior?.compiler?.status !== "uncompilable" || prior.compiler.reason !== reason)) {
          const context = candidateContext(enumerated);
          repository.putEvidence({ ...baseEvent, compiler: { status: "uncompilable", policy: null, reason, ...context } }, { private: isPrivate });
        }
        continue;
      }

      const candidate = enumerated.candidates[0]!;
      const policies = repository.listPolicies(homeView);
      const counterexamples = counterexampleSignals(store, candidate, !!opts.publicOnly);
      let context = candidateContext(enumerated, candidate, [], null, null, counterexamples);
      let compiled = compileStructuralPolicy(store, {
        source,
        evidenceId: baseEvent.id,
        commit: meta.sha,
        assertion: candidate.assertion,
        scope: candidate.scope,
        dataClass: (isPrivate ? "private" : "public") as DataClass,
        candidate: context,
        now,
      });
      const scopeSuggestion = repeatedScopeSuggestion(compiled.policy, policies);
      if (scopeSuggestion) {
        context = candidateContext(enumerated, candidate, [], null, scopeSuggestion, counterexamples);
        compiled = { ...compiled, policy: PolicySpecSchema.parse({ ...compiled.policy, candidate: context }) };
      }
      const key = structuralKey(compiled.policy);
      const incumbent = policies.find((p) => structuralKey(p) === key);
      if (incumbent) {
        report.covered++;
        const incumbentSuggestion = repeatedScopeSuggestion(compiled.policy, policies);
        context = candidateContext(enumerated, candidate, [], incumbent.id, incumbentSuggestion, counterexamples);
        const enriched = enrichIncumbent(repository, incumbent, compiled.policy, context, now, isPrivate);
        if (canReclassify(prior)) repository.putEvidence({
          ...baseEvent,
          related_records: [...baseEvent.related_records, enriched.id],
          compiler: { status: "covered", policy: enriched.id, reason: "Equivalent assertion and scope already exist; incumbent lifecycle and authority were preserved while evidence was enriched idempotently.", ...context },
        }, { private: isPrivate });
        continue;
      }
      const conflicts = policies.filter((policy) => directConflict(compiled.policy, policy)).map((policy) => policy.id).sort();
      if (conflicts.length) {
        report.conflicted++;
        context = candidateContext(enumerated, candidate, conflicts, null, scopeSuggestion, counterexamples);
        repository.putEvidence({
          ...baseEvent,
          related_records: [...baseEvent.related_records, ...conflicts],
          compiler: {
            status: "conflicted",
            policy: null,
            reason: `Candidate directly contradicts ${conflicts.join(", ")}; no policy was minted and no authority changed.`,
            ...context,
          },
        }, { private: isPrivate });
        continue;
      }
      if (report.compiled.length >= available) {
        report.deferred++;
        if (canReclassify(prior) && prior?.compiler?.status !== "eligible") repository.putEvidence(baseEvent, { private: isPrivate });
        continue;
      }
      const policy = repository.putPolicy(compiled.policy, { private: compiled.private });
      const event = repository.putEvidence({
        ...baseEvent,
        related_records: [...baseEvent.related_records, policy.id],
        compiler: { status: "compiled", policy: policy.id, reason: `Exactly one supported candidate: ${candidate.reason}.`, ...context },
      }, { private: isPrivate });
      report.compiled.push({ evidence: event, policy });
    } catch (e) {
      report.uncompilable++;
      const reason = (e as Error).message;
      if (canReclassify(prior) && (prior?.compiler?.status !== "uncompilable" || prior.compiler.reason !== reason)) {
        repository.putEvidence({ ...baseEvent, compiler: { status: "uncompilable", policy: null, reason, alternatives: [], uncertainty: [reason], conflicts: [], incumbent: null } }, { private: isPrivate });
      }
    }
  }
  return report;
}
