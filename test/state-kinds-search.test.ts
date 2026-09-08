/**
 * nuryel.state/1 kinds are searchable and delivered like decisions: reindex adds every state
 * record to the `search` FTS table, hunch_query / `hunch query` render them one line per kind,
 * history (superseded / done) ranks below the state of record, and hunch_context carries a
 * bounded, deterministically ordered "State" section. A store with zero state records is
 * unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { tempStore } from "./helpers.js";
import { hunchPaths } from "../src/core/paths.js";
import { buildServer } from "../src/mcp/server.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { buildDeliveryEnvelope } from "../src/core/delivery.js";
import { formatSearchHit } from "../src/core/format.js";
import { renderStateLine, stateSupplements } from "../src/core/stateDelivery.js";
import { actionReceiptId, commitmentId, derivedId, stateHash } from "../src/core/stateContract.js";
import type { ActionReceipt, Commitment, DerivedState } from "../src/core/stateRecords.js";

const prov = { source: "imported:sofia", confidence: 0.9, evidence: ["sofia approvals row a1"] };
const scope = { kind: "user" as const, id: "david" };
const subject = "customer:Site:7";
const crmV2 = { system: "crm", object_type: "event", object_key: "10042", version: "2", observed_at: "2026-09-05T12:00:00Z" };
const crmV3 = { ...crmV2, version: "3", observed_at: "2026-09-08T08:00:00Z" };

const CURRENT_SUMMARY = "Elevator at clinic Site 7 was repaired on 2026-09-06; the follow-up report is still owed to the clinic manager, who asked for it before the weekly review.";
const OLD_SUMMARY = "Elevator at clinic Site 7 is broken; a technician visit is scheduled.";

function derived(content: string, dep: typeof crmV2, computedAt: string, closed?: string): DerivedState {
  const base = { scope, subject, transform_version: "sofia-summary/3", dependencies: [{ kind: "external" as const, ref: dep }] };
  return {
    schema: "nuryel.derived/1", id: derivedId(base), ...base, content, content_hash: stateHash(content),
    computed_at: computedAt, valid_to: closed ?? null, state: closed ? "stale" : "current", provenance: prov,
  };
}

function commitment(title: string, due: string, status: Commitment["status"], validFrom: string): Commitment {
  const base = { scope, subject, title, owner: "sofia", due };
  return { schema: "nuryel.commitment/1", id: commitmentId(base), ...base, status, valid_from: validFrom, valid_to: null, provenance: prov };
}

function receipt(): ActionReceipt {
  const base = { scope, actor: "sofia@david", action_kind: "events_add_actions", target: crmV3, request_fingerprint: stateHash({ eventId: 10042 }) };
  return {
    schema: "nuryel.receipt/1", id: actionReceiptId(base), ...base, state: "verified",
    occurred_at: "2026-09-08T10:00:00Z", verified_at: "2026-09-08T10:00:05Z", invalidates: [subject], provenance: prov,
  };
}

/** The fixture every test below shares: one current + one superseded summary, one in-force + one
 *  done commitment, one verified receipt — all on customer:Site:7 / event:10042. */
function seedState(store: HunchStore) {
  const current = store.json.put("derived", derived(CURRENT_SUMMARY, crmV3, "2026-09-08T09:00:00Z"));
  const superseded = store.json.put("derived", derived(OLD_SUMMARY, crmV2, "2026-09-05T13:00:00Z", "2026-09-08T09:00:00Z"));
  const inForce = store.json.put("commitments", commitment("send report", "2026-09-11", "open", "2026-09-08T09:05:00Z"));
  const done = store.json.put("commitments", commitment("schedule technician", "2026-09-06", "done", "2026-09-05T13:05:00Z"));
  const verified = store.json.put("receipts", receipt());
  assert.notEqual(current.id, superseded.id, "different dependencies → different derived identities");
  return { current, superseded, inForce, done, verified };
}

test("reindex adds every state record to the search table under its kind, and a subject id query hits them", () => {
  const { store, cleanup } = tempStore();
  try {
    const ids = seedState(store);
    const counts = store.reindex().counts;
    assert.equal(counts.derived, 2);
    assert.equal(counts.commitments, 2);
    assert.equal(counts.receipts, 1);
    assert.equal(counts.entities, 0);
    assert.equal(counts.relationships, 0);

    const hits = store.search(subject, 12);
    const kinds = new Map(hits.map((h) => [h.ref, h.kind]));
    assert.equal(kinds.get(ids.current.id), "derived");
    assert.equal(kinds.get(ids.superseded.id), "derived");
    assert.equal(kinds.get(ids.inForce.id), "commitments");
    assert.equal(kinds.get(ids.done.id), "commitments");
    assert.equal(kinds.get(ids.verified.id), "receipts", "the receipt invalidates the subject, so the subject query reaches it");

    // Human words hit too — and a phrase from the summary lands on the derived record first.
    const words = store.search("clinic elevator", 12);
    assert.equal(words[0]?.ref, ids.current.id, `phrase query leads with the current summary, got ${JSON.stringify(words.map((h) => h.ref))}`);

    // Actor / action kind / receipt target are all searchable.
    assert.ok(store.search("events_add_actions").some((h) => h.ref === ids.verified.id));
    assert.ok(store.search("sofia@david").some((h) => h.ref === ids.verified.id));
    assert.equal(store.search("event:10042")[0]?.ref, ids.verified.id);
  } finally { cleanup(); }
});

test("history is indexed but ranked below the state of record on every search path", async () => {
  const { store, cleanup } = tempStore();
  try {
    const ids = seedState(store);
    store.reindex();
    const order = (hits: Array<{ ref: string }>) => hits.map((h) => h.ref);
    const above = (hits: Array<{ ref: string }>, a: string, b: string, label: string) => {
      const refs = order(hits);
      assert.ok(refs.includes(a) && refs.includes(b), `${label}: both ${a} and ${b} present in ${JSON.stringify(refs)}`);
      assert.ok(refs.indexOf(a) < refs.indexOf(b), `${label}: expected ${a} above ${b} in ${JSON.stringify(refs)}`);
    };
    for (const [label, hits] of [
      ["raw FTS", store.search(subject, 12)],
      ["rankedSearch", store.rankedSearch(subject, 12)],
      ["hybridSearch (FTS-only)", await store.hybridSearch(subject, 12, { embedder: null })],
      ["hybridSearch (auto)", await store.hybridSearch(subject, 12)],
    ] as const) {
      above(hits, ids.current.id, ids.superseded.id, `${label}: current derived above superseded`);
      above(hits, ids.inForce.id, ids.done.id, `${label}: in-force commitment above done`);
    }
    // Same query, same store, same order — deterministic.
    assert.deepEqual(order(store.rankedSearch(subject, 12)), order(store.rankedSearch(subject, 12)));
    // The phrase both summaries share still leads with the current one.
    above(store.rankedSearch("elevator clinic site", 12), ids.current.id, ids.superseded.id, "shared phrase");
  } finally { cleanup(); }
});

test("one-line render per kind, shared by hunch_query and `hunch query`", () => {
  const { store, cleanup } = tempStore();
  try {
    const ids = seedState(store);
    store.reindex();
    assert.equal(renderStateLine("commitments", ids.inForce), `[commitment/in_force] customer:Site:7 — "send report" due 2026-09-11 (owner sofia)`);
    assert.equal(renderStateLine("commitments", ids.done), `[commitment/done] customer:Site:7 — "schedule technician" due 2026-09-06 (owner sofia)`);
    assert.equal(renderStateLine("derived", ids.current), `[derived/current] customer:Site:7 — ${CURRENT_SUMMARY.slice(0, 119).trimEnd()}…`);
    assert.equal(renderStateLine("derived", ids.superseded), `[derived/superseded] customer:Site:7 — ${OLD_SUMMARY}`);
    assert.equal(renderStateLine("receipts", ids.verified), `[receipt/verified] event:10042 — events_add_actions by sofia@david 2026-09-08`);

    const hit = store.search("send report", 5).find((h) => h.ref === ids.inForce.id);
    assert.ok(hit, "commitment title is searchable");
    assert.equal(formatSearchHit(hit, store.resolve(hit.ref)?.record), `• [commitment/in_force] customer:Site:7 — "send report" due 2026-09-11 (owner sofia)\n    ${ids.inForce.id}`);
    // Graph records keep their existing shape.
    const graphHit = { ref: "dec_x", kind: "decisions", title: "T", snippet: "s", score: -1 };
    assert.equal(formatSearchHit(graphHit, { id: "dec_x" }), "• [decisions] dec_x — T\n    s");
  } finally { cleanup(); }
});

test("stateSlice: live records only, AND-matched on the target, bounded and deterministically ordered", () => {
  const { store, cleanup } = tempStore();
  try {
    const ids = seedState(store);
    // Four current newsletters on other subjects with identical text: cap 3, latest first.
    for (const n of [1, 2, 3, 4]) {
      const base = { scope, subject: `customer:Site:${n + 10}`, transform_version: "sofia-summary/3", dependencies: [{ kind: "external" as const, ref: { ...crmV3, object_key: `${n}` } }] };
      store.json.put("derived", {
        schema: "nuryel.derived/1", id: derivedId(base), ...base, content: "Clinic newsletter sent.", content_hash: stateHash("Clinic newsletter sent."),
        computed_at: `2026-09-0${n}T09:00:00Z`, valid_to: null, state: "current", provenance: prov,
      });
    }
    store.reindex();

    const bySubject = store.stateSlice(subject);
    assert.deepEqual(bySubject.derived.map((h) => h.record.id), [ids.current.id], "only the current summary");
    assert.deepEqual(bySubject.commitments.map((h) => h.record.id), [ids.inForce.id], "only the in-force commitment");
    assert.deepEqual(bySubject.receipts.map((h) => h.record.id), [ids.verified.id], "the receipt names the subject in invalidates");

    const byPhrase = store.stateSlice("clinic elevator");
    assert.deepEqual(byPhrase.derived.map((h) => h.record.id), [ids.current.id], "phrase matches the current summary, not the superseded one");
    assert.deepEqual(byPhrase.commitments, []);

    const byReceipt = store.stateSlice("event:10042");
    assert.deepEqual(byReceipt.receipts.map((h) => h.record.id), [ids.verified.id]);

    // AND semantics: a file path never drags in a summary that merely shares a word.
    assert.deepEqual(store.stateSlice("src/store/hunchStore.ts"), { derived: [], commitments: [], receipts: [] });
    assert.deepEqual(store.stateSlice("report store"), { derived: [], commitments: [], receipts: [] });

    const capped = store.stateSlice("clinic newsletter");
    assert.equal(capped.derived.length, 3, "derived capped at 3");
    assert.deepEqual(capped.derived.map((h) => (h.record as DerivedState).computed_at.slice(0, 10)), ["2026-09-04", "2026-09-03", "2026-09-02"], "latest first among equal scores");
    assert.deepEqual(store.stateSlice("clinic newsletter"), capped, "deterministic");
  } finally { cleanup(); }
});

test("hunch_context carries a bounded State section for a matching target, and nothing for a store without state", () => {
  const { store, cleanup } = tempStore();
  try {
    const ids = seedState(store);
    store.reindex();
    const ctx = store.assembleContext(subject, 1500);
    const envelope = buildDeliveryEnvelope(ctx, { supplements: stateSupplements(store.stateSlice(subject), subject) });
    assert.match(envelope.text, /supplemental\/state \| STATE \(nuryel\.state\/1\) for "customer:Site:7": 1 current derived, 1 in-force commitment\(s\), 1 latest receipt\(s\)/);
    assert.match(envelope.text, /supplemental\/state-derived \| \[derived\/current\] customer:Site:7 — Elevator at clinic Site 7 was repaired/);
    assert.match(envelope.text, /supplemental\/state-commitment \| \[commitment\/in_force\] customer:Site:7 — "send report" due 2026-09-11 \(owner sofia\)/);
    assert.match(envelope.text, /supplemental\/state-receipt \| \[receipt\/verified\] event:10042 — events_add_actions by sofia@david 2026-09-08/);
    assert.doesNotMatch(envelope.text, /superseded|schedule technician/, "history is not in the State section");
    // Section order: header, derived, commitments, receipts.
    const at = (s: string) => envelope.text.indexOf(s);
    assert.ok(at("supplemental/state |") < at("state-derived") && at("state-derived") < at("state-commitment") && at("state-commitment") < at("state-receipt"));
    const delivered = envelope.supplements.filter((s) => s.kind.startsWith("state")).map((s) => [s.id, s.kind, s.delivered]);
    assert.deepEqual(delivered, [
      ["state-of-record", "state", true], [ids.current.id, "state-derived", true], [ids.inForce.id, "state-commitment", true], [ids.verified.id, "state-receipt", true],
    ]);
    // Same target, same envelope receipt — the section is deterministic.
    assert.equal(buildDeliveryEnvelope(ctx, { supplements: stateSupplements(store.stateSlice(subject), subject) }).receipt_id, envelope.receipt_id);
  } finally { cleanup(); }

  const bare = tempStore();
  try {
    bare.store.json.put("decisions", { id: "dec_legacy0001", title: "Clinic elevator reporting", status: "accepted", context: "", decision: "send the report weekly", consequences: [], alternatives_rejected: [], rejected_tripwires: [], related_components: [], related_files: [], supersedes: null, superseded_by: null, caused_by_bug: null, commit: null, valid_to: null, retired: { symbols: [], deps: [] }, provenance: prov, date: "2026-09-01T00:00:00.000Z", topic: null });
    const counts = bare.store.reindex().counts;
    assert.equal(counts.decisions, 1);
    for (const kind of ["receipts", "commitments", "derived", "entities", "relationships"]) assert.equal(counts[kind], 0);
    assert.deepEqual(bare.store.stateSlice("clinic elevator"), { derived: [], commitments: [], receipts: [] });
    assert.deepEqual(stateSupplements(bare.store.stateSlice("clinic elevator"), "clinic elevator"), [], "no supplements at all → the brief is unchanged");
    const hits = bare.store.rankedSearch("clinic elevator", 8);
    assert.deepEqual(hits.map((h) => [h.kind, h.ref]), [["decisions", "dec_legacy0001"]]);
    const text = buildDeliveryEnvelope(bare.store.assembleContext("clinic elevator"), { supplements: stateSupplements(bare.store.stateSlice("clinic elevator"), "clinic elevator") }).text;
    assert.doesNotMatch(text, /supplemental\/state/);
  } finally { bare.cleanup(); }
});

test("over MCP: hunch_query renders state hits per kind (current above superseded) and hunch_context delivers the State section", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-state-search-"));
  const seed = new HunchStore(hunchPaths(root));
  seed.json.ensureDirs();
  const ids = seedState(seed);
  seed.reindex();
  seed.close();
  const server = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "state-search-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  const query = await client.callTool({ name: "hunch_query", arguments: { query: subject } });
  const queryText = (query.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");
  assert.match(queryText, /• \[commitment\/in_force\] customer:Site:7 — "send report" due 2026-09-11 \(owner sofia\)\n {4}ncm_[a-f0-9]{24}/);
  assert.match(queryText, /• \[derived\/current\] customer:Site:7 — Elevator at clinic Site 7 was repaired/);
  assert.match(queryText, /• \[receipt\/verified\] event:10042 — events_add_actions by sofia@david 2026-09-08/);
  assert.ok(queryText.indexOf(ids.current.id) < queryText.indexOf(ids.superseded.id), "current summary above the superseded one");
  assert.ok(queryText.indexOf(ids.inForce.id) < queryText.indexOf(ids.done.id), "in-force commitment above the done one");

  const context = await client.callTool({ name: "hunch_context", arguments: { target: "clinic elevator" } });
  const contextText = (context.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");
  assert.match(contextText, /STATE \(nuryel\.state\/1\) for "clinic elevator": 1 current derived, 0 in-force commitment\(s\), 0 latest receipt\(s\)/);
  assert.match(contextText, /\[derived\/current\] customer:Site:7 — Elevator at clinic Site 7 was repaired/);
  assert.doesNotMatch(contextText, /search-derived/, "state hits are delivered through the State section, not as raw search lines");
  const structured = context.structuredContent as { supplements: Array<{ id: string; kind: string; delivered: boolean }> };
  assert.ok(structured.supplements.some((s) => s.id === ids.current.id && s.kind === "state-derived" && s.delivered));
});
