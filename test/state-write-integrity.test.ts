import { cleanupDir } from "./fixtures.js";
/**
 * Write integrity of nuryel.state/1 (#282, #283, #284): a record and its change event land
 * together, a retry repairs an event the ledger never got, and an exact retry of a write that
 * succeeded replays before any check that depends on state changed since.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempStore } from "./helpers.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { StateRefusal, partitionOf, readState, stateHomeFor, subscribeState, writeState } from "../src/store/stateBinding.js";
import { WriteLockTimeout, withWriteLock, writeLockPath } from "../src/serve/writelock.js";
import { compactPartition } from "../src/cli/serve.js";
import { compactLedger, emptyLedger, readLedger, writeLedger } from "../src/store/changeLedger.js";
import { formatReplayReport, verifyReplay } from "../src/store/replay.js";
import { actionReceiptId, commitmentId, entityId, stateHash } from "../src/core/stateContract.js";

const prov = { source: "imported:sofia", confidence: 0.9, evidence: ["sofia outbox row 1"] };

function principal(store: HunchStore) {
  return { id: "sofia-1", kind: "agent" as const, grants: [partitionOf(store)] };
}
function write(store: HunchStore, facet: string, record: Record<string, unknown>, key: string) {
  return writeState(store, { schema: "nuryel.state.write/1", principal: principal(store), scope: partitionOf(store), facet, record, idempotency_key: key });
}
function events(store: HunchStore) {
  return subscribeState(store, { schema: "nuryel.state.subscribe/1", principal: principal(store), scope: partitionOf(store), after_seq: 0 }).events;
}
function receipt(store: HunchStore, objectKey: string) {
  const target = { system: "crm", object_type: "event", object_key: objectKey, observed_at: "2026-09-09T08:00:00Z" };
  const base = { scope: partitionOf(store), actor: "sofia-1", action_kind: "add_comment", target, request_fingerprint: stateHash("x") };
  return { schema: "nuryel.receipt/1", id: actionReceiptId(base), ...base, state: "verified", occurred_at: "2026-09-07T08:55:22Z", provenance: prov, invalidates: [] };
}
function commitment(store: HunchStore, subject: string, over: Record<string, unknown> = {}) {
  const base = { scope: partitionOf(store), subject, title: "send results", owner: "sofia", due: "2026-09-11" };
  return { schema: "nuryel.commitment/1", id: commitmentId(base), ...base, status: "open", valid_from: "2026-09-09T08:00:00Z", valid_to: null, provenance: prov, ...over };
}

test("#283: a receipt whose subject exceeds the event limit lands WITH its event (subject omitted), never a record without one", () => {
  const { store, cleanup } = tempStore();
  try {
    const rec = receipt(store, "k".repeat(510)); // event:kkk… is 516 chars, over the 512 event bound
    const first = write(store, "receipts", rec, "receipt-long-0001");
    assert.equal(first.outcome, "created");
    const evs = events(store);
    assert.equal(evs.length, 1);
    assert.equal(evs[0]!.record_id, rec.id);
    assert.equal(evs[0]!.change, "created");
    assert.equal(evs[0]!.subject, undefined, "an over-long subject is omitted from the event, the record keeps it");
    assert.equal(evs[0]!.record_hash, first.record_hash);
    assert.equal(write(store, "receipts", rec, "receipt-long-0001").outcome, "replayed");
    assert.equal(events(store).length, 1);
    const report = verifyReplay(store, partitionOf(store));
    assert.equal(report.ok, true, formatReplayReport(report));
    assert.equal(report.records.verified, 1);

    // A subject that fits keeps its subject on the event.
    write(store, "receipts", receipt(store, "42"), "receipt-short-0001");
    assert.equal(events(store).at(-1)!.subject, "event:42");
  } finally { cleanup(); }
});

test("#282: a record on file the ledger never saw gets its event on the retry; replay does not hide it behind idempotency", () => {
  const { store, cleanup } = tempStore();
  try {
    const scope = partitionOf(store);
    const rec = commitment(store, "site:7");
    // The state a refusal-after-put or a crash between put and append left: record, no event, no key.
    store.putCapture("commitments", rec as never, false);
    const before = verifyReplay(store, scope);
    assert.equal(before.ok, false);
    assert.deepEqual(before.divergences.map((d) => d.kind), ["orphan-record"]);

    const retry = write(store, "commitments", rec, "outbox-commit-0001");
    assert.equal(retry.outcome, "replayed");
    const evs = events(store);
    assert.equal(evs.length, 1, "the missing event is appended");
    assert.equal(evs[0]!.record_id, rec.id);
    assert.equal(evs[0]!.change, "created");
    assert.equal(evs[0]!.record_hash, stateHash(store.getRec("commitments", rec.id)!));
    const after = verifyReplay(store, scope);
    assert.equal(after.ok, true, formatReplayReport(after));
    assert.equal(after.records.verified, 1, "verified by an event, hash for hash");
    assert.equal(after.records.verified_by_idempotency, 0, "not hidden behind the idempotency table");

    // Once the ledger knows the record, identical content under another key adds no event.
    assert.equal(write(store, "commitments", rec, "outbox-commit-0002").outcome, "replayed");
    assert.equal(events(store).length, 1);
  } finally { cleanup(); }
});

test("#282: a record the ledger knows only through its idempotency table (events compacted) gets no second event", () => {
  const { store, cleanup } = tempStore();
  try {
    const scope = partitionOf(store);
    const rec = commitment(store, "site:8");
    write(store, "commitments", rec, "outbox-commit-0001");
    write(store, "receipts", receipt(store, "1"), "receipt-0001");
    compactLedger(hunchPaths(store.publicRoot).hunch, scope, { keep: 0 });
    const head = readLedger(hunchPaths(store.publicRoot).hunch, scope).head_seq;
    assert.equal(write(store, "commitments", rec, "outbox-commit-0009").outcome, "replayed");
    assert.equal(readLedger(hunchPaths(store.publicRoot).hunch, scope).head_seq, head, "no new event for a known record");
    assert.equal(verifyReplay(store, scope).ok, true);
  } finally { cleanup(); }
});

test("#282: a record whose event AND key were lost is repaired by a retry under the original key", () => {
  const { store, cleanup } = tempStore();
  try {
    const scope = partitionOf(store);
    const hunchDir = hunchPaths(store.publicRoot).hunch;
    const rec = commitment(store, "site:9");
    write(store, "commitments", rec, "outbox-commit-0001");
    writeLedger(hunchDir, emptyLedger(scope)); // simulate the pre-fix refusal: saved, never appended
    assert.equal(write(store, "commitments", rec, "outbox-commit-0001").outcome, "replayed");
    const ledger = readLedger(hunchDir, scope);
    assert.equal(ledger.events.length, 1);
    assert.equal(ledger.idempotency["outbox-commit-0001"]!.seq, 1);
    const report = verifyReplay(store, scope);
    assert.equal(report.ok, true, formatReplayReport(report));
  } finally { cleanup(); }
});

test("#284: an identical retry replays even after an entity claimed the subject; no duplicate in-force commitment; a different payload under the key is still refused", () => {
  const { store, cleanup } = tempStore();
  try {
    const scope = partitionOf(store);
    const rec = commitment(store, "site:7");
    assert.equal(write(store, "commitments", rec, "outbox-commit-0001").outcome, "created");
    const clinic = entityId("customer", "clinic-7");
    write(store, "entities", { schema: "nuryel.entity/1", id: clinic, kind: "customer", name: "Clinic", scope, refs: [{ system: "crm", object_type: "site", object_key: "7", observed_at: "2026-09-09T08:00:00Z" }], attributes: {}, lifecycle: "active", provenance: prov, created_at: "2026-09-09T08:00:00Z", updated_at: "2026-09-09T08:00:00Z" }, "entity-0001");

    // A NEW write on the entity's external key is refused with the entity named (identity rule holds).
    assert.throws(() => write(store, "commitments", commitment(store, "site:7", { title: "call back" }), "outbox-commit-0002"), (e: unknown) => e instanceof StateRefusal && e.code === "identity");

    // The outbox never saw the first response and re-sends the identical request.
    const retry = write(store, "commitments", rec, "outbox-commit-0001");
    assert.equal(retry.outcome, "replayed");
    assert.equal(retry.record_id, rec.id);

    const inForce = readState(store, { schema: "nuryel.state.read/1", principal: principal(store), scope, subject: clinic }).response.state_of_record?.in_force ?? [];
    const commitments = store.recsInHome("commitments", "public").filter((c) => (c as { valid_to: string | null }).valid_to === null);
    assert.equal(commitments.length, 1, "exactly one open commitment on file");
    assert.ok(inForce.filter((r) => r.id.startsWith("ncm_")).length <= 1, "no duplicate in-force commitment");

    // A different payload under the same key still goes through every check and is refused.
    assert.throws(() => write(store, "commitments", { ...rec, status: "waiting" }, "outbox-commit-0001"), (e: unknown) => e instanceof StateRefusal && (e.code === "idempotency" || e.code === "identity"));
    assert.equal(verifyReplay(store, scope).ok, true);
  } finally { cleanup(); }
});

test("#286: `serve compact` takes the partition write lock — a live writer's ledger is never clipped under it", async () => {
  const { store, root, cleanup } = tempStore();
  try {
    const scope = partitionOf(store);
    const hunchDir = hunchPaths(store.publicRoot).hunch;
    for (let i = 0; i < 3; i++) write(store, "commitments", commitment(store, `site:lock-${i}`), `lock-commit-000${i}`);
    assert.equal(readLedger(hunchDir, scope).events.length, 3);

    // A concurrent writer holds the lock; compaction must not rewrite the ledger under it.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let clippedWhileHeld: number | null = null;
    const holder = withWriteLock(hunchDir, async () => {
      await assert.rejects(
        compactPartition(root, scope, 0, { timeoutMs: 50 }),
        (e: unknown) => e instanceof WriteLockTimeout,
        "compaction must wait for the lock, not clip the ledger under a live writer",
      );
      clippedWhileHeld = readLedger(hunchDir, scope).events.length;
      await held;
    });
    release();
    await holder;
    assert.equal(clippedWhileHeld, 3, "the ledger was untouched while another writer held the lock");

    // Once the lock is free the same call succeeds and the lock is released again.
    const result = await compactPartition(root, scope, 0);
    assert.equal(result.dropped, 3);
    assert.equal(readLedger(hunchDir, scope).events.length, 0);
    assert.ok(!existsSync(writeLockPath(hunchDir)), "compaction releases the lock");
  } finally { cleanup(); }
});

test("#286: `serve compact` compacts the store's RESOLVED state home — the overlay in shared mode, not <root>/.hunch", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-compact-shared-"));
  const overlay = join(mkdtempSync(join(tmpdir(), "hunch-compact-overlay-")), ".hunch");
  try {
    mkdirSync(join(root, ".hunch"), { recursive: true });
    mkdirSync(overlay, { recursive: true });
    writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ privateDir: overlay, mode: "shared", autoCommit: false }) + "\n");
    const store = new HunchStore(hunchPaths(root));
    let scope;
    try {
      scope = partitionOf(store);
      assert.equal(stateHomeFor(store, scope).hunchDir, overlay, "shared mode homes this partition in the overlay");
      for (let i = 0; i < 2; i++) write(store, "commitments", commitment(store, `site:shared-${i}`), `shared-commit-000${i}`);
      assert.equal(readLedger(overlay, scope).events.length, 2, "the writes landed in the overlay ledger");
    } finally { store.close(); }

    const result = await compactPartition(root, scope, 0);
    assert.equal(result.dropped, 2, "compaction found the overlay ledger, not an empty <root>/.hunch one");
    assert.equal(readLedger(overlay, scope).events.length, 0);
  } finally {
    cleanupDir(root);
    cleanupDir(join(overlay, ".."));
  }
});
