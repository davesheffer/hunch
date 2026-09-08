/**
 * The per-scope change ledger: compaction moves the floor and makes stale cursors resynchronize;
 * two clones that both appended merge to one re-sequenced ledger through the git merge driver.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendChanges, compactLedger, emptyLedger, mergeLedgers, readLedger, writeLedger, type Ledger } from "../src/store/changeLedger.js";
import { mergeHunchJson } from "../src/store/merge.js";
import { tempStore } from "./helpers.js";
import { repositoryScope, subscribeState, writeState } from "../src/store/stateBinding.js";
import { assertChangeSequence, stateHash } from "../src/core/stateContract.js";

const scope = { kind: "user" as const, id: "david" };
const ev = (n: number, at: string, principal = "sofia@david") => ({ facet: "commitments" as const, record_id: `ncm_${String(n).padStart(24, "0")}`, record_hash: stateHash(n), change: "created" as const, invalidates: [], cause: { kind: "write" as const, principal } });

test("compaction keeps the newest events, moves the floor, and keeps the ledger contiguous from the floor", () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-ledger-"));
  try {
    for (let i = 1; i <= 7; i++) appendChanges(dir, scope, [ev(i, `2026-09-08T10:00:0${i}Z`)], { key: `k${i}`, entry: { record_id: ev(i, "").record_id, record_hash: stateHash(i), facet: "commitments" } }, `2026-09-08T10:00:0${i}Z`);
    const result = compactLedger(dir, scope, { keep: 3 });
    assert.deepEqual(result, { dropped: 4, floor_seq: 4, head_seq: 7 });
    const ledger = readLedger(dir, scope);
    assert.deepEqual(ledger.events.map((e) => e.seq), [5, 6, 7]);
    assert.equal(Object.keys(ledger.idempotency).length, 7, "the idempotency table is kept whole");
    assert.deepEqual(compactLedger(dir, scope, { keep: 3 }), { dropped: 0, floor_seq: 4, head_seq: 7 }, "idempotent");
    const next = appendChanges(dir, scope, [ev(8, "2026-09-08T10:00:08Z")], null);
    assert.equal(next[0]?.seq, 8, "appends continue from the head");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("subscribe below the floor says resync and starts at the floor; above it stays contiguous", () => {
  const { store, root, cleanup } = tempStore();
  try {
    const repo = repositoryScope(store);
    const principal = { id: "sofia@david", kind: "agent" as const, grants: [repo] };
    const prov = { source: "imported:sofia", confidence: 1, evidence: [] };
    for (let i = 0; i < 5; i++) writeState(store, { schema: "nuryel.state.write/1", principal, scope: repo, facet: "commitments", record: { schema: "nuryel.commitment/1", scope: repo, subject: "customer:c1", title: `t${i}`, owner: "david", due: "2026-09-30", status: "open", valid_from: "2026-09-08T10:00:00Z", valid_to: null, provenance: prov }, idempotency_key: `compact-sub-${i}` });
    compactLedger(join(root, ".hunch"), repo, { keep: 2 });
    const stale = subscribeState(store, { schema: "nuryel.state.subscribe/1", principal, scope: repo, after_seq: 1 });
    assert.equal(stale.resync, true);
    assert.equal(stale.floor_seq, 3);
    assert.deepEqual(stale.events.map((e) => e.seq), [4, 5]);
    assert.doesNotThrow(() => assertChangeSequence(stale.events, stale.floor_seq), "contiguous from the floor");
    const fresh = subscribeState(store, { schema: "nuryel.state.subscribe/1", principal, scope: repo, after_seq: 4 });
    assert.equal(fresh.resync, false);
    assert.deepEqual(fresh.events.map((e) => e.seq), [5]);
  } finally { cleanup(); }
});

test("two clones that both appended merge to one re-sequenced ledger; a key used for two records is a conflict", () => {
  const base: Ledger = { ...emptyLedger(scope), head_seq: 1, events: [{ schema: "nuryel.state.subscribe/1", seq: 1, at: "2026-09-08T10:00:00Z", scope, ...ev(1, "") }], idempotency: { k1: { record_id: ev(1, "").record_id, record_hash: stateHash(1), facet: "commitments", seq: 1, at: "2026-09-08T10:00:00Z" } } };
  const ours: Ledger = { ...base, head_seq: 2, events: [...base.events, { schema: "nuryel.state.subscribe/1", seq: 2, at: "2026-09-08T10:00:05Z", scope, ...ev(2, "", "sofia@david") }], idempotency: { ...base.idempotency, k2: { record_id: ev(2, "").record_id, record_hash: stateHash(2), facet: "commitments", seq: 2, at: "2026-09-08T10:00:05Z" } } };
  const theirs: Ledger = { ...base, head_seq: 2, events: [...base.events, { schema: "nuryel.state.subscribe/1", seq: 2, at: "2026-09-08T10:00:03Z", scope, ...ev(3, "", "orc") }], idempotency: { ...base.idempotency, k3: { record_id: ev(3, "").record_id, record_hash: stateHash(3), facet: "commitments", seq: 2, at: "2026-09-08T10:00:03Z" } } };
  const { ledger, conflicts } = mergeLedgers(base, ours, theirs);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(ledger.events.map((e) => [e.seq, e.record_id.slice(-1), e.cause?.kind === "write" ? e.cause.principal : ""]), [[1, "1", "sofia@david"], [2, "3", "orc"], [3, "2", "sofia@david"]], "union, ordered by time, re-sequenced");
  assert.equal(ledger.head_seq, 3);
  assert.equal(ledger.idempotency.k3?.seq, 2, "idempotency entries follow their event's new seq");
  assert.equal(ledger.idempotency.k2?.seq, 3);
  // The git merge driver understands the file and produces the merged ledger.
  const text = (l: Ledger) => JSON.stringify(l, null, 2);
  const driven = mergeHunchJson(text(base), text(ours), text(theirs));
  assert.equal(driven.conflict, false);
  assert.equal((JSON.parse(driven.text) as Ledger).head_seq, 3);
  // Same key, different records → conflict surfaced, not silently resolved.
  const clash: Ledger = { ...theirs, idempotency: { ...theirs.idempotency, k2: { record_id: ev(3, "").record_id, record_hash: stateHash(3), facet: "commitments", seq: 2, at: "2026-09-08T10:00:03Z" } } };
  assert.equal(mergeLedgers(base, ours, clash).conflicts.length, 1);
  assert.equal(mergeHunchJson(text(base), text(ours), text(clash)).conflict, true, "the driver falls back to git's conflict handling");
  // A merged ledger round-trips through the reader's contiguity check.
  const dir = mkdtempSync(join(tmpdir(), "hunch-ledger-merge-"));
  try { writeLedger(dir, ledger); assert.equal(readLedger(dir, scope).head_seq, 3); } finally { rmSync(dir, { recursive: true, force: true }); }
});
