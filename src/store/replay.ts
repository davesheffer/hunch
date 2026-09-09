/**
 * Replay determinism — nuryel.replay/1.
 *
 * The property: a partition's current state is a pure function of its change ledger. The
 * git-tracked JSON records stay the source of truth (the ledger proves them, it never replaces
 * them); this module FOLDS the ledger into the state it implies — for every record the ledger
 * names, the hash of the record on file after its last event — and compares that, hash for hash,
 * to the records actually stored. `stateHash` is sha256 over the canonical form, so equal hashes
 * are byte-equal canonical records: "same ledger, same state" is a check, not a claim.
 *
 * What counts as a divergence:
 *   missing-record   the ledger says the record exists, no file holds it
 *   hash-drift       the record on file is not the record the ledger's last event wrote
 *   orphan-record    a state record in the partition that the ledger never saw (a write that
 *                    bypassed the contract, or a crash between "record written" and "event
 *                    appended" — the failure changeLedger promised the next writer could detect)
 *   idempotency-drift an idempotency entry whose hash disagrees with the ledger at its seq
 * Legacy facets (decisions, constraints, bugs, findings) are also written by paths older than the
 * contract (captures, supersede, adopt-drafts), so their drift is reported as `legacy-drift` —
 * visible, never a failure — and their orphans are not sought.
 *
 * Compaction keeps replay equivalence: events below the floor are gone, but the idempotency table
 * is kept whole, so a record whose last event was compacted is still verified against its newest
 * idempotency entry; a record with neither is `unverifiable`, counted, never a failure.
 */
import { ENTITY_KINDS, type EntityKind } from "../core/types.js";
import { ScopeSchema, scopePath, stateHash, type Scope, type StateFacet, type ChangeEvent } from "../core/stateContract.js";
import { readLedger, type Ledger } from "./changeLedger.js";
import type { HunchStore } from "./hunchStore.js";
import { partitionOf, stateHomeFor } from "./stateBinding.js";

export const REPLAY_SCHEMA_VERSION = "nuryel.replay/1" as const;

/** The facets the contract is the ONLY writer of; a record here without a ledger event is an orphan. */
export const STATE_ONLY_FACETS = ["receipts", "commitments", "derived", "entities", "relationships"] as const satisfies readonly StateFacet[];
const LEGACY_FACETS = new Set<StateFacet>(["decisions", "constraints", "bugs", "findings"]);

export type ReplayDivergenceKind = "missing-record" | "hash-drift" | "orphan-record" | "idempotency-drift" | "legacy-drift";

export interface ReplayDivergence {
  kind: ReplayDivergenceKind;
  facet: StateFacet;
  record_id: string;
  /** The seq of the ledger event the record was checked against (0 when none). */
  seq: number;
  expected_hash: string | null;
  actual_hash: string | null;
  detail: string;
}

/** One line per record the fold produced: the state the ledger implies. Sorted by id, so the
 *  snapshot hash is order-independent and two clones of one ledger agree on it. */
export interface ReplaySnapshotEntry {
  facet: StateFacet;
  record_id: string;
  record_hash: string;
  /** The last change the ledger recorded for it. */
  change: ChangeEvent["change"];
  seq: number;
}

export interface ReplayReport {
  schema: typeof REPLAY_SCHEMA_VERSION;
  scope: Scope;
  ledger: { head_seq: number; floor_seq: number; events: number; idempotency_entries: number };
  /** Hash of the state the ledger implies (the fold) and of the records on file for the same ids —
   *  over the facets the contract owns (legacy facets are advisory and excluded). */
  replay_hash: string;
  stored_hash: string;
  records: { named_by_ledger: number; verified: number; verified_by_idempotency: number; unverifiable: number; legacy_checked: number };
  divergences: ReplayDivergence[];
  /** True when the ledger and the files agree on every record the check can decide. */
  ok: boolean;
}

/** Fold a ledger into the state it implies: the last event per record, in seq order. */
export function foldLedger(ledger: Ledger): Map<string, ReplaySnapshotEntry> {
  const out = new Map<string, ReplaySnapshotEntry>();
  for (const e of ledger.events) {
    out.set(e.record_id, { facet: e.facet, record_id: e.record_id, record_hash: e.record_hash, change: e.change, seq: e.seq });
  }
  return out;
}

const snapshotHash = (entries: readonly { facet: string; record_id: string; record_hash: string | null }[]): string =>
  stateHash([...entries].sort((a, b) => (a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0)).map((e) => [e.facet, e.record_id, e.record_hash]));

const recordScope = (record: unknown, own: Scope): Scope => {
  const parsed = ScopeSchema.safeParse((record as { scope?: unknown }).scope);
  return parsed.success ? parsed.data : own;
};

const windowClosed = (facet: StateFacet, record: Record<string, unknown>): boolean =>
  (facet === "derived" && record.state !== "current") || ("valid_to" in record && record.valid_to !== null) || record.lifecycle === "retired";

/** Verify that a partition's stored records are exactly what its ledger implies. Read-only. */
export function verifyReplay(store: HunchStore, scope: Scope): ReplayReport {
  const own = partitionOf(store);
  const { home, hunchDir } = stateHomeFor(store, scope);
  const ledger = readLedger(hunchDir, scope);
  const fold = foldLedger(ledger);
  const divergences: ReplayDivergence[] = [];
  const stored: ReplaySnapshotEntry[] = [];
  let verified = 0;
  let verifiedByIdempotency = 0;
  let unverifiable = 0;
  let legacyChecked = 0;

  const onFile = (facet: StateFacet, id: string): Record<string, unknown> | undefined =>
    (ENTITY_KINDS as readonly string[]).includes(facet)
      ? (store.recsInHome(facet as EntityKind, home) as Record<string, unknown>[]).find((r) => r.id === id)
      : undefined;

  // 1. Every record the ledger names must be on file with the hash its last event wrote.
  for (const entry of fold.values()) {
    const record = onFile(entry.facet, entry.record_id);
    const legacy = LEGACY_FACETS.has(entry.facet);
    if (legacy) legacyChecked++;
    if (!record) {
      stored.push({ ...entry, record_hash: "" });
      divergences.push({ kind: legacy ? "legacy-drift" : "missing-record", facet: entry.facet, record_id: entry.record_id, seq: entry.seq, expected_hash: entry.record_hash, actual_hash: null, detail: `ledger seq ${entry.seq} ${entry.change} ${entry.record_id}; no ${entry.facet} record on file in ${scopePath(scope)}` });
      continue;
    }
    const actual = stateHash(record);
    stored.push({ ...entry, record_hash: actual });
    if (actual === entry.record_hash) { verified++; continue; }
    divergences.push({ kind: legacy ? "legacy-drift" : "hash-drift", facet: entry.facet, record_id: entry.record_id, seq: entry.seq, expected_hash: entry.record_hash, actual_hash: actual, detail: `${entry.record_id} on file hashes ${actual}; the ledger's last event (seq ${entry.seq}, ${entry.change}) wrote ${entry.record_hash}` });
  }

  // 2. The idempotency table agrees with the ledger at each entry's seq (what a replay returns
  //    is what the ledger said was on file then). Entries below the floor are checked against
  //    the file directly when they are the record's newest entry — that is how a compacted
  //    record stays verifiable.
  const newestEntryFor = new Map<string, { record_hash: string; facet: string; seq: number }>();
  for (const entry of Object.values(ledger.idempotency)) {
    const prev = newestEntryFor.get(entry.record_id);
    if (!prev || entry.seq > prev.seq) newestEntryFor.set(entry.record_id, entry);
    const eventsUpTo = ledger.events.filter((e) => e.record_id === entry.record_id && e.seq <= entry.seq);
    const at = eventsUpTo[eventsUpTo.length - 1];
    if (at && at.record_hash !== entry.record_hash && (entry.payload_hash === undefined || at.record_hash !== entry.payload_hash)) {
      divergences.push({ kind: "idempotency-drift", facet: entry.facet as StateFacet, record_id: entry.record_id, seq: entry.seq, expected_hash: at.record_hash, actual_hash: entry.record_hash, detail: `idempotency entry at seq ${entry.seq} holds ${entry.record_hash}; the ledger event at seq ${at.seq} wrote ${at.record_hash}` });
    }
  }

  // 3. Every state record in the partition must be one the ledger saw — or, after compaction,
  //    one the idempotency table still names with the hash on file.
  for (const facet of STATE_ONLY_FACETS) {
    for (const record of store.recsInHome(facet as EntityKind, home) as Record<string, unknown>[]) {
      if (scopePath(recordScope(record, own)) !== scopePath(scope)) continue;
      const id = String(record.id);
      if (fold.has(id)) continue;
      const actual = stateHash(record);
      const entry = newestEntryFor.get(id);
      if (entry) {
        stored.push({ facet, record_id: id, record_hash: actual, change: "updated", seq: entry.seq });
        if (entry.record_hash === actual) { verifiedByIdempotency++; continue; }
        // The one change the contract makes WITHOUT an idempotency entry is closing a window on
        // supersession (the `superseded` event carries the closed hash). With that event compacted
        // away, a closed record is unverifiable; an OPEN record that differs is drift.
        if (entry.seq <= ledger.floor_seq && windowClosed(facet, record)) { unverifiable++; continue; }
        divergences.push({ kind: "hash-drift", facet, record_id: id, seq: entry.seq, expected_hash: entry.record_hash, actual_hash: actual, detail: `${id} on file hashes ${actual}; its newest idempotency entry (seq ${entry.seq}) holds ${entry.record_hash} and no event above the floor explains the change` });
        continue;
      }
      divergences.push({ kind: "orphan-record", facet, record_id: id, seq: 0, expected_hash: null, actual_hash: actual, detail: `${facet} record ${id} is on file in ${scopePath(scope)} but the ledger never saw it (no event, no idempotency entry)` });
    }
  }

  // The two fingerprints cover the facets the contract owns; legacy facets are advisory.
  const replayHash = snapshotHash([...fold.values()].filter((e) => !LEGACY_FACETS.has(e.facet)));
  const storedHash = snapshotHash(stored.filter((s) => fold.has(s.record_id) && !LEGACY_FACETS.has(s.facet)));
  const failing = divergences.some((d) => d.kind !== "legacy-drift");
  return {
    schema: REPLAY_SCHEMA_VERSION,
    scope,
    ledger: { head_seq: ledger.head_seq, floor_seq: ledger.floor_seq, events: ledger.events.length, idempotency_entries: Object.keys(ledger.idempotency).length },
    replay_hash: replayHash,
    stored_hash: storedHash,
    records: { named_by_ledger: fold.size, verified, verified_by_idempotency: verifiedByIdempotency, unverifiable, legacy_checked: legacyChecked },
    divergences,
    ok: !failing && replayHash === storedHash,
  };
}

export function formatReplayReport(r: ReplayReport): string {
  const lines = [
    `${scopePath(r.scope)}: ${r.ok ? "replay OK" : "REPLAY DIVERGED"} — ledger head ${r.ledger.head_seq}, floor ${r.ledger.floor_seq}, ${r.ledger.events} event(s), ${r.ledger.idempotency_entries} idempotency entr${r.ledger.idempotency_entries === 1 ? "y" : "ies"}`,
    `  replay ${r.replay_hash}`,
    `  stored ${r.stored_hash}${r.replay_hash === r.stored_hash ? "  (equal)" : "  (DIFFERENT)"}`,
    `  records: ${r.records.named_by_ledger} named by the ledger, ${r.records.verified} verified hash for hash, ${r.records.verified_by_idempotency} verified through the idempotency table, ${r.records.unverifiable} unverifiable below the floor, ${r.records.legacy_checked} legacy`,
  ];
  for (const d of r.divergences) lines.push(`  ${d.kind === "legacy-drift" ? "·" : "✗"} ${d.kind} ${d.facet}/${d.record_id}: ${d.detail}`);
  return lines.join("\n");
}
