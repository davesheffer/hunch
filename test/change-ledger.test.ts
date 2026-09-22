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
  try { writeLedger(dir, ledger); assert.equal(readLedger(dir, scope).head_seq, 6); } finally { rmSync(dir, { recursive: true, force: true }); }
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

test("issue #285: the ours-before-theirs tiebreak keeps a batch both sides retained in its original order", () => {
  // The repro: base holds a same-`at` batch (1, 2) plus a later event; BOTH clones compacted to
  // floor 1, so event 1 survives only as base's object. Under an object-identity `side` rule it
  // counted as theirs and sorted after event 2, flipping a batch nobody touched.
  const at = (n: number, t: string): Ledger["events"][number] => ({ schema: "nuryel.state.subscribe/1", seq: n, at: t, scope, ...ev(n, "") });
  const batchAt = "2026-09-08T10:00:01Z";
  const base: Ledger = { ...emptyLedger(scope), head_seq: 3, events: [at(1, batchAt), at(2, batchAt), at(3, "2026-09-08T10:00:03Z")] };
  const compacted: Ledger = { ...base, floor_seq: 1, events: base.events.slice(1) };
  const { ledger } = mergeLedgers(base, compacted, compacted);
  assert.deepEqual(ledger.events.map((e) => e.record_id.slice(-2)), ["01", "02", "03"], "the batch keeps the order base recorded it in");
});

test("issue #285: on a same-`at` tie an ours-only event still sorts before a theirs-only one", () => {
  // `side` is only consulted on a tie, so the whole batch shares one `at`: two events BOTH sides
  // retained, then one event only ours has and one only theirs has. `add` keeps base's objects for
  // the shared pair, and both clones read equal-but-distinct copies off disk — so the old
  // `ours.events.includes(e)` object-identity rule calls the shared pair "theirs" and sorts it
  // behind our new event, scrambling a batch order neither clone changed.
  const tie = "2026-09-08T10:00:09Z";
  const at = (n: number): Ledger["events"][number] => ({ schema: "nuryel.state.subscribe/1", seq: n, at: tie, scope, ...ev(n, "") });
  const base: Ledger = { ...emptyLedger(scope), head_seq: 2, events: [at(1), at(2)] };
  const ourEvent = { schema: "nuryel.state.subscribe/1" as const, seq: 3, at: tie, scope, ...ev(70, "", "ours") };
  const theirEvent = { schema: "nuryel.state.subscribe/1" as const, seq: 3, at: tie, scope, ...ev(71, "", "theirs") };
  const clone = (): Ledger["events"] => base.events.map((e) => ({ ...e }));
  const ours: Ledger = { ...base, head_seq: 3, events: [...clone(), ourEvent] };
  const theirs: Ledger = { ...base, head_seq: 3, events: [...clone(), theirEvent] };
  const { ledger } = mergeLedgers(base, ours, theirs);
  assert.deepEqual(ledger.events.map((e) => (e.cause?.kind === "write" ? e.cause.principal : "")), ["sofia@david", "sofia@david", "ours", "theirs"], "the shared pair keeps its place and the ours-only event beats the theirs-only one");
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
  try { writeLedger(dir, ledger); assert.equal(readLedger(dir, scope).floor_seq, 13, "the reader's contiguity check accepts it"); } finally { rmSync(dir, { recursive: true, force: true }); }
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
