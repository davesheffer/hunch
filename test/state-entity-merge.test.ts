/**
 * Audited entity merge and split: a retired entity names its survivor in `merged_into`, the ledger
 * holds the `retired` event, nothing under the old id is rewritten, reads resolve to the survivor,
 * new state is refused under the old name, and the split is the explicit reverse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore } from "./helpers.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { StateRefusal, partitionOf, readState, writeState } from "../src/store/stateBinding.js";
import { readLedger } from "../src/store/changeLedger.js";
import { verifyReplay } from "../src/store/replay.js";
import { commitmentId, entityId } from "../src/core/stateContract.js";

const prov = { source: "human_confirmed", confidence: 1, evidence: ["david: same clinic, two CRM sites"] };
const agentProv = { source: "imported:sofia", confidence: 0.9, evidence: ["sofia"] };
const site7 = { system: "crm", object_type: "site", object_key: "7", observed_at: "2026-09-09T08:00:00Z" };
const site8 = { system: "crm", object_type: "site", object_key: "8", observed_at: "2026-09-09T08:00:00Z" };
const chat = { system: "whatsapp", object_type: "chat", object_key: "972500000001@c.us", observed_at: "2026-09-09T08:00:00Z" };

function principal(store: HunchStore, kind: "human" | "agent" = "agent") {
  return { id: kind === "human" ? "david" : "sofia-1", kind, grants: [partitionOf(store)] };
}
function write(store: HunchStore, facet: string, record: Record<string, unknown>, key: string, over: Record<string, unknown> = {}, who: "human" | "agent" = "agent") {
  return writeState(store, { schema: "nuryel.state.write/1", principal: principal(store, who), scope: partitionOf(store), facet, record, idempotency_key: `entity-merge-${key}`, ...over });
}
function entity(store: HunchStore, id: string, refs: unknown[], over: Record<string, unknown> = {}) {
  return { schema: "nuryel.entity/1", id, kind: "customer", name: id, scope: partitionOf(store), refs, attributes: {}, lifecycle: "active", provenance: agentProv, created_at: "2026-09-09T08:00:00Z", updated_at: "2026-09-09T08:00:00Z", ...over };
}
function commitment(store: HunchStore, subject: string, title: string) {
  const base = { scope: partitionOf(store), subject, title, owner: "sofia-1", due: "2026-09-11" };
  return { schema: "nuryel.commitment/1", id: commitmentId(base), ...base, status: "open", valid_from: "2026-09-09T08:00:00Z", valid_to: null, provenance: agentProv };
}
function inForce(store: HunchStore, subject: string): string[] {
  return readState(store, { schema: "nuryel.state.read/1", principal: principal(store), scope: partitionOf(store), subject }).response.state_of_record!.in_force.map((r) => r.id).sort();
}
function refusal(fn: () => unknown, code: StateRefusal["code"]): StateRefusal {
  try { fn(); } catch (e) {
    assert.ok(e instanceof StateRefusal, `expected a StateRefusal, got ${(e as Error).message}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected a ${code} refusal`);
}

test("merge: the retired entity names the survivor, the ledger says retired, both histories read as one, new state is refused under the old name", () => {
  const { store, cleanup } = tempStore();
  try {
    const a = entityId("customer", "clinic-7");
    const b = entityId("customer", "clinic-8");
    write(store, "entities", entity(store, a, [site7, chat]), "a");
    write(store, "entities", entity(store, b, [site8]), "b");
    const ca = write(store, "commitments", commitment(store, a, "send the results"), "ca").record_id;
    const cb = write(store, "commitments", commitment(store, b, "call back"), "cb").record_id;
    assert.deepEqual(inForce(store, a), [ca]);
    // David: same clinic, two CRM sites. A merges into B.
    const merged = write(store, "entities", entity(store, a, [site7, chat], { lifecycle: "retired", merged_into: b, provenance: prov }), "merge", {}, "human");
    assert.equal(merged.outcome, "updated");
    const ledger = readLedger(hunchPaths(store.publicRoot).hunch, partitionOf(store));
    assert.equal(ledger.events.at(-1)?.change, "retired");
    assert.equal(ledger.events.at(-1)?.subject, a);
    // Nothing under A was rewritten; every name now reads as one state of record.
    assert.equal(store.getRec("commitments", ca)?.subject, a);
    for (const name of [a, b, "site:7", "site:8", "chat:972500000001@c.us"]) assert.deepEqual(inForce(store, name), [ca, cb].sort(), name);
    const sor = readState(store, { schema: "nuryel.state.read/1", principal: principal(store), scope: partitionOf(store), subject: "site:7" }).response.state_of_record!;
    assert.deepEqual(sor.current.map((r) => r.id), [b], "only the survivor is current");
    // New state under the old id or its keys is refused with the survivor named.
    for (const subject of [a, "site:7"]) {
      const e = refusal(() => write(store, "commitments", commitment(store, subject, "new thing"), `new-${subject}`), "identity");
      assert.equal(e.conflict?.incumbent_id, b);
    }
    assert.equal(write(store, "commitments", commitment(store, b, "new thing"), "new-b").outcome, "created");
    // The survivor may now carry A's keys too (A is retired): still one active entity per key.
    assert.equal(write(store, "entities", entity(store, b, [site8, site7, chat]), "b2").outcome, "updated");
    assert.equal(verifyReplay(store, partitionOf(store)).ok, true);
  } finally { cleanup(); }
});

test("merge refusals: a survivor must exist, be active, and not be the entity itself; a merged entity is retired; chains resolve to the one that stands", () => {
  const { store, cleanup } = tempStore();
  try {
    const a = entityId("customer", "a");
    const b = entityId("customer", "b");
    const c = entityId("customer", "c");
    write(store, "entities", entity(store, a, [site7]), "a");
    refusal(() => write(store, "entities", entity(store, a, [site7], { lifecycle: "retired", merged_into: b }), "absent"), "conflict");
    refusal(() => write(store, "entities", entity(store, a, [site7], { lifecycle: "active", merged_into: b }), "active-merged"), "malformed");
    refusal(() => write(store, "entities", entity(store, a, [site7], { lifecycle: "retired", merged_into: a }), "self"), "malformed");
    write(store, "entities", entity(store, b, [site8]), "b");
    write(store, "entities", entity(store, c, [chat]), "c");
    write(store, "entities", entity(store, a, [site7], { lifecycle: "retired", merged_into: b }), "a-into-b");
    write(store, "entities", entity(store, b, [site8], { lifecycle: "retired", merged_into: c }), "b-into-c");
    // Merging into an entity that was itself merged names the one that stands.
    const e = refusal(() => write(store, "entities", entity(store, entityId("customer", "d"), [{ ...site7, object_key: "9" }], { lifecycle: "retired", merged_into: b }), "into-merged"), "conflict");
    assert.equal(e.conflict?.incumbent_id, c);
    // A → B → C: site:7 resolves to C.
    const cc = write(store, "commitments", commitment(store, c, "under c"), "cc").record_id;
    assert.deepEqual(inForce(store, "site:7"), [cc]);
    assert.equal(refusal(() => write(store, "commitments", commitment(store, a, "under a"), "ca"), "identity").conflict?.incumbent_id, c);
    assert.equal(verifyReplay(store, partitionOf(store)).ok, true);
  } finally { cleanup(); }
});

test("split: the explicit reverse — re-key the survivor, write the entity active again without merged_into; the ledger holds both moves", () => {
  const { store, cleanup } = tempStore();
  try {
    const a = entityId("customer", "clinic-7");
    const b = entityId("customer", "clinic-8");
    write(store, "entities", entity(store, a, [site7]), "a");
    write(store, "entities", entity(store, b, [site8]), "b");
    write(store, "entities", entity(store, a, [site7], { lifecycle: "retired", merged_into: b }), "merge");
    write(store, "entities", entity(store, b, [site8, site7]), "b-absorbs");
    // Reviving A while B still carries site:7 is refused: one active entity per key.
    refusal(() => write(store, "entities", entity(store, a, [site7]), "revive-early"), "conflict");
    write(store, "entities", entity(store, b, [site8]), "b-rekey");
    const revived = write(store, "entities", entity(store, a, [site7]), "revive");
    assert.equal(revived.outcome, "updated");
    assert.equal(store.getRec("entities", a)?.lifecycle, "active");
    assert.equal(store.getRec("entities", a)?.merged_into, undefined);
    const ca = write(store, "commitments", commitment(store, a, "again"), "ca").record_id;
    assert.deepEqual(inForce(store, "site:7"), [ca]);
    assert.deepEqual(inForce(store, "site:8"), []);
    const changes = readLedger(hunchPaths(store.publicRoot).hunch, partitionOf(store)).events.filter((e) => e.record_id === a).map((e) => e.change);
    assert.deepEqual(changes, ["created", "retired", "updated"]);
    assert.equal(verifyReplay(store, partitionOf(store)).ok, true);
  } finally { cleanup(); }
});
