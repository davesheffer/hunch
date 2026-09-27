/**
 * PILOT5 hidden validator for issue #360 (repeated-bug card).
 * Derived verbatim from the two "issue #360" regression tests the fix (48f391a) added to
 * test/change-ledger.test.ts. Uses only exports that already exist at the starting commit
 * (emptyLedger, mergeLedgers, Ledger, assertChangeSequence, stateHash).
 * Run from the target checkout: copy into test/ and `node tooling/run-tests.mjs test/pilot5-issue-360.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyLedger, mergeLedgers, type Ledger } from "../src/store/changeLedger.js";
import { assertChangeSequence, stateHash } from "../src/core/stateContract.js";

const scope = { kind: "user" as const, id: "david" };
const ev = (n: number, at: string, principal = "sofia@david") => ({ facet: "commitments" as const, record_id: `ncm_${String(n).padStart(24, "0")}`, record_hash: stateHash(n), change: "created" as const, invalidates: [], cause: { kind: "write" as const, principal } });

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

// Guard against an over-broad fix: history that either clone still retains must survive.
test("issue #360: an event compacted on one side survives when the other still retains it", () => {
  const at = (n: number, t: string): Ledger["events"][number] => ({ schema: "nuryel.state.subscribe/1", seq: n, at: t, scope, ...ev(n, "") });
  const batchAt = "2026-09-08T10:00:01Z";
  const base: Ledger = { ...emptyLedger(scope), head_seq: 3, events: [at(1, batchAt), at(2, batchAt), at(3, "2026-09-08T10:00:03Z")] };
  const compacted: Ledger = { ...base, floor_seq: 1, events: base.events.slice(1) };
  const { ledger } = mergeLedgers(base, compacted, base);
  assert.deepEqual(ledger.events.map((e) => e.record_id.slice(-2)), ["01", "02", "03"], "history retained by either clone survives");
});
