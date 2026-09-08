import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempStore } from "./helpers.js";
import { ENTITY_KINDS } from "../src/core/types.js";
import { actionReceiptId, commitmentId, derivedId, entityId, relationshipId, stateHash } from "../src/core/stateContract.js";

const user = { kind: "user" as const, id: "david" };
const org = { kind: "organization" as const, id: "acme" };
const prov = { source: "imported:sofia", confidence: 0.9, evidence: ["sofia approvals row a1"] };
const crmEvent = { system: "crm", object_type: "event", object_key: "10042", version: "2", observed_at: "2026-09-07T12:00:00Z" };

test("the five nuryel.state/1 facets are registered store kinds, additively after the legacy kinds", () => {
  assert.deepEqual(ENTITY_KINDS.slice(-5), ["receipts", "commitments", "derived", "entities", "relationships"]);
  assert.deepEqual(ENTITY_KINDS.slice(0, 9), ["components", "resources", "edges", "symbols", "decisions", "bugs", "constraints", "runbooks", "findings"], "legacy order unchanged");
});

test("receipts, commitments and derived state round-trip through the JSON store as one file per record", () => {
  const { store, root, cleanup } = tempStore();
  try {
    store.json.ensureDirs();
    const rBase = { scope: user, actor: "sofia@david", action_kind: "add_comment", target: crmEvent, request_fingerprint: stateHash({ c: 1 }) };
    const receipt = store.json.put("receipts", { schema: "nuryel.receipt/1", id: actionReceiptId(rBase), ...rBase, state: "verified", occurred_at: "2026-09-07T08:55:22Z", provenance: prov, invalidates: [] });
    const cBase = { scope: user, subject: entityId("customer", "דוגמה"), title: "לחזור ללקוח", owner: "david", due: "2026-09-10" };
    const commitment = store.json.put("commitments", { schema: "nuryel.commitment/1", id: commitmentId(cBase), ...cBase, status: "open", valid_from: "2026-09-07T08:00:00Z", valid_to: null, provenance: prov });
    const dBase = { scope: user, subject: cBase.subject, transform_version: "sofia-summary/3", dependencies: [{ kind: "external" as const, ref: crmEvent }] };
    const derived = store.json.put("derived", { schema: "nuryel.derived/1", id: derivedId(dBase), ...dBase, content: "סיכום", content_hash: stateHash("סיכום"), computed_at: "2026-09-07T12:05:00Z", valid_to: null, state: "current", provenance: prov });
    assert.ok(existsSync(join(root, ".hunch", "receipts", `${receipt.id}.json`)), "receipt is its own reviewable file");
    assert.ok(existsSync(join(root, ".hunch", "commitments", `${commitment.id}.json`)));
    assert.ok(existsSync(join(root, ".hunch", "derived", `${derived.id}.json`)));
    assert.equal(store.json.get("receipts", receipt.id)?.state, "verified");
    assert.equal(store.json.loadAll("commitments").length, 1);
    assert.equal(store.json.loadAll("derived")[0]?.dependencies.length, 1);
    // putCapture routes through the same home logic as every other kind
    const again = store.putCapture("receipts", { ...receipt, state: "verified" as const });
    assert.equal(again.id, receipt.id);
    assert.equal(store.json.loadAll("receipts").length, 1, "re-put is an update, not a duplicate");
  } finally { cleanup(); }
});

test("entities and relationships live in an index file, so kind-qualified and non-ASCII ids are safe", () => {
  const { store, root, cleanup } = tempStore();
  try {
    store.json.ensureDirs();
    const id = entityId("customer", "דוגמה");
    store.json.put("entities", { schema: "nuryel.entity/1", id, kind: "customer", name: "דוגמה", scope: org, refs: [crmEvent], attributes: { tier: "key" }, lifecycle: "active", provenance: prov, created_at: "2026-09-07T12:00:00Z", updated_at: "2026-09-07T12:00:00Z" });
    store.json.put("relationships", { schema: "nuryel.relationship/1", id: relationshipId(id, "event:10042", "has_incident"), from: id, to: "event:10042", type: "has_incident", scope: org, reason: "", provenance: prov });
    assert.deepEqual(readdirSync(join(root, ".hunch", "entities")), ["index.json"]);
    assert.deepEqual(readdirSync(join(root, ".hunch", "relationships")), ["index.json"]);
    assert.equal(store.json.get("entities", id)?.name, "דוגמה");
    assert.equal(store.json.loadAll("relationships")[0]?.type, "has_incident");
    assert.throws(() => store.json.put("receipts", { schema: "nuryel.receipt/1", id: "nrc_../etc", scope: user, actor: "x", action_kind: "y", target: crmEvent, request_fingerprint: stateHash(1), state: "unknown", occurred_at: "2026-09-07T12:00:00Z", provenance: prov, invalidates: [] } as never), "per-file kinds still refuse unsafe ids");
  } finally { cleanup(); }
});

test("a store written before these kinds existed loads unchanged, and reindex counts the new kinds", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.ensureDirs();
    // Legacy store: only the legacy directories carry data.
    store.json.put("decisions", { id: "dec_legacy0001", title: "legacy", status: "accepted", context: "", decision: "x", consequences: [], alternatives_rejected: [], rejected_tripwires: [], related_components: [], related_files: [], supersedes: null, superseded_by: null, caused_by_bug: null, commit: null, valid_to: null, retired: { symbols: [], deps: [] }, provenance: prov, date: "2026-09-01T00:00:00.000Z", topic: null });
    for (const kind of ["receipts", "commitments", "derived", "entities", "relationships"] as const) {
      assert.deepEqual(store.json.loadAll(kind), [], `${kind} is empty, not an error`);
    }
    const counts = store.reindex().counts;
    assert.equal(counts.decisions, 1);
    assert.equal(store.json.loadAll("decisions").length, 1, "legacy records untouched");
  } finally { cleanup(); }
});

test("an older reader ignores a directory it does not know (the compatibility claim, run forward)", () => {
  const { store, root, cleanup } = tempStore();
  try {
    store.json.ensureDirs();
    // Simulate a NEWER build having written a kind this build does not know.
    const future = join(root, ".hunch", "futurekind");
    mkdirSync(future, { recursive: true });
    writeFileSync(join(future, "fut_1.json"), JSON.stringify({ id: "fut_1", anything: true }));
    store.json.put("decisions", { id: "dec_ok", title: "ok", status: "accepted", context: "", decision: "x", consequences: [], alternatives_rejected: [], rejected_tripwires: [], related_components: [], related_files: [], supersedes: null, superseded_by: null, caused_by_bug: null, commit: null, valid_to: null, retired: { symbols: [], deps: [] }, provenance: prov, date: "2026-09-01T00:00:00.000Z", topic: null });
    assert.equal(store.json.loadAll("decisions").length, 1);
    assert.doesNotThrow(() => store.reindex());
    assert.ok(readFileSync(join(future, "fut_1.json"), "utf8").includes("anything"), "the unknown directory is left exactly as written");
    assert.throws(() => store.json.loadAll("futurekind" as never), /unknown|kind/i, "and never read as a kind");
  } finally { cleanup(); }
});
