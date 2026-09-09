/**
 * Gate 4 (ROADMAP): the cross-domain chain, run through the ONE binding by three different
 * principals over one store — a repository partition plus an organization drawer in the overlay.
 *
 *   Sofia records the customer incident + commitment            (organization drawer)
 *     → the engineering agent reads the incident state           (union read, grants first)
 *     → engineering decision + change proof + shipped receipt    (repository partition; receipt
 *                                                                  in the drawer RESTS ON both)
 *     → Sofia sees verified completion                            (done, invalidated_by)
 *     → closure: the commitment is closed BY the receipt          (closed_by, cause = receipt)
 *     → a new agent reads the whole chain later                   (depends_on, records)
 *
 * Nothing here is prose: every link is a hash-checked ref, every refusal teaches the way out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { StateRefusal, readState, recordsState, repositoryScope, subscribeState, writeState } from "../src/store/stateBinding.js";
import { actionReceiptId, assertChangeSequence, commitmentId, entityId, stateHash, type DependencyRef } from "../src/core/stateContract.js";

const org = { kind: "organization" as const, id: "acme-dental" };
const CUSTOMER = "customer:Site:7";
const crmEvent = { system: "crm", object_type: "event", object_key: "10042", version: "3", observed_at: "2026-09-08T09:00:00Z" };
const sofiaProv = { source: "imported:sofia", confidence: 0.9, evidence: ["CRM event 10042: report export fails for Site:7"] };
const engProv = { source: "agent_recorded", confidence: 0.9, evidence: ["PR #146 merged; change proof sealed"] };
const proof = JSON.parse(readFileSync(join(process.cwd(), "contracts/change-proof/hunch.change-proof.v1.example.json"), "utf8")) as { proof_id: string; content_hash: string };

function overlayStore() {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-state-chain-"));
  const root = join(sandbox, "repository");
  const overlay = join(sandbox, "private-memory", ".hunch");
  mkdirSync(overlay, { recursive: true });
  execFileSync("git", ["init", "-q", join(sandbox, "private-memory")]);
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ privateDir: overlay, autoCommit: false }) + "\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  return { store, cleanup: () => { store.close(); rmSync(sandbox, { recursive: true, force: true }); } };
}

function refusal(fn: () => unknown, code: StateRefusal["code"]): StateRefusal {
  try { fn(); } catch (e) {
    assert.ok(e instanceof StateRefusal, `expected a StateRefusal, got ${(e as Error).message}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected a ${code} refusal`);
}

test("the chain: incident → decision → change proof → shipped receipt → closure, read by three principals", () => {
  const { store, cleanup } = overlayStore();
  try {
    const repo = repositoryScope(store);
    const sofia = { id: "sofia@david", kind: "agent" as const, grants: [org] };
    const engineer = { id: "claude-code@david", kind: "agent" as const, grants: [org, repo] };
    const auditor = { id: "auditor@acme", kind: "agent" as const, grants: [org, repo] };
    const w = (principal: typeof sofia, scope: typeof org | typeof repo, facet: string, record: Record<string, unknown>, key: string, over: Record<string, unknown> = {}) =>
      writeState(store, { schema: "nuryel.state.write/1", principal, scope, facet, record, idempotency_key: key, ...over });
    const read = (principal: typeof sofia, scopes: Array<typeof org | typeof repo>, subject: string) =>
      readState(store, { schema: "nuryel.state.read/1", principal, scope: scopes[0]!, scopes, subject }).response;

    // 1. Sofia records the incident: an entity with a CRM pointer, and the commitment it created.
    const incident = w(sofia, org, "entities", {
      schema: "nuryel.entity/1", id: entityId("incident", "crm-event-10042"), kind: "incident", name: "report export fails for Site:7",
      refs: [crmEvent], attributes: { customer: CUSTOMER, severity: "high" }, lifecycle: "active",
      provenance: sofiaProv, created_at: "2026-09-08T09:05:00Z", updated_at: "2026-09-08T09:05:00Z",
    }, "sofia:incident:10042");
    assert.equal(incident.outcome, "created");
    const cBase = { scope: org, subject: CUSTOMER, title: "fix the report export for Site:7", owner: "engineering", due: "2026-09-12" };
    const commitment = w(sofia, org, "commitments", { schema: "nuryel.commitment/1", ...cBase, status: "open", source: crmEvent, valid_from: "2026-09-08T09:05:00Z", valid_to: null, provenance: sofiaProv }, "sofia:commitment:10042");
    assert.equal(commitment.record_id, commitmentId(cBase));

    // 2. The engineering agent reads the incident state — the commitment is in force, on the drawer.
    const before = read(engineer, [org, repo], CUSTOMER);
    assert.deepEqual(before.state_of_record?.in_force.map((r) => r.id), [commitment.record_id]);
    assert.deepEqual(before.state_of_record?.done, []);

    // 3. Engineering decision in the REPOSITORY partition, a change proof, and a shipped receipt in
    //    the drawer that rests on both — and on the commitment it answers.
    const decision = w(engineer, repo, "decisions", {
      id: "dec_exportfix0001", title: "stream the report export instead of buffering it", topic: "reports.export-strategy", status: "accepted", context: "Site:7 exports time out",
      decision: "Stream rows to the response.", consequences: [], alternatives_rejected: ["raise the buffer limit"], rejected_tripwires: [], related_components: [], related_files: ["src/reports/export.ts"],
      supersedes: null, superseded_by: null, caused_by_bug: null, commit: null, valid_to: null, retired: { symbols: [], deps: [] }, provenance: engProv, date: "2026-09-09T10:00:00Z",
    }, "eng:decision:export");
    assert.equal(decision.outcome, "created");
    const restsOn: DependencyRef[] = [
      { kind: "record", id: decision.record_id, record_hash: decision.record_hash, scope: repo },
      { kind: "external", ref: { system: "hunch", object_type: "change_proof", object_key: proof.proof_id, content_hash: proof.content_hash, observed_at: "2026-09-09T11:00:00Z" } },
      { kind: "record", id: commitment.record_id, record_hash: commitment.record_hash },
    ];
    const rBase = { scope: org, actor: engineer.id, action_kind: "shipped", target: { system: "github", object_type: "pull_request", object_key: "acme/reports#146", version: "merged", observed_at: "2026-09-09T11:00:00Z" }, request_fingerprint: stateHash({ pr: 146 }) };
    const receiptRecord = { schema: "nuryel.receipt/1", ...rBase, state: "verified", occurred_at: "2026-09-09T11:00:00Z", verified_at: "2026-09-09T11:05:00Z", invalidates: [CUSTOMER], rests_on: restsOn, provenance: engProv };
    const shipped = w(engineer, org, "receipts", receiptRecord, "eng:shipped:146");
    assert.equal(shipped.outcome, "created");
    assert.equal(shipped.record_id, actionReceiptId(rBase), "rests_on is evidence, never identity");

    // 4. Sofia sees verified completion: the receipt is done and it invalidates her subject.
    const sofiaSees = read(sofia, [org], CUSTOMER);
    assert.deepEqual(sofiaSees.state_of_record?.done.map((r) => `${r.facet}:${r.id}`), [`receipts:${shipped.record_id}`]);
    assert.deepEqual(sofiaSees.state_of_record?.invalidated_by, [shipped.record_id]);
    assert.deepEqual(sofiaSees.state_of_record?.depends_on, restsOn, "what the closure rests on travels with the read");
    assert.deepEqual(sofiaSees.denied_scopes, [], "the repository pointer is a ref, not a leak: no scope was read that she lacks");

    // 5. Closure: the commitment is closed BY the receipt. Same identity, new key → updated in place.
    const closed = w(sofia, org, "commitments", { schema: "nuryel.commitment/1", ...cBase, status: "done", source: crmEvent, closed_by: shipped.record_id, valid_from: "2026-09-08T09:05:00Z", valid_to: "2026-09-09T11:10:00Z", provenance: sofiaProv }, "sofia:commitment:10042:closed");
    assert.equal(closed.outcome, "updated");
    assert.equal(closed.record_id, commitment.record_id);
    const after = read(sofia, [org], CUSTOMER);
    assert.deepEqual(after.state_of_record?.in_force, [], "nothing is owed any more");
    assert.deepEqual(after.state_of_record?.done.map((r) => `${r.facet}:${r.id}`).sort(), [`commitments:${commitment.record_id}`, `receipts:${shipped.record_id}`].sort(), "the fulfilled commitment sits in done beside the receipt that closed it");
    assert.equal((after.records?.[commitment.record_id] as { closed_by?: string }).closed_by, shipped.record_id);

    // 6. A new agent reads the whole chain later: the drawer names the decision and the proof, and
    //    `records` resolves the repository decision, grants first.
    const later = read(auditor, [org, repo], CUSTOMER);
    const deps = later.state_of_record?.depends_on ?? [];
    const decRef = deps.find((d) => d.kind === "record" && d.id === decision.record_id);
    assert.ok(decRef && decRef.kind === "record" && decRef.scope?.kind === "repository", "the decision ref carries its partition");
    assert.ok(deps.some((d) => d.kind === "external" && d.ref.object_type === "change_proof" && d.ref.object_key === proof.proof_id), "the change proof is named by id and content hash");
    const resolved = recordsState(store, { schema: "nuryel.state.records/1", principal: auditor, scope: repo, ids: [decision.record_id, shipped.record_id, commitment.record_id] });
    assert.equal(resolved.facets[decision.record_id], "decisions");
    assert.equal(resolved.facets[shipped.record_id], "receipts");
    assert.equal((resolved.records[decision.record_id] as { title: string }).title, "stream the report export instead of buffering it");
    assert.equal(stateHash(resolved.records[decision.record_id]), decRef!.kind === "record" ? decRef!.record_hash : "", "the pointer still verifies");
    // A principal without the repository grant sees the decision id named, never described.
    const blind = recordsState(store, { schema: "nuryel.state.records/1", principal: sofia, scope: org, ids: [decision.record_id] });
    assert.deepEqual(blind.denied, [decision.record_id]);

    // 7. The drawer's ledger tells the story in order, and the closure's cause is the receipt.
    const stream = subscribeState(store, { schema: "nuryel.state.subscribe/1", principal: sofia, scope: org, after_seq: 0 });
    assert.doesNotThrow(() => assertChangeSequence(stream.events, 0));
    assert.deepEqual(stream.events.map((e) => `${e.change}:${e.facet}`), ["created:entities", "created:commitments", "created:receipts", "updated:commitments"]);
    assert.deepEqual(stream.events[2]?.invalidates, [CUSTOMER]);
    assert.deepEqual(stream.events[3]?.cause, { kind: "receipt", receipt_id: shipped.record_id });
  } finally { cleanup(); }
});

test("chain refusals teach: a receipt cannot rest on state that is absent, moved, or outside the grants; a closure needs a receipt that happened", () => {
  const { store, cleanup } = overlayStore();
  try {
    const repo = repositoryScope(store);
    const eng = { id: "claude-code@david", kind: "agent" as const, grants: [org, repo] };
    const orgOnly = { id: "sofia@david", kind: "agent" as const, grants: [org] };
    const w = (principal: typeof eng, scope: typeof org | typeof repo, facet: string, record: Record<string, unknown>, key: string) =>
      writeState(store, { schema: "nuryel.state.write/1", principal, scope, facet, record, idempotency_key: `chain:${key}` });
    const decision = w(eng, repo, "decisions", {
      id: "dec_chain00000001", title: "t", topic: "chain.topic", status: "accepted", context: "", decision: "d", consequences: [], alternatives_rejected: [], rejected_tripwires: [], related_components: [], related_files: [],
      supersedes: null, superseded_by: null, caused_by_bug: null, commit: null, valid_to: null, retired: { symbols: [], deps: [] }, provenance: engProv, date: "2026-09-09T10:00:00Z",
    }, "dec-1");
    const receipt = (restsOn: DependencyRef[], key: string, state = "verified") => ({
      schema: "nuryel.receipt/1", scope: org, actor: eng.id, action_kind: "shipped", target: { system: "github", object_type: "pull_request", object_key: `acme/x#${key}`, observed_at: "2026-09-09T11:00:00Z" },
      request_fingerprint: stateHash({ key }), state, occurred_at: "2026-09-09T11:00:00Z", invalidates: [CUSTOMER], rests_on: restsOn, provenance: engProv,
    });

    // absent in a partition this store holds
    const absent = refusal(() => w(eng, org, "receipts", receipt([{ kind: "record", id: "dec_chain0000none", record_hash: decision.record_hash, scope: repo }], "r-absent"), "r-absent"), "conflict");
    assert.equal(absent.conflict?.reason, "rests_on target absent");
    assert.match(absent.message, /write or re-read it first/);
    // moved: the hash the writer saw is not the record on file
    const moved = refusal(() => w(eng, org, "receipts", receipt([{ kind: "record", id: decision.record_id, record_hash: stateHash({ stale: true }), scope: repo }], "r-moved"), "r-moved"), "conflict");
    assert.equal(moved.conflict?.reason, "rests_on hash mismatch");
    assert.match(moved.message, /re-read it and rest on what is current/);
    // wrong partition claimed for a record the store does hold
    const misplaced = refusal(() => w(eng, org, "receipts", receipt([{ kind: "record", id: decision.record_id, record_hash: decision.record_hash }], "r-misplaced"), "r-misplaced"), "conflict");
    assert.equal(misplaced.conflict?.reason, "rests_on scope mismatch");
    // outside the grants: refused by scope before the record is examined
    const outside = refusal(() => w(orgOnly, org, "receipts", receipt([{ kind: "record", id: decision.record_id, record_hash: decision.record_hash, scope: repo }], "r-outside"), "r-outside"), "outside-grants");
    assert.match(outside.message, /outside the principal's grants/);
    // a partition this store does not hold is a pointer, accepted for the reader to resolve
    const elsewhere = { kind: "repository" as const, id: "another-repo" };
    const pointer = w({ ...eng, grants: [...eng.grants, elsewhere] }, org, "receipts", receipt([{ kind: "record", id: "dec_elsewhere0001", record_hash: stateHash({ x: 1 }), scope: elsewhere }], "r-pointer"), "r-pointer");
    assert.equal(pointer.outcome, "created");
    // the good one, and a failed one
    const ok = w(eng, org, "receipts", receipt([{ kind: "record", id: decision.record_id, record_hash: decision.record_hash, scope: repo }], "r-ok"), "r-ok");
    const failed = w(eng, org, "receipts", receipt([], "r-failed", "failed"), "r-failed");

    const cBase = { scope: org, subject: CUSTOMER, title: "fix it", owner: "engineering", due: "2026-09-12" };
    const close = (over: Record<string, unknown>, key: string) => w(eng, org, "commitments", { schema: "nuryel.commitment/1", ...cBase, status: "done", valid_from: "2026-09-08T09:05:00Z", valid_to: "2026-09-09T11:10:00Z", provenance: engProv, ...over }, key);
    const unknown = refusal(() => close({ closed_by: "nrc_000000000000000000000000" }, "c-unknown"), "conflict");
    assert.equal(unknown.conflict?.reason, "closed_by receipt absent");
    assert.match(unknown.message, /write the receipt first, then close with its id/);
    const notHappened = refusal(() => close({ closed_by: failed.record_id }, "c-failed"), "conflict");
    assert.equal(notHappened.conflict?.reason, "closed_by receipt failed");
    const stillOpen = refusal(() => close({ closed_by: ok.record_id, status: "open", valid_to: null }, "c-open"), "malformed");
    assert.match(stillOpen.message, /a commitment closed by a receipt is done/);
    assert.equal(close({ closed_by: ok.record_id }, "c-ok").outcome, "created");
    assert.equal(store.recs("commitments").length, 1, "nothing refused ever landed");
  } finally { cleanup(); }
});

test("older records are untouched: a receipt without rests_on and a commitment without closed_by hash and read exactly as before", () => {
  const { store, cleanup } = overlayStore();
  try {
    const p = { id: "sofia@david", kind: "agent" as const, grants: [org] };
    const rBase = { scope: org, actor: p.id, action_kind: "events_add_actions", target: crmEvent, request_fingerprint: stateHash({ c: 1 }) };
    const legacy = { schema: "nuryel.receipt/1", ...rBase, state: "verified", occurred_at: "2026-09-08T09:00:00Z", invalidates: [CUSTOMER], provenance: sofiaProv };
    const r = writeState(store, { schema: "nuryel.state.write/1", principal: p, scope: org, facet: "receipts", record: legacy, idempotency_key: "legacy-1" });
    const stored = store.getRec("receipts", r.record_id) as Record<string, unknown>;
    assert.ok(!("rests_on" in stored), "no field is materialized on a record that never carried it");
    assert.equal(stateHash(stored), r.record_hash);
    const { response } = readState(store, { schema: "nuryel.state.read/1", principal: p, scope: org, subject: CUSTOMER });
    assert.deepEqual(response.state_of_record?.depends_on, []);
    assert.deepEqual(response.state_of_record?.done.map((x) => x.id), [r.record_id]);
  } finally { cleanup(); }
});

test("the changed facet, written: a current summary written back as stale with an external cause is an INVALIDATION naming the pointer", () => {
  const { store, cleanup } = overlayStore();
  try {
    const p = { id: "sofia@david", kind: "agent" as const, grants: [org] };
    const w = (record: Record<string, unknown>, key: string, extra: Record<string, unknown> = {}) =>
      writeState(store, { schema: "nuryel.state.write/1", principal: p, scope: org, facet: "derived", record, idempotency_key: key, ...extra });
    const dep = { kind: "external" as const, ref: { ...crmEvent, content_hash: stateHash("v3") } };
    const content = "Site:7: export failing";
    const base = { schema: "nuryel.derived/1", scope: org, subject: CUSTOMER, content, content_hash: stateHash(content), dependencies: [dep], transform_version: "summary/v1", computed_at: "2026-09-09T09:00:00Z", provenance: sofiaProv };
    const current = w({ ...base, valid_to: null, state: "current" }, "sofia:summary:1");
    assert.equal(current.outcome, "created");
    // The source moved: the writer re-stamped the CRM event and the hash it rests on is gone.
    const moved = { ...crmEvent, version: "4", content_hash: stateHash("v4"), observed_at: "2026-09-09T12:00:00Z" };
    const stale = w({ ...base, valid_to: "2026-09-09T12:00:00Z", state: "stale" }, "sofia:summary:1:stale", { cause: { kind: "external", ref: moved } });
    assert.equal(stale.outcome, "updated");
    assert.equal(stale.record_id, current.record_id, "same identity: the dependencies did not change, their truth did");
    const { response } = readState(store, { schema: "nuryel.state.read/1", principal: p, scope: org, subject: CUSTOMER });
    assert.deepEqual(response.state_of_record?.current, [], "no longer current for any reader");
    const stream = subscribeState(store, { schema: "nuryel.state.subscribe/1", principal: p, scope: org, after_seq: 0 });
    assert.deepEqual(stream.events.map((e) => e.change), ["created", "invalidated"]);
    assert.deepEqual(stream.events[1]?.cause, { kind: "external", ref: moved }, "the ledger names what moved");
    assert.deepEqual(stream.events[1]?.invalidates, [CUSTOMER]);
    // Written back stale WITHOUT a cause is still an invalidation, caused by the writer.
    const again = w({ ...base, content: "x", content_hash: stateHash("x"), valid_to: null, state: "current", dependencies: [{ kind: "external", ref: moved }] }, "sofia:summary:2");
    const staleAgain = w({ ...base, content: "x", content_hash: stateHash("x"), valid_to: "2026-09-09T13:00:00Z", state: "stale", dependencies: [{ kind: "external", ref: moved }] }, "sofia:summary:2:stale");
    assert.equal(staleAgain.record_id, again.record_id);
    const last = subscribeState(store, { schema: "nuryel.state.subscribe/1", principal: p, scope: org, after_seq: 0 }).events.at(-1);
    assert.equal(last?.change, "invalidated");
    assert.deepEqual(last?.cause, { kind: "write", principal: "sofia@david" });
  } finally { cleanup(); }
});
