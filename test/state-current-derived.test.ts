/**
 * one-current-derived-per-subject-transform: a subject holds at most one current derived
 * statement per transform. A new statement beside it must name it in `supersedes`; the same
 * identity written again updates or replays; a different transform is a different statement;
 * observations (state unknown) are never affected. Found by the half-year farm (fnd_1939ced249).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore } from "./helpers.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { StateRefusal, partitionOf, readState, writeState } from "../src/store/stateBinding.js";
import { STATE_INVARIANTS, derivedId, stateHash } from "../src/core/stateContract.js";

const prov = (who: string, source = "agent_recorded") => ({ source, confidence: 0.9, evidence: [`${who} derived it`] });
const ref = (day: string) => ({ system: "crm", object_type: "event", object_key: "26879", observed_at: `${day}T09:00:00Z`, content_hash: stateHash(`event-${day}`) });

function principal(store: HunchStore, id: string, kind: "agent" | "human" = "agent") {
  return { id, kind, grants: [partitionOf(store)] };
}
function derived(store: HunchStore, who: string, day: string, transform = "summary/v1", content = `state as of ${day}`) {
  const body = { schema: "nuryel.derived/1", scope: partitionOf(store), subject: "customer:c1", content, content_hash: stateHash(content), dependencies: [{ kind: "external", ref: ref(day) }], transform_version: transform, computed_at: `${day}T09:00:00Z`, valid_to: null, state: "current", provenance: prov(who) };
  return body;
}
function write(store: HunchStore, who: string, record: Record<string, unknown>, key: string, over: Record<string, unknown> = {}, kind: "agent" | "human" = "agent") {
  return writeState(store, { schema: "nuryel.state.write/1", principal: principal(store, who, kind), scope: partitionOf(store), facet: "derived", record, idempotency_key: `${who}-${key}`, ...over });
}
function refusal(fn: () => unknown, code: StateRefusal["code"]): StateRefusal {
  try { fn(); } catch (e) {
    assert.ok(e instanceof StateRefusal, `expected a StateRefusal, got ${(e as Error).message}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected a ${code} refusal`);
}
function current(store: HunchStore, who: string) {
  const read = readState(store, { schema: "nuryel.state.read/1", principal: principal(store, who), scope: partitionOf(store), subject: "customer:c1" });
  return read.response.state_of_record!.current.filter((r) => r.facet === "derived").map((r) => r.id).sort();
}

test("a second current statement under the same transform without supersedes is refused with the incumbent named; naming it supersedes; the same identity updates", () => {
  const { store, cleanup } = tempStore();
  try {
    assert.ok(STATE_INVARIANTS.some((i) => i.id === "one-current-derived-per-subject-transform"));
    const first = write(store, "sofia-1", derived(store, "sofia-1", "2026-09-01"), "d1");
    assert.equal(first.outcome, "created");
    const second = derived(store, "sofia-2", "2026-09-02");
    const e = refusal(() => write(store, "sofia-2", second, "d2"), "conflict");
    assert.equal(e.conflict?.incumbent_id, first.record_id);
    assert.equal(e.conflict?.reason, "one-current-derived-per-subject-transform");
    assert.match(e.message, /customer:c1 already has a current summary\/v1 statement/);
    assert.deepEqual(current(store, "sofia-2"), [first.record_id], "still exactly one current statement");
    const replaced = write(store, "sofia-2", second, "d2-named", { supersedes: first.record_id });
    assert.equal(replaced.outcome, "superseded");
    assert.deepEqual(current(store, "sofia-2"), [derivedId(second as Parameters<typeof derivedId>[0])], "the successor is the one current statement");
    // The same identity written again is an update of that record, not a second statement.
    const again = write(store, "sofia-2", { ...second, content: "reworded", content_hash: stateHash("reworded") }, "d3");
    assert.ok(["updated", "replayed"].includes(again.outcome), again.outcome);
    assert.equal(current(store, "sofia-2").length, 1);
  } finally { cleanup(); }
});

test("a different transform on the same subject is a different statement; an observation (state unknown) is never affected", () => {
  const { store, cleanup } = tempStore();
  try {
    const a = write(store, "sofia-1", derived(store, "sofia-1", "2026-09-01", "summary/v1"), "v1");
    const b = write(store, "sofia-1", derived(store, "sofia-1", "2026-09-01", "event-snapshot/v1", "snapshot"), "snap");
    assert.equal(a.outcome, "created"); assert.equal(b.outcome, "created");
    assert.equal(current(store, "sofia-1").length, 2, "two transforms, two current statements");
    // An observation-shaped statement (state unknown) beside the current v1 summary is not a rival current statement.
    const observation = { ...derived(store, "observer", "2026-09-02", "summary/v1", "seen: opens Friday"), state: "unknown" };
    assert.equal(write(store, "observer", observation, "obs").outcome, "created", "observations are not current statements");
  } finally { cleanup(); }
});

test("a human-confirmed current statement: an agent may not add a rival under the same transform, and may not supersede the human's either", () => {
  const { store, cleanup } = tempStore();
  try {
    const human = derived(store, "david", "2026-09-01"); human.provenance = prov("david", "human_confirmed");
    const h = write(store, "david", human, "h1", {}, "human");
    assert.equal(h.outcome, "created");
    const rival = derived(store, "sofia-hasty", "2026-09-03");
    const e1 = refusal(() => write(store, "sofia-hasty", rival, "r1"), "conflict");
    assert.equal(e1.conflict?.reason, "one-current-derived-per-subject-transform");
    const e2 = refusal(() => write(store, "sofia-hasty", rival, "r2", { supersedes: h.record_id }), "conflict");
    assert.match(e2.message, /confirmed by a human/);
    assert.deepEqual(current(store, "sofia-hasty"), [h.record_id], "the human's statement stays the only current one");
  } finally { cleanup(); }
});
