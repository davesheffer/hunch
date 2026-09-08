import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ActionReceiptSchema, CommitmentSchema, DerivedStateSchema, ExternalEntitySchema, StateRelationshipSchema,
  ReadRequestSchema, ReadResponseSchema, WriteRequestSchema, WriteResultSchema, SubscribeRequestSchema, ChangeEventSchema,
  PrincipalSchema, ExternalRefSchema, STATE_CAPABILITIES, STATE_INVARIANTS,
  canonicalize, stateHash, actionReceiptId, commitmentId, derivedId, entityId, relationshipId, negotiate,
  assertReadWithinGrants, assertWriteWellFormed, assertDerivedState, assertChangeSequence,
} from "../src/core/stateContract.js";

const org = { kind: "organization" as const, id: "acme" };
const user = { kind: "user" as const, id: "david" };
const repo = { kind: "repository" as const, id: "hunch" };
const prov = { source: "imported:sofia", confidence: 0.9, evidence: ["sofia approvals row a1"] };
const david = PrincipalSchema.parse({ id: "david", kind: "human", grants: [org, user] });
const sofiaAgent = PrincipalSchema.parse({ id: "sofia@david", kind: "agent", grants: [org, user] });

// ---- Sofia-shaped fixtures: every record Sofia keeps today, expressed as a state facet ----

const crmEvent = ExternalRefSchema.parse({ system: "crm", object_type: "event", object_key: "10042", version: "2", observed_at: "2026-09-07T12:00:00Z" });
const gmailThread = ExternalRefSchema.parse({ system: "gmail", object_type: "thread", object_key: "thread1", observed_at: "2026-09-07T12:00:00Z" });

test("a Sofia approval becomes an action receipt whose id is the action, not the row", () => {
  const base = { scope: user, actor: "sofia@david", action_kind: "add_comment", target: crmEvent, request_fingerprint: stateHash({ eventId: 10042, comment: "הלוגו לא הוסר והכול תקין." }) };
  const id = actionReceiptId(base);
  const receipt = ActionReceiptSchema.parse({ schema: "nuryel.receipt/1", id, ...base, state: "verified", occurred_at: "2026-09-07T08:55:22Z", verified_at: "2026-09-07T08:55:40Z", provenance: prov });
  assert.equal(receipt.state, "verified");
  assert.equal(actionReceiptId({ ...base, target: { ...crmEvent, observed_at: "2026-09-08T00:00:00Z" } }), id, "observation time does not change the action's identity");
  assert.notEqual(actionReceiptId({ ...base, request_fingerprint: stateHash({ eventId: 10042, comment: "אחר" }) }), id, "a different request is a different action");
});

test("a Sofia follow-up becomes a commitment with an in-force window", () => {
  const base = { scope: user, subject: entityId("customer", "דוגמה"), title: "לחזור ללקוח עם תוצאות בדיקת הדוח", owner: "david", due: "2026-09-10" };
  const c = CommitmentSchema.parse({ schema: "nuryel.commitment/1", id: commitmentId(base), ...base, status: "open", source: crmEvent, evidence_excerpt: "הלקוח ביקש לעדכן אותו לאחר בדיקת הדוח.", valid_from: "2026-09-07T08:00:00Z", provenance: prov });
  assert.equal(c.valid_to, null, "open commitment is in force");
  assert.equal(commitmentId({ ...base, title: "  לחזור ללקוח עם תוצאות בדיקת הדוח " }), c.id, "title whitespace does not fork identity");
});

test("a cited customer summary becomes derived state that names what it rests on", () => {
  const content = "הלקוח ביקש עדכון; יש לעיין במקורות לפני קביעת המשך הטיפול.";
  const deps = [{ kind: "external" as const, ref: crmEvent }, { kind: "external" as const, ref: gmailThread }];
  const base = { scope: user, subject: entityId("customer", "דוגמה"), transform_version: "sofia-summary/3", dependencies: deps };
  const d = DerivedStateSchema.parse({ schema: "nuryel.derived/1", id: derivedId(base), ...base, content, content_hash: stateHash(content), computed_at: "2026-09-07T12:05:00Z", state: "current", provenance: prov });
  assertDerivedState(d);
  assert.equal(derivedId({ ...base, dependencies: [deps[1]!, deps[0]!] }), d.id, "dependency order does not fork identity");
  assert.throws(() => assertDerivedState({ ...d, dependencies: [] }), /without dependencies/);
  assert.throws(() => assertDerivedState({ ...d, content: content + "!" }), /content hash/);
  assert.throws(() => DerivedStateSchema.parse({ ...d, dependencies: [] }), "schema also refuses an empty dependency list");
});

test("a Sofia dossier becomes an entity with provenance pointers, linked by relationships", () => {
  const id = entityId("customer", "דוגמה");
  const e = ExternalEntitySchema.parse({ schema: "nuryel.entity/1", id, kind: "customer", name: "דוגמה", scope: org, refs: [crmEvent, gmailThread], attributes: { tier: "key", open_events: 18 }, provenance: prov, created_at: "2026-09-07T12:00:00Z", updated_at: "2026-09-07T12:00:00Z" });
  assert.equal(e.lifecycle, "active");
  const rel = StateRelationshipSchema.parse({ schema: "nuryel.relationship/1", id: relationshipId(id, "event:10042", "has_incident"), from: id, to: "event:10042", type: "has_incident", scope: org, provenance: prov });
  assert.ok(rel.id.startsWith("edge_"));
  assert.throws(() => StateRelationshipSchema.parse({ ...rel, id: "edge_deadbeef" }), /derive from its endpoints/);
  assert.throws(() => ExternalEntitySchema.parse({ ...e, id: "other" }), /canonical kind-qualified/);
  assert.throws(() => ExternalEntitySchema.parse({ ...e, id: "Customer:דוגמה" }), /canonical kind-qualified/);
});

test("credential material is refused in provenance pointers", () => {
  assert.throws(() => ExternalRefSchema.parse({ ...crmEvent, locator: "https://user:hunter2@crm.example/api" }), /credential/);
  assert.throws(() => ExternalRefSchema.parse({ ...crmEvent, object_key: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }), /credential/);
});

// ---- canonical form ----

test("canonical hashing is key-order independent and rejects non-finite numbers", () => {
  assert.equal(stateHash({ b: 1, a: { d: [1, 2], c: "x" } }), stateHash({ a: { c: "x", d: [1, 2] }, b: 1 }));
  assert.notEqual(stateHash({ a: [1, 2] }), stateHash({ a: [2, 1] }), "array order is meaning");
  assert.deepEqual(canonicalize({ z: undefined, a: null }), { a: null }, "undefined is dropped, null is kept");
  assert.throws(() => stateHash({ n: Number.NaN }), /non-finite/);
  assert.throws(() => stateHash({ n: Number.POSITIVE_INFINITY }), /non-finite/);
});

// ---- verbs ----

test("read: the response is bound to a delivery receipt and never leaks outside the grants", () => {
  ReadRequestSchema.parse({ schema: "nuryel.state.read/1", principal: sofiaAgent, scope: user, subject: "event:10042", profile: "builder", facets: ["decisions", "receipts", "commitments"] });
  const ok = ReadResponseSchema.parse({ schema: "nuryel.state.read/1", receipt_id: "hdr_" + "a".repeat(24), scope: user, state_of_record: { subject: "event:10042", current: [{ facet: "derived", id: "nds_" + "b".repeat(24), record_hash: stateHash("x"), scope: user }], in_force: [], done: [], depends_on: [], invalidated_by: [] } });
  assertReadWithinGrants(sofiaAgent, ok);
  const leaked = { ...ok, state_of_record: { ...ok.state_of_record!, done: [{ facet: "receipts" as const, id: "nrc_" + "c".repeat(24), record_hash: stateHash("y"), scope: repo }] } };
  assert.throws(() => assertReadWithinGrants(sofiaAgent, leaked), /leaked outside/);
  assert.throws(() => assertReadWithinGrants(sofiaAgent, { ...ok, scope: repo }), /outside the principal's grants/);
  assert.throws(() => assertReadWithinGrants(sofiaAgent, { ...ok, denied_scopes: [user] }), /inconsistent/);
});

test("write: provenance and an idempotency key are mandatory; scope must be granted and agree", () => {
  const record = { schema: "nuryel.commitment/1", scope: user, title: "x", provenance: prov };
  const good = WriteRequestSchema.parse({ schema: "nuryel.state.write/1", principal: david, scope: user, facet: "commitments", record, idempotency_key: "sofia-followup-42" });
  assertWriteWellFormed(good);
  assert.throws(() => WriteRequestSchema.parse({ ...good, idempotency_key: "short" }), "an idempotency key shorter than 8 chars is refused");
  assert.throws(() => assertWriteWellFormed({ ...good, record: { ...record, provenance: undefined } }), /lacks provenance/);
  assert.throws(() => assertWriteWellFormed({ ...good, record: { ...record, scope: org } }), /disagrees/);
  assert.throws(() => assertWriteWellFormed({ ...good, scope: repo }), /outside the principal's grants/);
  const result = WriteResultSchema.parse({ schema: "nuryel.state.write/1", record_id: "ncm_" + "d".repeat(24), record_hash: stateHash(record), durability: "pushed", outcome: "created" });
  assert.equal(result.conflict, null);
  WriteResultSchema.parse({ ...result, outcome: "superseded", conflict: { incumbent_id: "dec_1", reason: "one live decision per topic" } });
});

test("subscribe: change events are a strictly ordered stream; a gap forces resynchronization", () => {
  SubscribeRequestSchema.parse({ schema: "nuryel.state.subscribe/1", principal: sofiaAgent, scope: user, after_seq: 41, facets: ["commitments", "receipts"] });
  const ev = (seq: number) => ChangeEventSchema.parse({ schema: "nuryel.state.subscribe/1", seq, at: "2026-09-07T12:00:00Z", scope: user, facet: "receipts", record_id: "nrc_" + "e".repeat(24), record_hash: stateHash(seq), change: "created", cause: { kind: "write", principal: "sofia@david" } });
  assertChangeSequence([ev(42), ev(43), ev(44)], 41);
  assert.throws(() => assertChangeSequence([ev(42), ev(44)], 41), /gap/);
  assert.throws(() => assertChangeSequence([ev(41)], 41), /gap/);
});

test("capability negotiation names what is unsupported instead of degrading silently", () => {
  const { supported, unsupported } = negotiate([...STATE_CAPABILITIES.filter((c) => c !== "nuryel.state.subscribe/1"), "vendor.extra/9"]);
  assert.ok(supported.includes("nuryel.state.read/1"));
  assert.deepEqual(unsupported, ["nuryel.state.subscribe/1"]);
});

test("the invariants are enumerated, stable and each backed by an assertion or a schema rule", () => {
  const ids = STATE_INVARIANTS.map((i) => i.id);
  assert.deepEqual(ids, ["authorization-before-retrieval", "similarity-never-authorizes", "never-in-request-path", "provenance-on-every-write", "one-live-decision-per-topic", "external-truth-stays-external", "derived-state-carries-dependencies"]);
  // similarity-never-authorizes: no verb schema admits a similarity score as an input to validity.
  for (const schema of [ReadResponseSchema, WriteResultSchema, ChangeEventSchema]) {
    assert.equal(Object.keys((schema as { shape: Record<string, unknown> }).shape).some((k) => /similar|score|embedding/i.test(k)), false);
  }
});
