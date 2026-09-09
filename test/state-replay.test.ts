/**
 * Replay determinism (nuryel.replay/1): a partition's stored records are exactly what its change
 * ledger implies — verified hash for hash, with every divergence typed. And the invariant a peer's
 * reducer was seen to lose: a human correction is not overwritten by a later agent write.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempStore } from "./helpers.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { StateRefusal, partitionOf, writeState } from "../src/store/stateBinding.js";
import { compactLedger, readLedger } from "../src/store/changeLedger.js";
import { foldLedger, verifyReplay, formatReplayReport } from "../src/store/replay.js";
import { STATE_INVARIANTS, actionReceiptId, commitmentId, derivedId, stateHash } from "../src/core/stateContract.js";

const agentProv = { source: "imported:sofia", confidence: 0.9, evidence: ["sofia approvals row a1"] };
const humanProv = { source: "human_confirmed", confidence: 1, evidence: ["david, in chat"] };
const crmEvent = { system: "crm", object_type: "event", object_key: "26904", version: "3", observed_at: "2026-09-09T08:00:00Z" };
const subject = "customer:Site:7";

function principal(store: HunchStore, kind: "human" | "agent" | "service" = "agent") {
  return { id: kind === "human" ? "david" : kind === "service" ? "orc" : "sofia@david", kind, grants: [partitionOf(store)] };
}
function write(store: HunchStore, facet: string, record: Record<string, unknown>, key: string, over: Record<string, unknown> = {}, who: "human" | "agent" | "service" = "agent") {
  return writeState(store, { schema: "nuryel.state.write/1", principal: principal(store, who), scope: partitionOf(store), facet, record, idempotency_key: `replay-${key}`, ...over });
}
function commitment(store: HunchStore, over: Record<string, unknown> = {}) {
  const base = { scope: partitionOf(store), subject, title: "send the pilot training results", owner: "david", due: "2026-09-11", ...over } as { scope: ReturnType<typeof partitionOf>; subject: string; title: string; owner: string; due: string };
  return { schema: "nuryel.commitment/1", id: commitmentId(base), scope: base.scope, subject: base.subject, title: base.title, owner: base.owner, due: base.due, status: "open", valid_from: "2026-09-09T08:00:00Z", valid_to: null, provenance: agentProv, ...over };
}
function receipt(store: HunchStore, over: Record<string, unknown> = {}) {
  const base = { scope: partitionOf(store), actor: "sofia@david", action_kind: "add_comment", target: crmEvent, request_fingerprint: stateHash({ comment: "results sent" }) };
  return { schema: "nuryel.receipt/1", id: actionReceiptId(base), ...base, state: "verified", occurred_at: "2026-09-09T09:00:00Z", provenance: agentProv, invalidates: [subject], ...over };
}
function derived(store: HunchStore, content: string, over: Record<string, unknown> = {}) {
  const base = { scope: partitionOf(store), subject, transform_version: "summary/1", dependencies: [{ kind: "external", ref: crmEvent }] };
  return { schema: "nuryel.derived/1", id: derivedId(base as never), ...base, content, content_hash: stateHash(content), computed_at: "2026-09-09T08:30:00Z", valid_to: null, state: "current", provenance: agentProv, ...over };
}
function refusal(fn: () => unknown, code: StateRefusal["code"]): StateRefusal {
  try { fn(); } catch (e) {
    assert.ok(e instanceof StateRefusal, `expected a StateRefusal, got ${(e as Error).message}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected a ${code} refusal`);
}

test("replay: after create / update / supersede / close through the contract, the ledger implies exactly the records on file", () => {
  const { store, cleanup } = tempStore();
  try {
    const scope = partitionOf(store);
    write(store, "commitments", commitment(store), "c1");
    write(store, "commitments", commitment(store, { status: "waiting" }), "c2");
    const d1 = write(store, "derived", derived(store, "first summary"), "d1");
    const newer = { ...crmEvent, version: "4" };
    const d2 = write(store, "derived", { ...derived(store, "second summary", { dependencies: [{ kind: "external", ref: newer }] }), id: undefined }, "d2", { supersedes: d1.record_id });
    assert.equal(d2.outcome, "superseded");
    const r = write(store, "receipts", receipt(store), "r1");
    write(store, "commitments", commitment(store, { status: "done", closed_by: r.record_id }), "c3");
    const report = verifyReplay(store, scope);
    assert.equal(report.ok, true, formatReplayReport(report));
    assert.equal(report.replay_hash, report.stored_hash);
    assert.deepEqual(report.divergences, []);
    assert.equal(report.records.named_by_ledger, 4, "commitment, two derived, receipt");
    assert.equal(report.records.verified, 4);
    assert.equal(report.ledger.events, 7, "created, updated, created, superseded+created, created, updated");
    // The fold is a pure function of the ledger: the same ledger text folds to the same snapshot.
    const ledger = readLedger(hunchPaths(store.publicRoot).hunch, scope);
    const again = foldLedger(JSON.parse(JSON.stringify(ledger)));
    assert.deepEqual([...again.values()], [...foldLedger(ledger).values()]);
    assert.match(formatReplayReport(report), /replay OK/);
  } finally { cleanup(); }
});

test("replay: a record edited behind the ledger is hash-drift, one deleted is missing, one written past the contract is an orphan — each named, and the check fails", () => {
  const { store, cleanup } = tempStore();
  try {
    const scope = partitionOf(store);
    const c = write(store, "commitments", commitment(store), "c1");
    const r = write(store, "receipts", receipt(store), "r1");
    const hunch = hunchPaths(store.publicRoot).hunch;
    // 1. Edit the commitment file directly (what a hand edit or a non-contract writer does).
    const file = join(hunch, "commitments", `${c.record_id}.json`);
    const edited = { ...JSON.parse(readFileSync(file, "utf8")), due: "2026-09-30" };
    writeFileSync(file, JSON.stringify(edited, null, 2) + "\n");
    // 2. Delete the receipt file.
    unlinkSync(join(hunch, "receipts", `${r.record_id}.json`));
    // 3. Put a derived record through the store, bypassing the ledger (a crash between put and append).
    store.putCapture("derived", derived(store, "never ledgered") as never);
    store.reindex();
    const fresh = new HunchStore(hunchPaths(store.publicRoot));
    try {
      const report = verifyReplay(fresh, scope);
      assert.equal(report.ok, false);
      assert.deepEqual(report.divergences.map((d) => d.kind).sort(), ["hash-drift", "missing-record", "orphan-record"]);
      const drift = report.divergences.find((d) => d.kind === "hash-drift")!;
      assert.equal(drift.record_id, c.record_id);
      assert.equal(drift.expected_hash, c.record_hash);
      assert.equal(drift.actual_hash, stateHash(edited));
      assert.equal(report.divergences.find((d) => d.kind === "missing-record")!.record_id, r.record_id);
      assert.notEqual(report.replay_hash, report.stored_hash);
      assert.match(formatReplayReport(report), /REPLAY DIVERGED/);
    } finally { fresh.close(); }
  } finally { cleanup(); }
});

test("replay: compaction keeps the property — a record whose events fell below the floor is verified through the idempotency table", () => {
  const { store, cleanup } = tempStore();
  try {
    const scope = partitionOf(store);
    const hunch = hunchPaths(store.publicRoot).hunch;
    for (let i = 0; i < 4; i++) write(store, "commitments", commitment(store, { title: `t${i}` }), `c${i}`);
    assert.equal(verifyReplay(store, scope).ok, true);
    compactLedger(hunch, scope, { keep: 1 });
    const report = verifyReplay(store, scope);
    assert.equal(report.ok, true, formatReplayReport(report));
    assert.equal(report.records.named_by_ledger, 1);
    assert.equal(report.records.verified_by_idempotency, 3);
    // A tamper below the floor is still caught: the newest idempotency entry disagrees with the file.
    const victim = readFileSync(join(hunch, "commitments", `${commitmentId({ scope, subject, title: "t0", owner: "david", due: "2026-09-11" })}.json`), "utf8");
    const file = join(hunch, "commitments", `${(JSON.parse(victim) as { id: string }).id}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(victim), status: "cancelled" }, null, 2) + "\n");
    const fresh = new HunchStore(hunchPaths(store.publicRoot));
    try {
      const after = verifyReplay(fresh, scope);
      assert.equal(after.ok, false);
      assert.equal(after.divergences[0]?.kind, "hash-drift");
      assert.match(after.divergences[0]!.detail, /idempotency entry/);
    } finally { fresh.close(); }
  } finally { cleanup(); }
});

test("replay: a legacy decision moved by a path older than the contract is legacy-drift — reported, never a failure", () => {
  const { store, cleanup } = tempStore();
  try {
    const scope = partitionOf(store);
    const decision = { title: "stream the export", topic: "export.transport", status: "accepted", context: "c", decision: "stream", consequences: [], alternatives_rejected: [], rejected_tripwires: [], related_components: [], related_files: [], supersedes: null, superseded_by: null, caused_by_bug: null, commit: null, valid_to: null, retired: { symbols: [], deps: [] }, provenance: humanProv, date: "2026-09-09T08:00:00Z" };
    const w = write(store, "decisions", decision, "dec1", {}, "human");
    assert.equal(verifyReplay(store, scope).ok, true);
    // `hunch supersede` / adopt-drafts style edit outside the contract.
    const rec = store.getRec("decisions", w.record_id)!;
    store.putCapture("decisions", { ...rec, status: "rejected" });
    const report = verifyReplay(store, scope);
    assert.equal(report.ok, true);
    assert.equal(report.divergences.length, 1);
    assert.equal(report.divergences[0]?.kind, "legacy-drift");
    assert.equal(report.records.legacy_checked, 1);
  } finally { cleanup(); }
});

test("replay: `hunch serve replay --root` prints the report and exits 1 on divergence", () => {
  const { store, root, cleanup } = tempStore();
  try {
    const c = write(store, "commitments", commitment(store), "c1");
    store.close();
    const cli = join(process.cwd(), "src", "cli", "index.ts");
    const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const run = () => {
      try { return { status: 0, out: execFileSync(process.execPath, [tsx, cli, "serve", "replay", "--root", root, "--json"], { encoding: "utf8", env: { ...process.env, HUNCH_SYNTH_PROVIDER: "deterministic" } }) }; }
      catch (e) { const err = e as { status: number; stdout: string }; return { status: err.status, out: err.stdout }; }
    };
    const ok = run();
    assert.equal(ok.status, 0);
    const report = JSON.parse(ok.out.trim().split(/\r?\n/).at(-1)!) as { ok: boolean; replay_hash: string; stored_hash: string };
    assert.equal(report.ok, true);
    assert.equal(report.replay_hash, report.stored_hash);
    const file = join(hunchPaths(root).hunch, "commitments", `${c.record_id}.json`);
    assert.ok(existsSync(file));
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), owner: "someone-else" }, null, 2) + "\n");
    const bad = run();
    assert.equal(bad.status, 1);
    assert.equal((JSON.parse(bad.out.trim().split(/\r?\n/).at(-1)!) as { ok: boolean }).ok, false);
  } finally { cleanup(); }
});

test("human correction outranks later agent writes: an agent may replay, invalidate with a cause, or close with a receipt — never rewrite or supersede what a human confirmed", () => {
  const { store, cleanup } = tempStore();
  try {
    assert.ok(STATE_INVARIANTS.some((i) => i.id === "human-correction-outranks-agent-writes"), "the invariant is exported");
    // The human corrects a commitment the agent recorded: status waiting, human-signed.
    write(store, "commitments", commitment(store), "agent-first");
    const corrected = write(store, "commitments", commitment(store, { status: "waiting", provenance: humanProv }), "human-fix", {}, "human");
    assert.equal(corrected.outcome, "updated");
    assert.equal(store.getRec("commitments", corrected.record_id)?.provenance.source, "human_confirmed");
    // The agent re-sends its own old payload under a NEW key: refused, incumbent named.
    const e = refusal(() => write(store, "commitments", commitment(store), "agent-again"), "conflict");
    assert.equal(e.conflict?.incumbent_id, corrected.record_id);
    assert.equal(e.conflict?.reason, "human-confirmed incumbent");
    assert.match(e.message, /differs in: status\)/);
    assert.equal(store.getRec("commitments", corrected.record_id)?.status, "waiting", "the correction stands");
    // A service principal is not a human either.
    refusal(() => write(store, "commitments", commitment(store, { status: "open" }), "orc-again", {}, "service"), "conflict");
    // The agent re-sends the human's facts (its signature is downgraded on the way in): a replay, nothing rewritten.
    assert.equal(write(store, "commitments", commitment(store, { status: "waiting", provenance: humanProv }), "agent-replay").outcome, "replayed");
    assert.equal(write(store, "commitments", commitment(store, { status: "waiting" }), "agent-replay-2").outcome, "replayed");
    assert.equal(store.getRec("commitments", corrected.record_id)?.provenance.source, "human_confirmed", "the human's signature stays");
    // The agent closes it with a receipt on record: a fact that happened, allowed.
    const r = write(store, "receipts", receipt(store), "r1");
    const closed = write(store, "commitments", commitment(store, { status: "done", closed_by: r.record_id, provenance: humanProv }), "agent-close");
    assert.equal(closed.outcome, "updated");
    assert.equal(store.getRec("commitments", closed.record_id)?.closed_by, r.record_id);
    assert.equal(store.getRec("commitments", closed.record_id)?.provenance.source, "human_confirmed", "a closure keeps the human's provenance");
    refusal(() => write(store, "commitments", commitment(store, { status: "open" }), "agent-reopen"), "conflict");

    // A human-confirmed summary: the agent's new wording is refused, so is superseding it; the
    // agent's remaining duty — write it back stale with the cause that moved — is allowed.
    const summary = write(store, "derived", derived(store, "the human's wording", { provenance: humanProv }), "sum-human", {}, "human");
    refusal(() => write(store, "derived", derived(store, "the agent's wording"), "sum-agent"), "conflict");
    const moved = { ...crmEvent, version: "5", observed_at: "2026-09-09T10:00:00Z" };
    const next = derived(store, "next", { dependencies: [{ kind: "external", ref: moved }] });
    const sup = refusal(() => write(store, "derived", { ...next, id: undefined }, "sup-agent", { supersedes: summary.record_id }), "conflict");
    assert.equal(sup.conflict?.reason, "human-confirmed incumbent");
    const stale = write(store, "derived", derived(store, "the human's wording", { provenance: humanProv, state: "stale", valid_to: "2026-09-09T10:00:00Z" }), "sum-stale", { cause: { kind: "external", ref: moved } });
    assert.equal(store.getRec("derived", stale.record_id)?.state, "stale");
    assert.equal(store.getRec("derived", stale.record_id)?.provenance.source, "human_confirmed");
    const ledger = readLedger(hunchPaths(store.publicRoot).hunch, partitionOf(store));
    assert.equal(ledger.events.at(-1)?.change, "invalidated");
    // A human supersedes a human-confirmed summary freely.
    const second = write(store, "derived", { ...next, id: undefined, provenance: humanProv }, "sum-human-2", {}, "human");
    const third = derived(store, "third", { dependencies: [{ kind: "external", ref: { ...moved, version: "6" } }], provenance: humanProv });
    const byHuman = write(store, "derived", { ...third, id: undefined }, "sup-human", { supersedes: second.record_id }, "human");
    assert.equal(byHuman.outcome, "superseded");
    assert.equal(verifyReplay(store, partitionOf(store)).ok, true, "and the ledger still implies the files");
  } finally { cleanup(); }
});
