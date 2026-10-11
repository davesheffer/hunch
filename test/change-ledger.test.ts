import { cleanupDir } from "./fixtures.js";
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
import { foldLedger } from "../src/store/replay.js";

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
  } finally { cleanupDir(dir); }
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
  // Theirs lands before ours in time, so both sides' seq 2 moves: a renumbering merge, whose
  // floor is raised past both pre-merge heads (issue #285) so every pre-merge cursor resyncs.
  assert.equal(ledger.floor_seq, 3);
  assert.deepEqual(ledger.events.map((e) => [e.seq, e.record_id.slice(-1), e.cause?.kind === "write" ? e.cause.principal : ""]), [[4, "1", "sofia@david"], [5, "3", "orc"], [6, "2", "sofia@david"]], "union, ordered by time, re-sequenced above both heads");
  assert.equal(ledger.head_seq, 6);
  assert.equal(ledger.idempotency.k3?.seq, 5, "idempotency entries follow their event's new seq");
  assert.equal(ledger.idempotency.k2?.seq, 6);
  // The git merge driver understands the file and produces the merged ledger.
  const text = (l: Ledger) => JSON.stringify(l, null, 2);
  const driven = mergeHunchJson(text(base), text(ours), text(theirs));
  assert.equal(driven.conflict, false);
  assert.equal((JSON.parse(driven.text) as Ledger).head_seq, 6);
  // Same key, different records → conflict surfaced, not silently resolved.
  const clash: Ledger = { ...theirs, idempotency: { ...theirs.idempotency, k2: { record_id: ev(3, "").record_id, record_hash: stateHash(3), facet: "commitments", seq: 2, at: "2026-09-08T10:00:03Z" } } };
  assert.equal(mergeLedgers(base, ours, clash).conflicts.length, 1);
  assert.equal(mergeHunchJson(text(base), text(ours), text(clash)).conflict, true, "the driver falls back to git's conflict handling");
  // A merged ledger round-trips through the reader's contiguity check.
  const dir = mkdtempSync(join(tmpdir(), "hunch-ledger-merge-"));
  try { writeLedger(dir, ledger); assert.equal(readLedger(dir, scope).head_seq, 6); } finally { cleanupDir(dir); }
});

// --- issue #285: a merge that renumbers published events must invalidate both sides' cursors ---

/** The issue's shape: both clones append after seq 2, theirs is EARLIER in time than ours, so the
 *  merged order gives seq 3 to theirs and seq 4 to ours. Before the fix the floor stayed 0 and a
 *  subscriber holding ours-as-3 asked after_seq=3, got ours back as 4, and never saw theirs. */
const divergedLedgers = (): { base: Ledger; ours: Ledger; theirs: Ledger } => {
  const at = (n: number, t: string): Ledger["events"][number] => ({ schema: "nuryel.state.subscribe/1", seq: n, at: t, scope, ...ev(n, "") });
  const base: Ledger = { ...emptyLedger(scope), head_seq: 2, events: [at(1, "2026-09-08T10:00:01Z"), at(2, "2026-09-08T10:00:02Z")] };
  const ourEvent = { schema: "nuryel.state.subscribe/1" as const, seq: 3, at: "2026-09-08T10:00:09Z", scope, ...ev(30, "", "ours") };
  const theirEvent = { schema: "nuryel.state.subscribe/1" as const, seq: 3, at: "2026-09-08T10:00:05Z", scope, ...ev(31, "", "theirs") };
  const ours: Ledger = { ...base, head_seq: 3, events: [...base.events, ourEvent], idempotency: { kOurs: { record_id: ourEvent.record_id, record_hash: ourEvent.record_hash, facet: "commitments", seq: 3, at: ourEvent.at } } };
  const theirs: Ledger = { ...base, head_seq: 3, events: [...base.events, theirEvent], idempotency: { kTheirs: { record_id: theirEvent.record_id, record_hash: theirEvent.record_hash, facet: "commitments", seq: 3, at: theirEvent.at } } };
  return { base, ours, theirs };
};

test("issue #285: a diverged merge raises the floor past both pre-merge heads so every stale cursor resyncs", () => {
  const { base, ours, theirs } = divergedLedgers();
  const { ledger } = mergeLedgers(base, ours, theirs);
  assert.equal(ledger.floor_seq, 4, "floor is max(pre-merge heads) + 1, not the old max floor of 0");
  assert.deepEqual(ledger.events.map((e) => [e.seq, e.cause?.kind === "write" ? e.cause.principal : ""]), [[5, "sofia@david"], [6, "sofia@david"], [7, "theirs"], [8, "ours"]], "time order, ours-before-theirs on ties, numbered from the new floor");
  assert.equal(ledger.head_seq, 8);
  for (const cursor of [0, 2, 3]) assert.ok(cursor < ledger.floor_seq, `a pre-merge cursor of ${cursor} is below the floor and must resync`);
  assert.doesNotThrow(() => assertChangeSequence(ledger.events, ledger.floor_seq), "contiguous from the new floor");
});

test("issue #285: the subscriber that held ours as seq 3 resyncs and sees BOTH sides' events", () => {
  const { base, ours, theirs } = divergedLedgers();
  const { ledger } = mergeLedgers(base, ours, theirs);
  const { store, root, cleanup } = tempStore();
  try {
    const repo = repositoryScope(store);
    const principal = { id: "sofia@david", kind: "agent" as const, grants: [repo] };
    writeLedger(join(root, ".hunch"), { ...ledger, scope: repo, events: ledger.events.map((e) => ({ ...e, scope: repo })) });
    const stale = subscribeState(store, { schema: "nuryel.state.subscribe/1", principal, scope: repo, after_seq: 3 });
    assert.equal(stale.resync, true, "the cursor that saw ours as event 3 is told to resynchronize");
    assert.equal(stale.floor_seq, 4);
    const principals = stale.events.map((e) => (e.cause?.kind === "write" ? e.cause.principal : ""));
    assert.ok(principals.includes("theirs"), "the event it never saw is delivered");
    assert.ok(principals.includes("ours"), "and the one it did see comes again, under its new seq");
    assert.deepEqual(stale.events.map((e) => e.seq), [5, 6, 7, 8], "the full retained history, served from the floor");
  } finally { cleanup(); }
});

test("issue #285: a stable merge (theirs a prefix of ours) renumbers nothing and keeps the floor", () => {
  const at = (n: number, t: string): Ledger["events"][number] => ({ schema: "nuryel.state.subscribe/1", seq: n, at: t, scope, ...ev(n, "") });
  const base: Ledger = { ...emptyLedger(scope), head_seq: 1, events: [at(1, "2026-09-08T10:00:01Z")] };
  const ours: Ledger = { ...base, head_seq: 3, events: [...base.events, at(2, "2026-09-08T10:00:02Z"), at(3, "2026-09-08T10:00:03Z")] };
  const { ledger } = mergeLedgers(base, base, ours);
  assert.equal(ledger.floor_seq, 0, "nothing moved, so no cursor is invalidated");
  assert.deepEqual(ledger.events.map((e) => e.seq), [1, 2, 3]);
  assert.equal(ledger.head_seq, 3);
  // Identical ledgers on both sides are the degenerate stable case.
  assert.equal(mergeLedgers(base, ours, ours).ledger.floor_seq, 0);
  assert.deepEqual(mergeLedgers(base, ours, ours).ledger.events.map((e) => e.seq), [1, 2, 3]);
});

test("issue #285: the raised floor clears the LARGER of the two heads, from either merge direction", () => {
  const at = (n: number, t: string): Ledger["events"][number] => ({ schema: "nuryel.state.subscribe/1", seq: n, at: t, scope, ...ev(n, "") });
  // Deliberately unequal heads: ours stopped at 3, theirs ran on to 6. A floor computed from one
  // side alone would leave the other side's published cursors above it and still blind.
  const base: Ledger = { ...emptyLedger(scope), head_seq: 2, events: [at(1, "2026-09-08T10:00:01Z"), at(2, "2026-09-08T10:00:02Z")] };
  const shortEvent = { schema: "nuryel.state.subscribe/1" as const, seq: 3, at: "2026-09-08T10:00:20Z", scope, ...ev(50, "", "short") };
  const short: Ledger = { ...base, head_seq: 3, events: [...base.events, shortEvent] };
  const long: Ledger = { ...base, head_seq: 6, events: [...base.events, at(3, "2026-09-08T10:00:03Z"), at(4, "2026-09-08T10:00:04Z"), at(5, "2026-09-08T10:00:05Z"), at(6, "2026-09-08T10:00:06Z")] };
  const expected = Math.max(short.head_seq, long.head_seq) + 1;
  assert.equal(expected, 7);
  for (const [name, a, b] of [["ours short", short, long], ["ours long", long, short]] as const) {
    const { ledger } = mergeLedgers(base, a, b);
    assert.equal(ledger.floor_seq, expected, `${name}: floor is max(BOTH heads) + 1, not one side's head`);
    assert.equal(ledger.head_seq, expected + ledger.events.length);
    assert.ok(long.head_seq < ledger.floor_seq && short.head_seq < ledger.floor_seq, `${name}: both sides' pre-merge cursors are below the floor`);
  }
});

test("issue #285: a merge that moves only THEIRS' events still raises the floor", () => {
  const at = (n: number, t: string): Ledger["events"][number] => ({ schema: "nuryel.state.subscribe/1", seq: n, at: t, scope, ...ev(n, "") });
  // Ours is earlier in time, so under plain numbering OUR seqs are unchanged (1, 2, 3) and only
  // theirs' third event moves 3 → 4. A theirs cursor at 3 would then never be told to resync and
  // would miss our event entirely — so the floor must be raised on theirs' movement alone.
  const base: Ledger = { ...emptyLedger(scope), head_seq: 2, events: [at(1, "2026-09-08T10:00:01Z"), at(2, "2026-09-08T10:00:02Z")] };
  const ourEvent = { schema: "nuryel.state.subscribe/1" as const, seq: 3, at: "2026-09-08T10:00:03Z", scope, ...ev(60, "", "ours") };
  const theirEvent = { schema: "nuryel.state.subscribe/1" as const, seq: 3, at: "2026-09-08T10:00:04Z", scope, ...ev(61, "", "theirs") };
  const ours: Ledger = { ...base, head_seq: 3, events: [...base.events, ourEvent] };
  const theirs: Ledger = { ...base, head_seq: 3, events: [...base.events, theirEvent] };
  const { ledger } = mergeLedgers(base, ours, theirs);
  assert.deepEqual(ledger.events.map((e) => (e.cause?.kind === "write" ? e.cause.principal : "")), ["sofia@david", "sofia@david", "ours", "theirs"], "ours sorts before theirs, so only theirs' seq would move");
  assert.equal(ledger.floor_seq, 4, "theirs' event moving from 3 to 4 is enough to invalidate every cursor");
  assert.deepEqual(ledger.events.map((e) => e.seq), [5, 6, 7, 8]);
  assert.ok(theirs.head_seq < ledger.floor_seq, "a theirs cursor at 3 is below the floor and resyncs instead of missing ours' event");
});

test("issue #360: an event compacted on one side survives when the other still retains it", () => {
  // Base holds a same-`at` batch; only one clone compacted its first event.
  const at = (n: number, t: string): Ledger["events"][number] => ({ schema: "nuryel.state.subscribe/1", seq: n, at: t, scope, ...ev(n, "") });
  const batchAt = "2026-09-08T10:00:01Z";
  const base: Ledger = { ...emptyLedger(scope), head_seq: 3, events: [at(1, batchAt), at(2, batchAt), at(3, "2026-09-08T10:00:03Z")] };
  const compacted: Ledger = { ...base, floor_seq: 1, events: base.events.slice(1) };
  const { ledger } = mergeLedgers(base, compacted, base);
  assert.deepEqual(ledger.events.map((e) => e.record_id.slice(-2)), ["01", "02", "03"], "history retained by either clone survives");
});

test("issues #285 and #361: a same-`at` batch keeps its place and new ties sort by identity, not by side", () => {
  // The whole batch shares one `at`: two events BOTH sides retained (equal-but-distinct copies off
  // disk), then one event only ours has and one only theirs has. The shared pair keeps its place;
  // the two new events are ordered by identity (70 < 71), the same in either merge direction.
  const tie = "2026-09-08T10:00:09Z";
  const at = (n: number): Ledger["events"][number] => ({ schema: "nuryel.state.subscribe/1", seq: n, at: tie, scope, ...ev(n, "") });
  const base: Ledger = { ...emptyLedger(scope), head_seq: 2, events: [at(1), at(2)] };
  const ourEvent = { schema: "nuryel.state.subscribe/1" as const, seq: 3, at: tie, scope, ...ev(70, "", "ours") };
  const theirEvent = { schema: "nuryel.state.subscribe/1" as const, seq: 3, at: tie, scope, ...ev(71, "", "theirs") };
  const clone = (): Ledger["events"] => base.events.map((e) => ({ ...e }));
  const ours: Ledger = { ...base, head_seq: 3, events: [...clone(), ourEvent] };
  const theirs: Ledger = { ...base, head_seq: 3, events: [...clone(), theirEvent] };
  const { ledger } = mergeLedgers(base, ours, theirs);
  assert.deepEqual(ledger.events.map((e) => (e.cause?.kind === "write" ? e.cause.principal : "")), ["sofia@david", "sofia@david", "ours", "theirs"], "the shared pair keeps its place and the new events sort by identity");
  const swapped = mergeLedgers(base, theirs, ours).ledger;
  assert.deepEqual(swapped.events, ledger.events, "merge direction does not change the order");
});

test("issue #361: same-time cross-clone merges converge and a second merge keeps the floor", () => {
  const tie = "2026-09-08T10:00:09Z";
  const base = emptyLedger(scope);
  const event = (n: number, principal: string): Ledger["events"][number] => ({
    schema: "nuryel.state.subscribe/1", seq: 1, at: tie, scope, ...ev(n, "", principal),
  });
  const a: Ledger = { ...base, head_seq: 1, events: [event(80, "a")] };
  const b: Ledger = { ...base, head_seq: 1, events: [event(81, "b")] };
  const ab = mergeLedgers(base, a, b).ledger;
  const ba = mergeLedgers(base, b, a).ledger;
  assert.deepEqual(ab.events, ba.events, "merge direction cannot change equal-time event order");
  assert.equal(ab.floor_seq, ba.floor_seq);
  const settled = mergeLedgers(base, ab, ba).ledger;
  assert.deepEqual(settled.events, ab.events);
  assert.equal(settled.floor_seq, ab.floor_seq, "a settled re-merge cannot ratchet the floor");
});

test("issue #361: merging identical same-time batches does not renumber published events", () => {
  const tie = "2026-09-08T10:00:09Z";
  const base = emptyLedger(scope);
  const events: Ledger["events"] = [81, 80].map((n, i) => ({
    schema: "nuryel.state.subscribe/1", seq: i + 1, at: tie, scope, ...ev(n, "", String(n)),
  }));
  const both: Ledger = { ...base, head_seq: 2, events };
  const merged = mergeLedgers(base, both, both).ledger;
  assert.deepEqual(merged.events, events);
  assert.equal(merged.floor_seq, 0);
});

test("issue #361: different merge ancestors still produce one same-time order", () => {
  const tie = "2026-09-08T10:00:09Z";
  const empty = emptyLedger(scope);
  const event = (n: number, seq: number): Ledger["events"][number] => ({
    schema: "nuryel.state.subscribe/1", seq, at: tie, scope, ...ev(n, "", String(n)),
  });
  const a: Ledger = { ...empty, head_seq: 1, events: [event(80, 1)] };
  const b: Ledger = { ...empty, head_seq: 1, events: [event(81, 1)] };
  const ab = mergeLedgers(empty, a, b).ledger;
  const ac: Ledger = { ...a, head_seq: 2, events: [...a.events, event(82, 2)] };
  const bc: Ledger = { ...b, head_seq: 2, events: [...b.events, event(82, 2)] };
  const viaA = mergeLedgers(a, ab, ac).ledger;
  const viaB = mergeLedgers(b, ab, bc).ledger;
  assert.deepEqual(viaA.events.map((e) => e.record_id), viaB.events.map((e) => e.record_id));
});

test("issue #361: an unrelated merge cannot reverse published same-time updates to one record", () => {
  const tie = "2026-09-08T10:00:09Z";
  const recordId = ev(90, "").record_id;
  const first = { schema: "nuryel.state.subscribe/1" as const, seq: 1, at: tie, scope, ...ev(90, ""), change: "updated" as const, record_hash: `sha256:${"f".repeat(64)}` };
  const second = { ...first, seq: 2, record_hash: `sha256:${"a".repeat(64)}`, change: "updated" as const };
  const base: Ledger = { ...emptyLedger(scope), head_seq: 2, events: [first, second] };
  const appended = (n: number, at: string): Ledger["events"][number] => ({ schema: "nuryel.state.subscribe/1", seq: 3, at, scope, ...ev(n, "") });
  const ours: Ledger = { ...base, head_seq: 3, events: [...base.events, appended(91, "2026-09-08T10:00:10Z")] };
  const theirs: Ledger = { ...base, head_seq: 3, events: [...base.events, appended(92, "2026-09-08T10:00:11Z")] };
  const merged = mergeLedgers(base, ours, theirs).ledger;
  assert.deepEqual(merged.events.filter((e) => e.record_id === recordId).map((e) => e.record_hash), [first.record_hash, second.record_hash]);
  assert.equal(foldLedger(merged).get(recordId)?.record_hash, second.record_hash);
});

test("issue #361: clones an older merge left with opposite same-time orders converge without a conflict", () => {
  // The population #361 left behind: base [h1]; one clone appended h2, the other h3, all at one
  // `at`; the old side-biased merge published [h1,h2,h3] on one clone and [h1,h3,h2] on the other.
  const tie = "2026-09-08T10:00:03Z";
  const upd = (h: string, seq: number): Ledger["events"][number] => ({ schema: "nuryel.state.subscribe/1", seq, at: tie, scope, ...ev(1, ""), change: "updated", record_hash: `sha256:${h.repeat(64)}` });
  const base: Ledger = { ...emptyLedger(scope), head_seq: 1, events: [upd("1", 1)] };
  const oab: Ledger = { ...base, floor_seq: 3, head_seq: 6, events: [upd("1", 4), upd("2", 5), upd("3", 6)] };
  const oba: Ledger = { ...base, floor_seq: 3, head_seq: 6, events: [upd("1", 4), upd("3", 5), upd("2", 6)] };
  const one = mergeLedgers(base, oab, oba);
  const other = mergeLedgers(base, oba, oab);
  assert.deepEqual(one.conflicts, [], "the merge driver resolves it instead of leaving conflict markers");
  assert.equal(mergeHunchJson(JSON.stringify(base), JSON.stringify(oab), JSON.stringify(oba)).conflict, false);
  assert.deepEqual(one.ledger.events, other.ledger.events, "both clones land on the same order");
  assert.ok(one.ledger.floor_seq >= 7, "published seqs moved, so every subscriber resyncs");
  const settled = mergeLedgers(base, one.ledger, other.ledger).ledger;
  assert.deepEqual(settled.events, one.ledger.events);
  assert.equal(settled.floor_seq, one.ledger.floor_seq, "and the next merge renumbers nothing");
  const recordId = ev(1, "").record_id;
  assert.equal(foldLedger(one.ledger).get(recordId)?.record_hash, foldLedger(other.ledger).get(recordId)?.record_hash);
});

test("issue #361: merge order independence — random same-time forks converge in one merge", () => {
  // Deterministic PRNG so a failure reproduces; each round forks a shared base into two clones that
  // append batches (many sharing one `at`), then merges both directions and re-merges the results.
  let s = 361;
  const rand = (n: number): number => { s = (s * 1103515245 + 12345) % 2147483648; return s % n; };
  const times = ["2026-09-08T10:00:01Z", "2026-09-08T10:00:02Z", "2026-09-08T10:00:03Z"];
  for (let round = 0; round < 200; round++) {
    let n = 100;
    const grow = (l: Ledger, k: number, who: string): Ledger => {
      const events = [...l.events];
      for (let i = 0; i < k; i++) events.push({ schema: "nuryel.state.subscribe/1", seq: l.head_seq + i + 1, at: times[rand(times.length)]!, scope, ...ev(n++ + rand(5) * 1000, "", who) });
      events.sort((x, y) => x.at.localeCompare(y.at) || x.seq - y.seq);
      return { ...l, head_seq: l.head_seq + k, events: events.map((e, i) => ({ ...e, seq: l.floor_seq + i + 1 })) };
    };
    const base = grow(emptyLedger(scope), rand(3), "base");
    const a = grow(base, 1 + rand(3), "a");
    const b = grow(base, 1 + rand(3), "b");
    const ab = mergeLedgers(base, a, b);
    const ba = mergeLedgers(base, b, a);
    assert.deepEqual(ab.ledger.events, ba.ledger.events, `round ${round}: direction-independent`);
    assert.equal(ab.ledger.floor_seq, ba.ledger.floor_seq, `round ${round}: same floor`);
    const again = mergeLedgers(base, ab.ledger, ba.ledger).ledger;
    assert.deepEqual(again.events, ab.ledger.events, `round ${round}: re-merge renumbers nothing`);
    assert.equal(again.floor_seq, ab.ledger.floor_seq, `round ${round}: re-merge keeps the floor`);
    for (const side of [a, b]) {
      const pos = new Map(ab.ledger.events.map((e, i) => [`${e.record_id}|${e.cause?.kind === "write" ? e.cause.principal : ""}`, i]));
      const order = side.events.map((e) => pos.get(`${e.record_id}|${e.cause?.kind === "write" ? e.cause.principal : ""}`)!);
      assert.deepEqual(order, [...order].sort((x, y) => x - y), `round ${round}: each side keeps its own order`);
    }
  }
});

test("issue #285: a renumbering merge of compacted ledgers respects the existing floor and the events-start-at-floor+1 invariant", () => {
  const at = (n: number, t: string): Ledger["events"][number] => ({ schema: "nuryel.state.subscribe/1", seq: n, at: t, scope, ...ev(n, "") });
  const base: Ledger = { ...emptyLedger(scope), floor_seq: 10, head_seq: 11, events: [at(11, "2026-09-08T10:00:01Z")] };
  const ourEvent = { schema: "nuryel.state.subscribe/1" as const, seq: 12, at: "2026-09-08T10:00:09Z", scope, ...ev(40, "", "ours") };
  const theirEvent = { schema: "nuryel.state.subscribe/1" as const, seq: 12, at: "2026-09-08T10:00:05Z", scope, ...ev(41, "", "theirs") };
  const ours: Ledger = { ...base, head_seq: 12, events: [...base.events, ourEvent] };
  const theirs: Ledger = { ...base, head_seq: 12, events: [...base.events, theirEvent] };
  const { ledger } = mergeLedgers(base, ours, theirs);
  assert.equal(ledger.floor_seq, 13, "max(old floors, max head + 1)");
  assert.deepEqual(ledger.events.map((e) => e.seq), [14, 15, 16], "events start at floor + 1");
  assert.equal(ledger.head_seq, 16);
  assert.equal(ledger.head_seq, ledger.floor_seq + ledger.events.length);
  const dir = mkdtempSync(join(tmpdir(), "hunch-ledger-285-"));
  try { writeLedger(dir, ledger); assert.equal(readLedger(dir, scope).floor_seq, 13, "the reader's contiguity check accepts it"); } finally { cleanupDir(dir); }
});

test("issue #285: idempotency entries follow their event's new seq across a renumbering merge", () => {
  const { base, ours, theirs } = divergedLedgers();
  const { ledger, conflicts } = mergeLedgers(base, ours, theirs);
  assert.deepEqual(conflicts, []);
  const seqOf = (principal: string) => ledger.events.find((e) => e.cause?.kind === "write" && e.cause.principal === principal)!.seq;
  assert.equal(ledger.idempotency.kTheirs?.seq, seqOf("theirs"));
  assert.equal(ledger.idempotency.kOurs?.seq, seqOf("ours"));
  // An entry whose event is not in the merged history keeps its old seq — below the floor, never
  // above the head — exactly as after a compaction.
  const orphaned: Ledger = { ...ours, idempotency: { ...ours.idempotency, kGone: { record_id: ev(99, "").record_id, record_hash: stateHash(99), facet: "commitments", seq: 2, at: "2026-09-08T10:00:02Z" } } };
  const withOrphan = mergeLedgers(base, orphaned, theirs).ledger;
  assert.equal(withOrphan.idempotency.kGone?.seq, 2);
  assert.ok(withOrphan.idempotency.kGone!.seq <= withOrphan.head_seq, "never points above the head");
});

test("issue #360: merging two compacted clones does not resurrect base-only history", () => {
  const at = (n: number): Ledger["events"][number] => ({ schema: "nuryel.state.subscribe/1", seq: n, at: `2026-09-08T10:00:0${n}Z`, scope, ...ev(n, "") });
  const base: Ledger = { ...emptyLedger(scope), head_seq: 3, events: [at(1), at(2), at(3)] };
  const ours: Ledger = { ...base, floor_seq: 2, head_seq: 4, events: [at(3), at(4)] };
  const theirs: Ledger = { ...base, floor_seq: 2, head_seq: 4, events: [at(3), { ...at(5), seq: 4 }] };
  const { ledger } = mergeLedgers(base, ours, theirs);
  assert.deepEqual(ledger.events.map((e) => e.record_id), [3, 4, 5].map((n) => ev(n, "").record_id));
  assert.ok(ledger.floor_seq >= 2);
  assert.doesNotThrow(() => assertChangeSequence(ledger.events, ledger.floor_seq));
});
