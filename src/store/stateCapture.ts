import type { HunchStore } from "./hunchStore.js";
import { CaptureRequestSchema, CaptureBatchRequestSchema, STATE_CAPTURE_VERSION, STATE_CAPTURE_BATCH_VERSION, STATE_WRITE_VERSION, assertDerivedState, captureTransform, derivedId, normalizeAssertion, canonicalObjectKey, externalKey, scopePath, stateHash, type CaptureBatchResult, type DerivedState, type WriteResult } from "../core/stateContract.js";
import { isCredentialFreeValue } from "../core/provenance.js";
import { StateRefusal, stateHomeFor, writeState, type WriteOptions } from "./stateBinding.js";

interface CaptureOptions extends WriteOptions { sourceHashes?: Map<string, string> }

/** The caller selects relevant atomic claims; this deterministic boundary checks evidence
 * fidelity and deduplication. It does not pretend to prove semantic entailment or relevance.
 * Both bindings hold the partition write lock over lookup AND write. */
export function captureState(store: HunchStore, input: unknown, opts: CaptureOptions = {}): WriteResult {
  const request = CaptureRequestSchema.parse(input);
  if (!request.principal.grants.some(s => scopePath(s) === scopePath(request.scope))) throw new StateRefusal("outside-grants", "capture scope is outside the principal's grants");
  const { home } = stateHomeFor(store, request.scope);
  const statement = normalizeAssertion(request.statement);
  if (![statement, request.relevance.reason, ...request.evidence.map(e => e.excerpt)].every(isCredentialFreeValue)) throw new StateRefusal("malformed", "captured content must not contain credential material");
  const evidence = request.evidence.map(e => {
    if (!e.source_text.includes(e.excerpt)) throw new StateRefusal("malformed", "every excerpt must occur exactly in its supplied source text");
    const hash = opts.sourceHashes?.get(e.source_text) ?? stateHash(e.source_text);
    opts.sourceHashes?.set(e.source_text, hash);
    if (e.ref.content_hash && e.ref.content_hash !== hash) throw new StateRefusal("malformed", "source text does not match its declared content hash");
    return { ref: { ...e.ref, object_key: canonicalObjectKey(e.ref.object_key), content_hash: hash }, excerpt: e.excerpt };
  });
  // Ignore read time, writer and unrelated source text when deduplicating an assertion.
  // A different excerpt, statement, source identity or subject is a distinct observation.
  const transform = captureTransform(request.scope, request.subject, statement, evidence.map(e => ({ source: externalKey(e.ref), excerpt: e.excerpt })));
  const id = derivedId({ scope: request.scope, subject: request.subject, transform_version: transform, dependencies: [] });
  const incumbent = store.getStateDirect("derived", id, home);
  if (incumbent) {
    assertDerivedState(incumbent);
    if (incumbent.transform_version !== transform || scopePath(incumbent.scope) !== scopePath(request.scope) || incumbent.subject !== request.subject) throw new StateRefusal("conflict", "capture identity collision; incumbent preserved");
    // Never revive stale or human-corrected evidence, replace its author, or claim a new
    // observation because another agent saw the same excerpt. Return what actually exists.
    return { schema: STATE_WRITE_VERSION, record_id: incumbent.id, record_hash: stateHash(incumbent), durability: "local", outcome: "replayed", conflict: null, record: incumbent as unknown as Record<string, unknown> };
  }
  const refs = [...new Map(evidence.map(e => [stateHash(e.ref), e.ref])).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, ref]) => ref);
  const content = JSON.stringify({ schema: "nuryel.observation-content/1", statement, relevance: request.relevance,
    evidence: evidence.map(e => ({ source: externalKey(e.ref), excerpt: e.excerpt })), captured_by: request.principal.id });
  const record: Omit<DerivedState, "id"> = {
    schema: "nuryel.derived/1", scope: request.scope, subject: request.subject, content, content_hash: stateHash(content),
    dependencies: refs.map(ref => ({ kind: "external", ref })), transform_version: transform,
    computed_at: (opts.now ?? (() => new Date()))().toISOString(), valid_to: null, state: "unknown",
    provenance: { source: "agent_recorded", confidence: 0.8, evidence: [`captured by ${request.principal.id}`, ...refs.map(externalKey)] },
  };
  return writeState(store, { schema: STATE_WRITE_VERSION, principal: request.principal, scope: request.scope, facet: "derived", record, idempotency_key: transform }, opts);
}

/** Bounded partial-success batch. The caller holds the same partition lock as writeState.
 * Every result has its input index; a refused claim never hides a later valid new detail.
 * A duplicate-only batch performs no record, ledger, index or Git writes. */
export function captureBatchState(store: HunchStore, input: unknown, opts: WriteOptions = {}): CaptureBatchResult {
  const request = CaptureBatchRequestSchema.parse(input);
  if (!request.principal.grants.some(s => scopePath(s) === scopePath(request.scope))) throw new StateRefusal("outside-grants", "capture scope is outside the principal's grants");
  if (!request.observations.length && !request.reviews?.length) throw new StateRefusal("malformed", "capture batch must contain observations or reviews");
  const { home, isPrivate } = stateHomeFor(store, request.scope);
  const sourceHashes = new Map<string, string>();
  const ledgerCache: NonNullable<WriteOptions["ledgerCache"]> = {};
  const results: CaptureBatchResult["results"] = [];
  const reviews: NonNullable<CaptureBatchResult["reviews"]> = [];
  let changed = false;
  try {
    // Review before capture: a replay in the same batch must see the withdrawn state.
    for (const [index, review] of (request.reviews ?? []).entries()) {
      try {
        const record = store.getStateDirect("derived", review.record_id, home);
        if (!record || scopePath(record.scope) !== scopePath(request.scope) || !record.transform_version.startsWith('agent-capture/1:')) throw new StateRefusal('conflict', 'captured observation is absent from this partition');
        if (!isCredentialFreeValue(review.reason)) throw new StateRefusal('malformed', 'review reason contains credential material');
        const evidence = review.evidence.map(e => {
          const source = request.sources[e.source];
          if (!source || !source.source_text.includes(e.excerpt) || !isCredentialFreeValue(e.excerpt)) throw new StateRefusal('malformed', 'review excerpt must occur exactly in the supplied source');
          const hash = sourceHashes.get(source.source_text) ?? stateHash(source.source_text); sourceHashes.set(source.source_text, hash);
          if (source.ref.content_hash && source.ref.content_hash !== hash) throw new StateRefusal('malformed', 'review source hash mismatch');
          const ref = { ...source.ref, object_key: canonicalObjectKey(source.ref.object_key), content_hash: hash };
          const original = record.dependencies.find(d => d.kind === 'external' && externalKey(d.ref) === externalKey(ref));
          if (!original || original.kind !== 'external' || original.ref.content_hash === hash) throw new StateRefusal('conflict', 'review must cite a changed source the observation actually depends on');
          return { ref, excerpt: e.excerpt };
        });
        const identity = stateHash({ record_id: record.id, expected_hash: review.expected_hash, reason: review.reason, evidence: evidence.map(e => ({ source: externalKey(e.ref), hash: e.ref.content_hash, excerpt: e.excerpt })) });
        // A safe retry returns the same withdrawal without changing its reviewer/time.
        const old = record.review;
        if (record.state === 'stale' && old && old.previous_hash === review.expected_hash && old.reason === review.reason && stateHash(old.evidence.map(e => ({ source: externalKey(e.ref), hash: e.ref.content_hash, excerpt: e.excerpt }))) === stateHash(evidence.map(e => ({ source: externalKey(e.ref), hash: e.ref.content_hash, excerpt: e.excerpt })))) {
          reviews.push({ index, status: 'saved', result: { schema: STATE_WRITE_VERSION, record_id: record.id, record_hash: stateHash(record), record: record as unknown as Record<string, unknown>, durability: 'local', outcome: 'replayed', conflict: null } }); continue;
        }
        if (record.state !== 'unknown' || record.valid_to != null || stateHash(record) !== review.expected_hash) throw new StateRefusal('conflict', 'observation changed since review; read it again');
        const at = (opts.now ?? (() => new Date()))().toISOString();
        const result = writeState(store, { schema: STATE_WRITE_VERSION, principal: request.principal, scope: request.scope, facet: 'derived',
          record: { ...record, state: 'stale', review: { by: request.principal.id, at, previous_hash: review.expected_hash, reason: review.reason, evidence } },
          expected_version: review.expected_hash, idempotency_key: `observation-review:${identity}`, cause: { kind: 'external', ref: evidence[0]!.ref } }, { now: opts.now, ledgerCache, deferReindex: true });
        changed ||= result.outcome !== 'replayed'; reviews.push({ index, status: 'saved', result });
      } catch (error) {
        if (!(error instanceof StateRefusal)) throw error;
        reviews.push({ index, status: 'refused', code: error.code, message: error.message });
      }
    }
    for (const [index, observation] of request.observations.entries()) {
      try {
        const evidence = observation.evidence.map(e => {
          const source = request.sources[e.source];
          if (!source) throw new StateRefusal("malformed", `evidence source index ${e.source} is absent`);
          return { ...source, excerpt: e.excerpt };
        });
        const result = captureState(store, { schema: STATE_CAPTURE_VERSION, principal: request.principal, scope: request.scope, ...observation, evidence }, { now: opts.now, sourceHashes, ledgerCache, deferReindex: true });
        changed ||= result.outcome !== "replayed";
        results.push({ index, status: "saved", result });
      } catch (error) {
        if (!(error instanceof StateRefusal)) throw error;
        results.push({ index, status: "refused", code: error.code, message: error.message });
      }
    }
  } catch (error) {
    // A filesystem failure may occur after an atomic record write but before its
    // result; refresh the derived index before propagating the failure to the caller.
    changed = true;
    throw error;
  } finally {
    if (changed) store.reindex();
  }
  if (changed) {
    const durability = opts.flush?.(isPrivate, `nuryel: capture ${results.filter(r => r.status === "saved" && r.result.outcome === "created").length} observations`) ?? "local";
    for (const item of [...results, ...reviews]) if (item.status === "saved") item.result.durability = durability;
  }
  return { schema: STATE_CAPTURE_BATCH_VERSION, results, ...(request.reviews ? { reviews } : {}) };
}
