/**
 * Subject identity by external reference (one-entity-per-external-ref): N agents over one CRM
 * record land on ONE subject — explicit refs only, refused at write time, resolved on read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore } from "./helpers.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { StateRefusal, partitionOf, readState, writeState } from "../src/store/stateBinding.js";
import { verifyReplay } from "../src/store/replay.js";
import { STATE_INVARIANTS, canonicalObjectKey, commitmentId, entityId, externalKey, stateHash, subjectOfRef } from "../src/core/stateContract.js";

const prov = (who: string) => ({ source: "imported:sofia", confidence: 0.9, evidence: [`${who} saw it`] });
const site = { system: "crm", object_type: "site", object_key: "7", version: "12", observed_at: "2026-09-09T08:00:00Z" };
const thread = { system: "gmail", object_type: "thread", object_key: "18c2f0a9", observed_at: "2026-09-09T08:05:00Z" };

function principal(store: HunchStore, id: string) {
  return { id, kind: "agent" as const, grants: [partitionOf(store)] };
}
function write(store: HunchStore, who: string, facet: string, record: Record<string, unknown>, key: string, over: Record<string, unknown> = {}) {
  return writeState(store, { schema: "nuryel.state.write/1", principal: principal(store, who), scope: partitionOf(store), facet, record, idempotency_key: `${who}-${key}`, ...over });
}
function entity(store: HunchStore, id: string, refs: unknown[], who: string, over: Record<string, unknown> = {}) {
  return { schema: "nuryel.entity/1", id, kind: "customer", name: "Clinic Seven", scope: partitionOf(store), refs, attributes: {}, lifecycle: "active", provenance: prov(who), created_at: "2026-09-09T08:00:00Z", updated_at: "2026-09-09T08:00:00Z", ...over };
}
function commitment(store: HunchStore, subject: string, who: string, over: Record<string, unknown> = {}) {
  const base = { scope: partitionOf(store), subject, title: "send the pilot training results", owner: "sofia", due: "2026-09-11" };
  return { schema: "nuryel.commitment/1", id: commitmentId(base), ...base, status: "open", valid_from: "2026-09-09T08:00:00Z", valid_to: null, provenance: prov(who), ...over };
}
function refusal(fn: () => unknown, code: StateRefusal["code"]): StateRefusal {
  try { fn(); } catch (e) {
    assert.ok(e instanceof StateRefusal, `expected a StateRefusal, got ${(e as Error).message}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected a ${code} refusal`);
}

test("canonical external key: NFC, trimmed, whitespace collapsed, case preserved; the subject form is the read verb's convention", () => {
  assert.equal(canonicalObjectKey("  Site:7 Å  x "), "Site:7 Å x");
  assert.equal(externalKey({ system: "crm", object_type: "site", object_key: " 7 " }), "crm/site/7");
  assert.equal(subjectOfRef({ object_type: "event", object_key: "26904" }), "event:26904");
  assert.notEqual(externalKey({ system: "crm", object_type: "site", object_key: "ABC" }), externalKey({ system: "crm", object_type: "site", object_key: "abc" }), "case is the external system's");
  assert.ok(STATE_INVARIANTS.some((i) => i.id === "one-entity-per-external-ref"));
});

test("one entity per external record: a second agent's entity for the same CRM site is refused with the incumbent named; replaying the incumbent is fine", () => {
  const { store, cleanup } = tempStore();
  try {
    const clinic = entityId("customer", "clinic-7");
    const first = write(store, "sofia-1", "entities", entity(store, clinic, [site], "sofia-1"), "e1");
    assert.equal(first.outcome, "created");
    // sofia-2 knows the clinic under its own id, but carries the same CRM site ref (whitespace differs).
    const e = refusal(() => write(store, "sofia-2", "entities", entity(store, entityId("customer", "c2-uuid"), [{ ...site, object_key: " 7" }, thread], "sofia-2"), "e2"), "conflict");
    assert.equal(e.conflict?.incumbent_id, clinic);
    assert.equal(e.conflict?.reason, "one-entity-per-external-ref");
    assert.match(e.message, /crm\/site\/7 is already carried by entity customer:clinic-7/);
    // Under the incumbent's id, sofia-2's richer view (an extra ref) is an update, not a second entity.
    const merged = write(store, "sofia-2", "entities", entity(store, clinic, [site, thread], "sofia-2"), "e3");
    assert.equal(merged.outcome, "updated");
    assert.equal(store.recs("entities").filter((x) => x.lifecycle === "active").length, 1);
    // A retired entity releases its keys.
    write(store, "sofia-1", "entities", entity(store, clinic, [site, thread], "sofia-1", { lifecycle: "retired" }), "e4");
    assert.equal(write(store, "sofia-2", "entities", entity(store, entityId("customer", "c2-uuid"), [site], "sofia-2"), "e5").outcome, "created");
    assert.equal(verifyReplay(store, partitionOf(store)).ok, true);
  } finally { cleanup(); }
});

test("subject resolution: a commitment under the CRM record's key is refused with the entity id named; under the entity id two agents share one commitment, and a read by either name finds it", () => {
  const { store, cleanup } = tempStore();
  try {
    const clinic = entityId("customer", "clinic-7");
    // Before any entity exists, a free-form subject is valid (an unbound customer).
    const free = write(store, "sofia-1", "commitments", commitment(store, "customer:uuid-1", "sofia-1"), "free");
    assert.equal(free.outcome, "created");
    write(store, "sofia-1", "entities", entity(store, clinic, [site], "sofia-1"), "e1");
    // sofia-2 writes about the same clinic under the CRM's own key.
    const e = refusal(() => write(store, "sofia-2", "commitments", commitment(store, "site:7", "sofia-2"), "c-key"), "identity");
    assert.equal(e.conflict?.incumbent_id, clinic);
    assert.match(e.message, /re-derive with subject customer:clinic-7/);
    // Under the entity id: sofia-1 creates, sofia-2 replays the same fact (same derived id).
    assert.equal(write(store, "sofia-1", "commitments", commitment(store, clinic, "sofia-1"), "c1").outcome, "created");
    const again = write(store, "sofia-2", "commitments", commitment(store, clinic, "sofia-2"), "c2");
    assert.equal(again.outcome, "updated", "same subject, same facts, one record — sofia-2's provenance lands on it, no second record");
    assert.equal(write(store, "sofia-2", "commitments", commitment(store, clinic, "sofia-2"), "c2-again").outcome, "replayed");
    assert.equal(store.recs("commitments").filter((c) => c.subject === clinic).length, 1);
    // A read by the CRM key, by the entity id, or by a key of any ref the entity carries, resolves to the same state of record.
    const p = principal(store, "orc");
    const byKey = readState(store, { schema: "nuryel.state.read/1", principal: p, scope: partitionOf(store), subject: "site:7" }).response.state_of_record!;
    const byId = readState(store, { schema: "nuryel.state.read/1", principal: p, scope: partitionOf(store), subject: clinic }).response.state_of_record!;
    assert.deepEqual(byKey.in_force.map((r) => r.id), [again.record_id]);
    assert.deepEqual(byId.in_force.map((r) => r.id), [again.record_id]);
    assert.deepEqual(byKey.current.map((r) => r.id), [clinic], "the entity itself is current under its key");
    // The free-form subject is untouched by the entity: still its own state.
    const other = readState(store, { schema: "nuryel.state.read/1", principal: p, scope: partitionOf(store), subject: "customer:uuid-1" }).response.state_of_record!;
    assert.deepEqual(other.in_force.map((r) => r.id), [free.record_id]);
    // A derived summary is held to the same rule.
    const dep = [{ kind: "external", ref: site }];
    const summary = (subject: string) => ({ schema: "nuryel.derived/1", scope: partitionOf(store), subject, content: "clinic seven summary", content_hash: stateHash("clinic seven summary"), dependencies: dep, transform_version: "summary/1", computed_at: "2026-09-09T09:00:00Z", valid_to: null, state: "current", provenance: prov("sofia-2") });
    refusal(() => write(store, "sofia-2", "derived", summary("site:7"), "d-key"), "identity");
    assert.equal(write(store, "sofia-2", "derived", summary(clinic), "d1").outcome, "created");
    assert.equal(verifyReplay(store, partitionOf(store)).ok, true);
  } finally { cleanup(); }
});
