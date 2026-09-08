/**
 * nuryel.state/1 bound to the store: read / write / subscribe over a HunchStore, with the
 * contract's invariants enforced by the ONE binding every transport calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { tempStore } from "./helpers.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { StateRefusal, capabilities, readState, repositoryScope, subscribeState, writeState } from "../src/store/stateBinding.js";
import { readLedger } from "../src/store/changeLedger.js";
import { actionReceiptId, assertChangeSequence, commitmentId, derivedId, entityId, stateHash } from "../src/core/stateContract.js";

const prov = { source: "imported:sofia", confidence: 0.9, evidence: ["sofia approvals row a1"] };
const crmEvent = { system: "crm", object_type: "event", object_key: "26879", version: "2", observed_at: "2026-09-07T12:00:00Z" };
const customer = entityId("customer", "קלינור");
const user = { kind: "user" as const, id: "david" };

function principalFor(store: HunchStore, kind: "human" | "agent" = "agent", extra: Array<{ kind: "organization" | "team" | "user" | "repository"; id: string }> = []) {
  return { id: kind === "human" ? "david" : "sofia@david", kind, grants: [repositoryScope(store), ...extra] };
}

function receiptRecord(store: HunchStore, over: Record<string, unknown> = {}) {
  const base = { scope: repositoryScope(store), actor: "sofia@david", action_kind: "add_comment", target: crmEvent, request_fingerprint: stateHash({ eventId: 26879, comment: "ok" }) };
  return { schema: "nuryel.receipt/1", id: actionReceiptId(base), ...base, state: "verified", occurred_at: "2026-09-07T08:55:22Z", provenance: prov, invalidates: [customer], ...over };
}

function write(store: HunchStore, facet: string, record: Record<string, unknown>, key: string, over: Record<string, unknown> = {}, principal = principalFor(store)) {
  return writeState(store, { schema: "nuryel.state.write/1", principal, scope: repositoryScope(store), facet, record, idempotency_key: `idem-${key}`, ...over });
}

function refusal(fn: () => unknown, code: StateRefusal["code"]): StateRefusal {
  try { fn(); } catch (e) {
    assert.ok(e instanceof StateRefusal, `expected a StateRefusal, got ${(e as Error).message}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected a ${code} refusal`);
}

/** A public store with a private overlay in a sibling repository, so organization / team /
 *  user partitions have a home that is NOT the repository. */
function overlayStore(): { root: string; overlay: string; store: HunchStore; cleanup: () => void } {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-state-binding-"));
  const root = join(sandbox, "repository");
  const overlay = join(sandbox, "private-memory", ".hunch");
  mkdirSync(overlay, { recursive: true });
  execFileSync("git", ["init", "-q", join(sandbox, "private-memory")]);
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ privateDir: overlay, autoCommit: false }) + "\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  return { root, overlay, store, cleanup: () => { store.close(); rmSync(sandbox, { recursive: true, force: true }); } };
}

test("capabilities name the repository partition and refuse nothing silently", () => {
  const { store, root, cleanup } = tempStore();
  try {
    const caps = capabilities(store);
    assert.equal(caps.protocol, "nuryel.state/1");
    assert.equal(caps.repository.kind, "repository");
    assert.equal(caps.repository.id, basename(root));
    assert.deepEqual(caps.partitions, ["repository"], "no overlay → only the repository partition has a home");
    assert.ok(caps.capabilities.includes("nuryel.state.write/1"));
  } finally { cleanup(); }
});

test("write: created → replayed on the same key; a reused key with another payload is refused; ids are derived, never chosen", () => {
  const { store, root, cleanup } = tempStore();
  try {
    const first = write(store, "receipts", receiptRecord(store), "sofia-approval-a1");
    assert.equal(first.outcome, "created");
    assert.equal(first.durability, "local", "no flush configured → durability is local, never claimed");
    assert.match(first.record_id, /^nrc_[a-f0-9]{24}$/);
    assert.ok(existsSync(join(root, ".hunch", "receipts", `${first.record_id}.json`)));
    const ledger = readLedger(join(root, ".hunch"), repositoryScope(store));
    assert.equal(ledger.head_seq, 1);
    assert.equal(ledger.events[0]?.change, "created");
    assert.deepEqual(ledger.events[0]?.invalidates, [customer]);
    assert.deepEqual(ledger.events[0]?.cause, { kind: "write", principal: "sofia@david" });
    assert.ok(existsSync(join(root, ".hunch", "changes")), "the ledger is a git-native file beside the records");

    const replay = write(store, "receipts", receiptRecord(store), "sofia-approval-a1");
    assert.equal(replay.outcome, "replayed");
    assert.equal(replay.record_id, first.record_id);
    assert.equal(readLedger(join(root, ".hunch"), repositoryScope(store)).head_seq, 1, "a replay appends nothing");

    const reused = refusal(() => write(store, "receipts", receiptRecord(store, { state: "failed" }), "sofia-approval-a1"), "idempotency");
    assert.equal(reused.conflict?.incumbent_id, first.record_id);

    refusal(() => write(store, "receipts", receiptRecord(store, { id: "nrc_000000000000000000000000" }), "sofia-approval-a2"), "identity");
    refusal(() => write(store, "receipts", { ...receiptRecord(store), provenance: undefined }, "sofia-approval-a3"), "malformed");
    assert.equal(store.json.loadAll("receipts").length, 1, "nothing refused ever landed");
  } finally { cleanup(); }
});

test("write: authorization is the first predicate, and partitions never ride a repository without an overlay", () => {
  const { store, cleanup } = tempStore();
  try {
    const stranger = { id: "someone", kind: "agent" as const, grants: [{ kind: "repository" as const, id: "another-repo" }] };
    refusal(() => write(store, "receipts", receiptRecord(store), "k-outside", {}, stranger), "outside-grants");
    const userScoped = { ...principalFor(store), grants: [user] };
    refusal(() => writeState(store, { schema: "nuryel.state.write/1", principal: userScoped, scope: user, facet: "commitments", record: { provenance: prov }, idempotency_key: "idem-no-home" }), "no-partition-home");
    assert.equal(store.json.loadAll("receipts").length, 0);
  } finally { cleanup(); }
});

test("write: one live decision per topic — refused with the incumbent named, replaced only by explicit supersedes", () => {
  const { store, cleanup } = tempStore();
  try {
    const human = principalFor(store, "human");
    const decision = (id: string, title: string) => ({ id, title, topic: "sofia.summary-policy", status: "accepted", context: "", decision: title, consequences: [], alternatives_rejected: ["x"], rejected_tripwires: [], related_components: [], related_files: [], supersedes: null, superseded_by: null, caused_by_bug: null, commit: null, valid_to: null, retired: { symbols: [], deps: [] }, provenance: { source: "human_confirmed", confidence: 1, evidence: [] }, date: "2026-09-01T00:00:00.000Z" });
    const a = write(store, "decisions", decision("dec_topic0000a", "cite sources"), "dec-a", {}, human);
    assert.equal(a.outcome, "created");
    const clash = refusal(() => write(store, "decisions", decision("dec_topic0000b", "no citations"), "dec-b", {}, human), "conflict");
    assert.equal(clash.conflict?.incumbent_id, "dec_topic0000a");
    assert.equal(clash.conflict?.reason, "one-live-decision-per-topic");
    const b = write(store, "decisions", decision("dec_topic0000b", "no citations"), "dec-b2", { supersedes: "dec_topic0000a" }, human);
    assert.equal(b.outcome, "superseded");
    const old = store.json.get("decisions", "dec_topic0000a")!;
    assert.equal(old.status, "superseded");
    assert.equal(old.superseded_by, "dec_topic0000b");
    const stream = subscribeState(store, { schema: "nuryel.state.subscribe/1", principal: human, scope: repositoryScope(store), after_seq: 0 });
    assert.deepEqual(stream.events.map((e) => `${e.change}:${e.record_id}`), ["created:dec_topic0000a", "superseded:dec_topic0000a", "created:dec_topic0000b"]);
    assert.doesNotThrow(() => assertChangeSequence(stream.events, 0));
  } finally { cleanup(); }
});

test("write: an agent cannot sign as human_confirmed through the contract; a human can", () => {
  const { store, cleanup } = tempStore();
  try {
    const rec = receiptRecord(store, { provenance: { source: "human_confirmed", confidence: 1, evidence: [] } });
    const byAgent = write(store, "receipts", rec, "sign-agent");
    assert.equal(store.json.get("receipts", byAgent.record_id)?.provenance.source, "agent_recorded");
    const other = receiptRecord(store, { provenance: { source: "human_confirmed", confidence: 1, evidence: [] }, request_fingerprint: stateHash("other") });
    const byHuman = write(store, "receipts", { ...other, id: undefined }, "sign-human", {}, principalFor(store, "human"));
    assert.equal(store.json.get("receipts", byHuman.record_id)?.provenance.source, "human_confirmed");
  } finally { cleanup(); }
});

test("write + read: derived state must carry dependencies; superseding it closes the old window and the read shows what current rests on", () => {
  const { store, cleanup } = tempStore();
  try {
    const repo = repositoryScope(store);
    const dBase = { scope: repo, subject: customer, transform_version: "sofia-summary/3", dependencies: [{ kind: "external", ref: crmEvent }] };
    const derived = (content: string, deps = dBase.dependencies) => ({ schema: "nuryel.derived/1", ...dBase, dependencies: deps, content, content_hash: stateHash(content), computed_at: "2026-09-07T12:05:00Z", valid_to: null, state: "current", provenance: prov });
    refusal(() => write(store, "derived", derived("no deps", []), "d-none"), "malformed");
    const v1 = write(store, "derived", derived("סיכום 1"), "d-1");
    assert.equal(v1.outcome, "created");
    const v2Deps = [{ kind: "external", ref: { ...crmEvent, version: "3" } }];
    const v2 = write(store, "derived", derived("סיכום 2", v2Deps), "d-2", { supersedes: v1.record_id });
    assert.equal(v2.outcome, "superseded");
    assert.equal(v2.record_id, derivedId({ ...dBase, dependencies: v2Deps as never }));
    const old = store.json.get("derived", v1.record_id)!;
    assert.equal(old.state, "stale");
    assert.ok(old.valid_to, "the superseded window is closed, not deleted");

    const cBase = { scope: repo, subject: customer, title: "לחזור ללקוח", owner: "david", due: "2026-09-10" };
    write(store, "commitments", { schema: "nuryel.commitment/1", ...cBase, status: "open", valid_from: "2026-09-07T08:00:00Z", valid_to: null, provenance: prov }, "c-1");
    write(store, "receipts", receiptRecord(store), "r-1");

    const { response, envelope } = readState(store, { schema: "nuryel.state.read/1", principal: principalFor(store), scope: repo, subject: customer });
    assert.match(response.receipt_id, /^hdr_[a-f0-9]{24}$/);
    assert.equal(response.receipt_id, envelope.receipt_id, "the read receipt IS the delivery envelope's receipt");
    const sor = response.state_of_record!;
    assert.deepEqual(sor.current.map((r) => r.id), [v2.record_id], "only the current derived state, not the stale one");
    assert.equal(sor.in_force[0]?.id, commitmentId(cBase));
    assert.equal(sor.done[0]?.id, actionReceiptId(receiptRecord(store) as never));
    assert.deepEqual(sor.depends_on, v2Deps);
    assert.deepEqual(sor.invalidated_by, [sor.done[0]!.id]);
    assert.deepEqual(response.denied_scopes, []);
    for (const ref of [...sor.current, ...sor.in_force, ...sor.done]) assert.equal(ref.record_hash, stateHash(store.getRec(ref.facet as never, ref.id)), "refs hash the stored record");
    assert.equal((response.records?.[v2.record_id] as { content?: string })?.content, "סיכום 2", "the read carries the current record itself, not only its ref");
    assert.equal((response.records?.[commitmentId(cBase)] as { title?: string })?.title, "לחזור ללקוח");
    assert.equal(Object.keys(response.records ?? {}).length, 3, "exactly the referenced records travel");
  } finally { cleanup(); }
});

test("read: a matching record in a scope outside the grants is named in denied_scopes, never described", () => {
  const { store, cleanup } = tempStore();
  try {
    const repo = repositoryScope(store);
    write(store, "commitments", { schema: "nuryel.commitment/1", scope: repo, subject: customer, title: "t", owner: "david", due: "2026-09-10", status: "open", valid_from: "2026-09-07T08:00:00Z", valid_to: null, provenance: prov }, "c-denied");
    const userOnly = { id: "sofia@david", kind: "agent" as const, grants: [user] };
    const { response } = readState(store, { schema: "nuryel.state.read/1", principal: userOnly, scope: user, subject: customer });
    assert.deepEqual(response.state_of_record?.in_force, []);
    assert.deepEqual(response.denied_scopes, [repo]);
    refusal(() => readState(store, { schema: "nuryel.state.read/1", principal: userOnly, scope: repo, subject: customer }), "outside-grants");
  } finally { cleanup(); }
});

test("subscribe: contiguous after a cursor; filters mark a subsequence and keep head_seq as the cursor; grants first", () => {
  const { store, cleanup } = tempStore();
  try {
    const repo = repositoryScope(store);
    write(store, "receipts", receiptRecord(store), "s-1");
    write(store, "commitments", { schema: "nuryel.commitment/1", scope: repo, subject: customer, title: "t", owner: "david", due: "2026-09-10", status: "open", valid_from: "2026-09-07T08:00:00Z", valid_to: null, provenance: prov }, "s-2");
    write(store, "receipts", receiptRecord(store, { id: undefined, request_fingerprint: stateHash("second"), invalidates: [] }), "s-3");
    const sub = (over: Record<string, unknown>) => subscribeState(store, { schema: "nuryel.state.subscribe/1", principal: principalFor(store), scope: repo, after_seq: 0, ...over });
    const all = sub({});
    assert.equal(all.head_seq, 3);
    assert.equal(all.filtered, false);
    assert.doesNotThrow(() => assertChangeSequence(all.events, 0));
    const tail = sub({ after_seq: 1 });
    assert.deepEqual(tail.events.map((e) => e.seq), [2, 3]);
    assert.doesNotThrow(() => assertChangeSequence(tail.events, 1));
    const receiptsOnly = sub({ facets: ["receipts"] });
    assert.equal(receiptsOnly.filtered, true);
    assert.deepEqual(receiptsOnly.events.map((e) => e.seq), [1, 3]);
    assert.equal(receiptsOnly.head_seq, 3, "the cursor is the scope's head, not the last filtered event");
    const bySubject = sub({ subjects: [customer] });
    assert.deepEqual(bySubject.events.map((e) => e.seq), [1, 2], "subject filter matches the record id and what an event invalidates");
    refusal(() => sub({ principal: { id: "x", kind: "agent", grants: [user] } }), "outside-grants");
    refusal(() => sub({ principal: { id: "x", kind: "agent", grants: [user] }, scope: user }), "no-partition-home");
  } finally { cleanup(); }
});

test("write: expected_version guards an update — hash or seq — and a matching payload replays instead of rewriting", () => {
  const { store, root, cleanup } = tempStore();
  try {
    const repo = repositoryScope(store);
    const cBase = { scope: repo, subject: customer, title: "t", owner: "david", due: "2026-09-10" };
    const commitment = (status: string) => ({ schema: "nuryel.commitment/1", ...cBase, status, valid_from: "2026-09-07T08:00:00Z", valid_to: null, provenance: prov });
    const first = write(store, "commitments", commitment("open"), "v-1");
    const stale = refusal(() => write(store, "commitments", commitment("waiting"), "v-2", { expected_version: `sha256:${"0".repeat(64)}` }), "conflict");
    assert.equal(stale.conflict?.reason, "expected_version mismatch");
    const byHash = write(store, "commitments", commitment("waiting"), "v-3", { expected_version: first.record_hash });
    assert.equal(byHash.outcome, "updated");
    const bySeq = write(store, "commitments", commitment("done"), "v-4", { expected_version: 2 });
    assert.equal(bySeq.outcome, "updated");
    refusal(() => write(store, "commitments", commitment("open"), "v-5", { expected_version: 2 }), "conflict");
    const same = write(store, "commitments", commitment("done"), "v-6");
    assert.equal(same.outcome, "replayed", "same content under a new key is a replay, not a new event");
    assert.equal(readLedger(join(root, ".hunch"), repo).head_seq, 3);
    assert.equal(readLedger(join(root, ".hunch"), repo).idempotency["idem-v-6"]?.record_id, first.record_id, "the new key is remembered against the incumbent");
  } finally { cleanup(); }
});

test("partitions: a user-scope write lands in the overlay with its own ledger, never in the repository", () => {
  const { root, overlay, store, cleanup } = overlayStore();
  try {
    assert.deepEqual(capabilities(store).partitions, ["organization", "team", "user", "repository"]);
    const p = principalFor(store, "agent", [user]);
    const cBase = { scope: user, subject: customer, title: "לחזור ללקוח", owner: "david", due: "2026-09-10" };
    const r = writeState(store, { schema: "nuryel.state.write/1", principal: p, scope: user, facet: "commitments", record: { schema: "nuryel.commitment/1", ...cBase, status: "open", valid_from: "2026-09-07T08:00:00Z", valid_to: null, provenance: prov }, idempotency_key: "idem-user-commitment-1" });
    assert.equal(r.outcome, "created");
    assert.ok(existsSync(join(overlay, "commitments", `${r.record_id}.json`)), "record is in the overlay");
    assert.ok(!existsSync(join(root, ".hunch", "commitments", `${r.record_id}.json`)), "and not in the repository");
    assert.equal(readdirSync(join(overlay, "changes")).length, 1, "the user ledger lives beside the record");
    assert.ok(!existsSync(join(root, ".hunch", "changes")), "the repository ledger is untouched");
    const { response } = readState(store, { schema: "nuryel.state.read/1", principal: p, scope: user, subject: customer });
    assert.equal(response.state_of_record?.in_force[0]?.id, r.record_id);
    assert.deepEqual(response.state_of_record?.in_force[0]?.scope, user);
    const stream = subscribeState(store, { schema: "nuryel.state.subscribe/1", principal: p, scope: user, after_seq: 0 });
    assert.equal(stream.head_seq, 1);
    assert.equal(subscribeState(store, { schema: "nuryel.state.subscribe/1", principal: p, scope: repositoryScope(store), after_seq: 0 }).head_seq, 0);
  } finally { cleanup(); }
});
