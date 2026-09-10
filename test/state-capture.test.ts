import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempStore } from "./helpers.js";
import { captureBatchState, captureState } from "../src/store/stateCapture.js";
import { StateRefusal, partitionOf, readState, writeState } from "../src/store/stateBinding.js";
import { STATE_CAPTURE_VERSION, STATE_CAPTURE_BATCH_VERSION, stateHash, type CaptureRequest, type WriteResult } from "../src/core/stateContract.js";
import { ledgerFile, readLedger } from "../src/store/changeLedger.js";

function fixture() {
  const f = tempStore();
  const scope = partitionOf(f.store);
  const principal = { id: "codex@david", kind: "agent" as const, grants: [scope] };
  const ref = { system: "crm", object_type: "note", object_key: "note-42", observed_at: "2026-09-10T12:00:00Z" };
  const request: CaptureRequest = { schema: STATE_CAPTURE_VERSION, principal, scope, subject: "customer:test",
    statement: "The office closes Friday.", relevance: { use: "constraint", reason: "Avoid scheduling on Friday." },
    evidence: [{ ref, source_text: "Hello! The office closes Friday. Coffee was cold.", excerpt: "The office closes Friday." }] };
  return { ...f, scope, principal, ref, request };
}

test("atomic capture preserves the new detail inside a known passage, and excludes unselected text", () => {
  const f = fixture();
  try {
    const first = captureState(f.store, f.request);
    const text = "Hello! The office closes Friday. On Thursday call Dana directly. Coffee was cold.";
    const batch = { schema: STATE_CAPTURE_BATCH_VERSION, scope: f.scope, principal: { ...f.principal, id: "kimi@david" },
      sources: [{ ref: { ...f.ref, observed_at: "2026-09-11T12:00:00Z" }, source_text: text }],
      observations: [
        { subject: f.request.subject, statement: f.request.statement, relevance: f.request.relevance, evidence: [{ source: 0, excerpt: f.request.evidence[0]!.excerpt }] },
        { subject: f.request.subject, statement: "On Thursday call Dana directly.", relevance: { use: "operational_fact", reason: "Use the right contact for Thursday follow-ups." }, evidence: [{ source: 0, excerpt: "On Thursday call Dana directly." }] },
      ] };
    let indexes = 0, flushes = 0;
    const reindex = f.store.reindex.bind(f.store);
    f.store.reindex = () => { indexes++; return reindex(); };
    const result = captureBatchState(f.store, batch, { flush: () => { flushes++; return "committed"; } });
    assert.deepEqual(result.results.map(r => r.status === "saved" ? r.result.outcome : r.code), ["replayed", "created"]);
    assert.equal(indexes, 1); assert.equal(flushes, 1);
    const old = result.results[0]!;
    assert.equal(old.status === "saved" && old.result.record_id, first.record_id);
    assert.match(String(old.status === "saved" && old.result.record?.content), /codex@david/, "replay preserves original author");
    captureBatchState(f.store, batch, { flush: () => { flushes++; return "committed"; } });
    assert.equal(indexes, 1, "duplicate-only batch never rebuilds the index");
    assert.equal(flushes, 1, "duplicate-only batch never flushes Git");
    assert.equal(readLedger(join(f.root, ".hunch"), f.scope).head_seq, 2);
    const response = readState(f.store, { schema: "nuryel.state.read/1", principal: { ...f.principal, id: "claude@david" }, scope: f.scope, subject: f.request.subject }).response;
    assert.equal(response.state_of_record?.observed?.length, 2);
    assert.equal(response.state_of_record?.current.length, 0, "observation is not current state");
    const records = f.store.recs("derived");
    const persisted = JSON.stringify(records) + readFileSync(ledgerFile(join(f.root, ".hunch"), f.scope), "utf8");
    assert.doesNotMatch(persisted, /Coffee was cold|Hello!/);
    assert.match(persisted, /On Thursday call Dana directly/);
  } finally { f.cleanup(); }
});

test("unsupported excerpts, hash mismatch and missing batch sources refuse individually without losing a valid claim", () => {
  const f = fixture();
  try {
    assert.throws(() => captureState(f.store, { ...f.request, evidence: [{ ...f.request.evidence[0], excerpt: "Never said." }] }), /occur exactly/);
    assert.throws(() => captureState(f.store, { ...f.request, evidence: [{ ...f.request.evidence[0], ref: { ...f.ref, content_hash: stateHash("wrong") } }] }), /content hash/);
    const item = { subject: f.request.subject, statement: f.request.statement, relevance: f.request.relevance };
    const result = captureBatchState(f.store, { schema: STATE_CAPTURE_BATCH_VERSION, principal: f.principal, scope: f.scope,
      sources: [{ ref: f.ref, source_text: f.request.evidence[0]!.source_text }],
      observations: [ { ...item, evidence: [{ source: 0, excerpt: "Never said." }] }, { ...item, evidence: [{ source: 3, excerpt: "Missing" }] }, { ...item, evidence: [{ source: 0, excerpt: f.request.evidence[0]!.excerpt }] } ] });
    assert.deepEqual(result.results.map(r => [r.index, r.status]), [[0, "refused"], [1, "refused"], [2, "saved"]]);
    assert.equal(f.store.recs("derived").length, 1);
    assert.throws(() => captureBatchState(f.store, { schema: STATE_CAPTURE_BATCH_VERSION, principal: { ...f.principal, grants: [{ kind: "user", id: "stranger" }] }, scope: f.scope,
      sources: [{ ref: f.ref, source_text: "x" }], observations: [{ ...item, evidence: [{ source: 0, excerpt: "x" }] }] }), (e: unknown) => e instanceof StateRefusal && e.code === "outside-grants");
  } finally { f.cleanup(); }
});

test("exact lookup never enumerates the derived collection, preserves stale/human records and rejects forged capture identities", () => {
  const f = fixture();
  try {
    const first = captureState(f.store, f.request);
    const closed = { ...first.record, state: "stale", valid_to: "2026-09-10T13:00:00Z", provenance: { source: "human_confirmed", confidence: 1, evidence: ["human review"] } };
    writeState(f.store, { schema: "nuryel.state.write/1", principal: { ...f.principal, kind: "human" }, scope: f.scope, facet: "derived", record: closed, idempotency_key: "human-close" });
    const loadAll = f.store.json.loadAll.bind(f.store.json);
    f.store.json.loadAll = ((kind: Parameters<typeof loadAll>[0]) => { assert.notEqual(kind, "derived", "point lookup must not load the collection"); return loadAll(kind); }) as typeof f.store.json.loadAll;
    const replay = captureState(f.store, f.request);
    assert.equal(replay.record?.state, "stale");
    assert.deepEqual(replay.record?.provenance, closed.provenance);
    assert.throws(() => writeState(f.store, { schema: "nuryel.state.write/1", principal: f.principal, scope: f.scope, facet: "derived", record: { ...first.record, state: "current" }, idempotency_key: "bad-promote" }), /cannot assert currentness/);
    const content = JSON.parse(String(first.record?.content)); content.statement = "An unsupported different assertion.";
    const forged = { ...first.record, content: JSON.stringify(content), content_hash: stateHash(JSON.stringify(content)) };
    assert.throws(() => writeState(f.store, { schema: "nuryel.state.write/1", principal: f.principal, scope: f.scope, facet: "derived", record: forged, idempotency_key: "bad-forgery" }), /identity does not match/);
    writeFileSync(join(f.root, ".hunch", "derived", `${first.record_id}.json`), "{broken");
    assert.throws(() => captureState(f.store, f.request), /JSON/);
  } finally { f.cleanup(); }
});

test("different assertions in the same excerpt survive; observed history is bounded explicitly", () => {
  const f = fixture();
  try {
    const results: WriteResult[] = [];
    for (let i = 0; i < 66; i++) results.push(captureState(f.store, { ...f.request, statement: `Distinct assertion ${i}` }, { deferReindex: true }));
    f.store.reindex();
    assert.equal(new Set(results.map(r => r.record_id)).size, 66);
    const response = readState(f.store, { schema: "nuryel.state.read/1", principal: f.principal, scope: f.scope, subject: f.request.subject }).response;
    assert.equal(response.state_of_record?.observed?.length, 64);
    assert.equal(response.state_of_record?.observed_truncated, true);
  } finally { f.cleanup(); }
});
