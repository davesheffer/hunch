import { basename } from "node:path";
import { pathMatchesGlob } from "../core/glob.js";
import { shortHash } from "../core/ids.js";
import type { Decision, Edge, Symbol } from "../core/types.js";
import { commitMeta, type CommitMeta } from "../extractors/git.js";
import type { HunchStore } from "../store/hunchStore.js";
import { canonicalHash } from "./canonical.js";
import { clampCandidateLimit, durationCutoff, type BootstrapOptions, type BootstrapReport } from "./bootstrap.js";
import { compileStructuralPolicy } from "./compiler.js";
import { extractStructuralDelta } from "./delta.js";
import type { PolicyRepository } from "./repository.js";
import {
  EvidenceEventSchema,
  type DataClass,
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
  basis: "added-call" | "removed-call" | "added-symbol";
  reason: string;
}

export interface StructuralInspection {
  decision: string;
  commit: string;
  kind: "revert" | "bug_fix";
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

function structuralKey(policy: Pick<PolicySpec, "assertion" | "scope" | "data_class">): string {
  return canonicalHash({ assertion: policy.assertion, scope: policy.scope, data_class: policy.data_class });
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
  opts: { publicOnly?: boolean; judgment?: Decision } = {},
): Enumerated {
  const symbols = opts.publicOnly ? store.json.loadAll("symbols") : store.recs("symbols");
  const edges = opts.publicOnly ? store.json.loadAll("edges") : store.recs("edges");
  const callsFrom = new Map<string, Set<string>>();
  for (const edge of edges.filter((e: Edge) => e.type === "calls")) {
    const targets = callsFrom.get(edge.from) ?? new Set<string>();
    targets.add(edge.to);
    callsFrom.set(edge.from, targets);
  }
  const candidates: StructuralCandidate[] = [];
  const unsupported: string[] = [];

  const subjectFor = (file: string, name: string): Symbol | null => {
    const matches = symbols.filter((s) => s.file === file && s.name === name);
    if (matches.length !== 1) {
      unsupported.push(`${file}:${name} subject is ${matches.length ? "ambiguous" : "missing"} in the current graph`);
      return null;
    }
    return matches[0]!;
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
  for (const added of delta.imports.added) unsupported.push(`added import ${added.file}:${added.specifier} awaits an import assertion evaluator`);
  for (const removed of delta.imports.removed) unsupported.push(`removed import ${removed.file}:${removed.specifier} awaits an import assertion evaluator`);

  const unique = new Map(candidates.map((c) => [canonicalHash({ assertion: c.assertion, scope: c.scope }), c]));
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

function historyKind(source: Decision, meta: CommitMeta): "revert" | "bug_fix" | null {
  const text = `${meta.subject}\n${meta.body}`;
  if (/^revert\b/i.test(meta.subject.trim())) return "revert";
  if (source.caused_by_bug || /\b(fix(?:e[ds]|ing)?|bug(?:fix)?|hotfix|regression|restore[ds]?)\b/i.test(text)) return "bug_fix";
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
  const enumerated = enumerateStructuralCandidates(store, delta, { publicOnly: opts.publicOnly, judgment: source });
  return { decision: source.id, commit: meta.sha, kind, delta, ...enumerated, private: isPrivate };
}

function eventFor(
  root: string,
  source: Decision,
  meta: CommitMeta,
  kind: "revert" | "bug_fix",
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
    compiler: { status: "eligible", policy: null, reason: "Human-confirmed fixing/revert decision with an exact first-parent structural delta." },
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
  return !event || status === "eligible" || status === "uncompilable";
}

/** Phase-2B opt-in bootstrap: only human-confirmed fix/revert decisions, exact
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
  const report: BootstrapReport = { scanned: decisions.length, eligible: eligible.length, compiled: [], covered: 0, deferred: 0, uncompilable: 0 };

  for (const { source, meta, kind } of eligible) {
    const isPrivate = opts.privateOnly ? true : opts.publicOnly ? false : !!store.getPrivateRec("decisions", source.id);
    let baseEvent = eventFor(root, source, meta, kind, isPrivate);
    const prior = repository.getEvidence(baseEvent.id, homeView);
    try {
      const delta = extractStructuralDelta(root, meta.sha);
      const enumerated = enumerateStructuralCandidates(store, delta, { publicOnly: opts.publicOnly, judgment: source });
      baseEvent = eventFor(root, source, meta, kind, isPrivate, delta);
      if (enumerated.candidates.length !== 1) {
        report.uncompilable++;
        const reason = enumerated.candidates.length > 1
          ? `Ambiguous structural delta enumerated ${enumerated.candidates.length} exact supported candidates; Hunch refused to choose semantics.`
          : `No exact supported structural assertion. ${enumerated.unsupported.slice(0, 4).join("; ") || "The delta contains no supported call/symbol fact."}`;
        if (canReclassify(prior) && (prior?.compiler?.status !== "uncompilable" || prior.compiler.reason !== reason)) {
          repository.putEvidence({ ...baseEvent, compiler: { status: "uncompilable", policy: null, reason } }, { private: isPrivate });
        }
        continue;
      }

      const candidate = enumerated.candidates[0]!;
      const compiled = compileStructuralPolicy(store, {
        source,
        evidenceId: baseEvent.id,
        commit: meta.sha,
        assertion: candidate.assertion,
        scope: candidate.scope,
        dataClass: (isPrivate ? "private" : "public") as DataClass,
        now,
      });
      const key = structuralKey(compiled.policy);
      const incumbent = repository.listPolicies(homeView).find((p) => structuralKey(p) === key);
      if (incumbent) {
        report.covered++;
        if (canReclassify(prior)) repository.putEvidence({
          ...baseEvent,
          related_records: [...baseEvent.related_records, incumbent.id],
          compiler: { status: "covered", policy: incumbent.id, reason: "Equivalent assertion and scope already exist; incumbent lifecycle preserved." },
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
        compiler: { status: "compiled", policy: policy.id, reason: `Exactly one supported candidate: ${candidate.reason}.` },
      }, { private: isPrivate });
      report.compiled.push({ evidence: event, policy });
    } catch (e) {
      report.uncompilable++;
      const reason = (e as Error).message;
      if (canReclassify(prior) && (prior?.compiler?.status !== "uncompilable" || prior.compiler.reason !== reason)) {
        repository.putEvidence({ ...baseEvent, compiler: { status: "uncompilable", policy: null, reason } }, { private: isPrivate });
      }
    }
  }
  return report;
}
