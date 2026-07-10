import { basename } from "node:path";
import { shortHash } from "../core/ids.js";
import type { Decision } from "../core/types.js";
import type { HunchStore } from "../store/hunchStore.js";
import { canonicalHash } from "./canonical.js";
import { compileDecisionRecord } from "./compiler.js";
import type { PolicyRepository } from "./repository.js";
import { EvidenceEventSchema, type EvidenceEvent, type PolicySpec } from "./schema.js";

export interface BootstrapCandidate {
  evidence: EvidenceEvent;
  policy: PolicySpec;
}

export interface BootstrapReport {
  scanned: number;
  eligible: number;
  compiled: BootstrapCandidate[];
  covered: number;
  deferred: number;
  uncompilable: number;
}

export interface BootstrapOptions {
  since?: string;
  maxCandidates?: number;
  publicOnly?: boolean;
  privateOnly?: boolean;
  history?: boolean;
  now?: string;
}

export function clampCandidateLimit(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(3, Math.trunc(value)));
}

export function durationCutoff(since: string, now: string): number {
  const match = /^(\d+)([dw])$/.exec(since.trim());
  if (!match) throw new Error(`--since must be a positive duration such as 30d or 12w (got "${since}")`);
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("--since duration must be positive");
  const days = match[2] === "w" ? amount * 7 : amount;
  return Date.parse(now) - days * 86_400_000;
}

function eligible(decision: Decision, minDate: number): boolean {
  const at = Date.parse(decision.valid_from ?? decision.date);
  return decision.status === "accepted"
    && !decision.superseded_by
    && !decision.valid_to
    && decision.provenance.source.includes("human_confirmed")
    && decision.conformance?.length === 1
    && Number.isFinite(at)
    && at >= minDate;
}

function eventFor(root: string, decision: Decision, isPrivate: boolean): EvidenceEvent {
  const predicate = decision.conformance![0]!;
  const contentHash = canonicalHash({
    decision: decision.id,
    predicate,
    related_files: decision.related_files,
    related_components: decision.related_components,
    caused_by_bug: decision.caused_by_bug,
  });
  const symbols = [predicate.subject, predicate.object].filter((v): v is string => !!v);
  return EvidenceEventSchema.parse({
    id: `ev_${shortHash(`${decision.id}:${contentHash}`)}`,
    kind: "decision",
    occurred_at: decision.valid_from ?? decision.date,
    repository: basename(root),
    ...(decision.commit ? { commit: decision.commit } : {}),
    files: decision.related_files.filter((f) => !f.startsWith("private:")),
    symbols,
    text_ref: decision.id,
    ...(decision.commit ? { diff_ref: `git:${decision.commit}` } : {}),
    related_records: [decision.id],
    data_class: isPrivate ? "private" : "public",
    content_hash: contentHash,
    compiler: { status: "eligible", policy: null, reason: "Structured human-confirmed Decision.conformance predicate." },
    provenance: {
      source: "derived",
      confidence: 1,
      evidence: [decision.id, ...decision.provenance.evidence],
      last_verified: decision.provenance.last_verified,
    },
  });
}

function canReclassify(event: EvidenceEvent | undefined): boolean {
  const status = event?.compiler?.status;
  return !event || status === "eligible" || status === "uncompilable";
}

/** Model-free Phase-2A bootstrap. It accepts only explicit structured evidence,
 * creates an auditable event, compiles at most three new candidates, and never
 * changes lifecycle authority. */
export function bootstrapPolicies(
  store: HunchStore,
  root: string,
  repository: PolicyRepository,
  opts: BootstrapOptions = {},
): BootstrapReport {
  if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
  if (opts.privateOnly && !store.hasPrivate) throw new Error("private bootstrap needs a configured Hunch private overlay");
  const now = opts.now ?? new Date().toISOString();
  const minDate = durationCutoff(opts.since ?? "90d", now);
  const decisions = opts.privateOnly
    ? store.recsInHome("decisions", "private")
    : opts.publicOnly
      ? store.json.loadAll("decisions")
      : store.recs("decisions");
  const candidates = decisions
    .filter((d) => eligible(d, minDate))
    .sort((a, b) => (b.valid_from ?? b.date).localeCompare(a.valid_from ?? a.date) || a.id.localeCompare(b.id));
  const maxCandidates = clampCandidateLimit(opts.maxCandidates);
  const homeView = { publicOnly: opts.publicOnly, privateOnly: opts.privateOnly };
  const openCandidates = repository.listPolicies(homeView).filter((p) => p.state === "compiled" || p.state === "validating" || p.state === "proposed").length;
  const available = Math.max(0, maxCandidates - Math.min(maxCandidates, openCandidates));
  const report: BootstrapReport = { scanned: decisions.length, eligible: candidates.length, compiled: [], covered: 0, deferred: 0, uncompilable: 0 };

  for (const decision of candidates) {
    const isPrivate = opts.privateOnly ? true : opts.publicOnly ? false : !!store.getPrivateRec("decisions", decision.id);
    const baseEvent = eventFor(root, decision, isPrivate);
    const priorEvent = repository.getEvidence(baseEvent.id, homeView);
    try {
      const compiled = compileDecisionRecord(store, decision, isPrivate, { now });
      const incumbent = repository.getPolicy(compiled.policy.id, homeView);
      if (incumbent) {
        report.covered++;
        if (canReclassify(priorEvent)) repository.putEvidence({
          ...baseEvent,
          related_records: [...baseEvent.related_records, incumbent.id],
          compiler: { status: "covered", policy: incumbent.id, reason: "Equivalent Policy IR already exists; lifecycle state preserved." },
        }, { private: isPrivate });
        continue;
      }
      if (report.compiled.length >= available) {
        report.deferred++;
        if (canReclassify(priorEvent) && priorEvent?.compiler?.status !== "eligible") {
          repository.putEvidence(baseEvent, { private: isPrivate });
        }
        continue;
      }
      const policy = repository.putPolicy(compiled.policy, { private: compiled.private });
      const event = repository.putEvidence({
        ...baseEvent,
        related_records: [...baseEvent.related_records, policy.id],
        compiler: { status: "compiled", policy: policy.id, reason: "Deterministic structured compatibility compilation." },
      }, { private: isPrivate });
      report.compiled.push({ evidence: event, policy });
    } catch (e) {
      report.uncompilable++;
      if (canReclassify(priorEvent) && priorEvent?.compiler?.status !== "uncompilable") repository.putEvidence({
        ...baseEvent,
        compiler: { status: "uncompilable", policy: null, reason: (e as Error).message },
      }, { private: isPrivate });
    }
  }
  return report;
}
